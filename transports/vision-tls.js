'use strict';
const { Duplex } = require('node:stream');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { failure } = require('../runtime/errors');

// TLS remains owned by Node. A public keylog event supplies a short-lived read
// secret so the record gate knows exactly how much plaintext to acknowledge.
// No following record can enter OpenSSL before the consumer processes that data.
// TLS uses HKDF-Expand, whereas hkdfSync also performs Extract.
function labelExpand(secret, label, size) {
  const name = Buffer.from('tls13 ' + label);
  const info = Buffer.concat([
    Buffer.from([size >> 8, size & 255, name.length]),
    name,
    Buffer.from([0, 1]),
  ]);
  return crypto
    .createHmac(secret.length === 48 ? 'sha384' : 'sha256', secret)
    .update(info)
    .digest()
    .subarray(0, size);
}
function clearKeys(state) {
  state?.readSecret?.fill(0);
  for (const item of state?.keys ?? []) {
    item.key.fill(0);
    item.iv.fill(0);
  }
  if (state) {
    state.readSecret = undefined;
    state.keys = undefined;
  }
}
function openRecord(record, state) {
  if (!state.readSecret) return undefined;
  state.keys ??= (
    state.algorithm
      ? [state.algorithm]
      : state.readSecret.length === 48
        ? [['aes-256-gcm', 32]]
        : [
            ['aes-128-gcm', 16],
            ['chacha20-poly1305', 32],
          ]
  ).map(([algorithm, length]) => ({
    algorithm,
    key: labelExpand(state.readSecret, 'key', length),
    iv: labelExpand(state.readSecret, 'iv', 12),
  }));
  for (const item of state.keys) {
    const nonce = Buffer.from(item.iv);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(state.sequence);
    for (let i = 0; i < 8; i++) nonce[i + 4] ^= counter[i];
    let plain;
    try {
      const decipher = crypto.createDecipheriv(item.algorithm, item.key, nonce, {
        authTagLength: 16,
      });
      decipher.setAAD(record.subarray(0, 5));
      decipher.setAuthTag(record.subarray(-16));
      plain = Buffer.concat([decipher.update(record.subarray(5, -16)), decipher.final()]);
    } catch {
      continue;
    }
    for (const other of state.keys)
      if (other !== item) {
        other.key.fill(0);
        other.iv.fill(0);
      }
    state.keys = [item];
    state.algorithm = [item.algorithm, item.key.length];
    state.sequence++;
    return plain;
  }
  return undefined;
}
class RecordGate extends Duplex {
  constructor(raw, { server = false } = {}) {
    super({ allowHalfOpen: true });
    this.raw = raw;
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.pending = 0;
    this.direct = false;
    this.blocked = false;
    this.scheduled = false;
    this.sequence = 0n;
    this.records = 0;
    this.on('error', () => {});
    raw.on('readable', () => this.schedule());
    raw.on('end', () => this.schedule());
    raw.on('error', (error) => this.destroy(error));
    raw.on('close', () =>
      this.destroy(
        !this.direct && this.buffer.length
          ? failure('ERR_TLS', 'Transport closed in a TLS record.', 'tls')
          : undefined,
      ),
    );
  }
  secret(line) {
    const [label, , value] = line.toString('ascii').trim().split(' ');
    const side = this.server ? 'CLIENT' : 'SERVER';
    let target;
    if (label === side + '_TRAFFIC_SECRET_0') target = this;
    else if (label === side + '_HANDSHAKE_TRAFFIC_SECRET')
      target = this.handshake ??= { sequence: 0n };
    else return;
    if (!/^(?:[a-f0-9]{64}|[a-f0-9]{96})$/i.test(value ?? ''))
      throw failure('ERR_TLS', 'Unsupported TLS traffic secret.', 'tls');
    target.readSecret = Buffer.from(value, 'hex');
    target.keys = undefined;
    this.schedule();
  }
  _read() {
    this.schedule();
  }
  _write(chunk, encoding, callback) {
    if (this.writeDirect)
      return callback(
        failure('ERR_TLS', 'Outer TLS attempted to write after Vision Direct.', 'tls'),
      );
    this.raw.write(chunk, callback);
  }
  _final(callback) {
    this.raw.end(callback);
  }
  _destroy(error, callback) {
    clearKeys(this);
    clearKeys(this.handshake);
    this.buffer = Buffer.alloc(0);
    this.raw.destroy();
    callback(error);
  }
  schedule() {
    if (this.scheduled || this.destroyed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      try {
        this.pump();
      } catch (cause) {
        this.destroy(failure('ERR_TLS', 'Vision TLS record gate failed.', 'tls', cause));
      }
    });
  }
  credit(size) {
    this.pending -= size;
    if (this.pending < 0) throw failure('ERR_TLS', 'Unexpected TLS plaintext length.', 'tls');
    this.schedule();
  }
  plaintext(record) {
    if (record[0] !== 23) return 0;
    const plain = openRecord(record, this);
    if (!plain) {
      if (this.started) throw Error('TLS record authentication failed.');
      if (this.handshake && openRecord(record, this.handshake)) return 0;
      if (this.readSecret && this.handshake?.readSecret)
        throw Error('TLS record authentication failed.');
      // Native TLS may deliver keylog asynchronously after processing the prior
      // Finished. Retain this complete record until the required secret arrives.
      return undefined;
    }
    this.started = true;
    clearKeys(this.handshake);
    this.handshake = undefined;
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    const type = plain[end];
    if (type === 22 && plain[0] === 24) {
      if (end !== 5 || plain.readUIntBE(1, 3) !== 1 || plain[4] > 1)
        throw Error('Invalid TLS KeyUpdate.');
      const next = labelExpand(this.readSecret, 'traffic upd', this.readSecret.length);
      clearKeys(this);
      this.readSecret = next;
      this.sequence = 0n;
    }
    if (![21, 22, 23].includes(type)) throw Error('Invalid TLS inner content type.');
    return type === 23 ? end : 0;
  }
  pump() {
    if (this.destroyed || this.pending || this.blocked) return;
    if (this.direct) return this.onDirectReadable?.();
    const need = this.buffer.length < 5 ? 5 : 5 + this.buffer.readUInt16BE(3);
    if (need > 18437) throw Error('TLS record exceeds the TLS 1.3 limit.');
    if (this.buffer.length < need) {
      const chunk = this.raw.read(
        Math.min(need - this.buffer.length, this.raw.readableLength || need - this.buffer.length),
      );
      if (chunk) this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length < need) {
        if (this.raw.readableEnded) {
          if (this.buffer.length) throw Error('Truncated TLS record.');
          this.push(null);
        } else if (chunk) this.schedule();
        return;
      }
    }
    if (this.buffer.length === 5 && need === 5) {
      if (!this.buffer.readUInt16BE(3)) throw Error('Empty TLS record.');
      return this.schedule();
    }
    const record = this.buffer;
    const expected = this.plaintext(record);
    if (expected === undefined) return;
    this.buffer = Buffer.alloc(0);
    this.pending = expected;
    this.records++;
    this.push(record);
    this.schedule();
  }
  switchRead() {
    if (this.pending) throw failure('ERR_TLS', 'TLS switch must consume its record.', 'tls');
    this.direct = true;
    clearKeys(this);
    clearKeys(this.handshake);
    this.schedule();
  }
}

function wrap(raw, tlsConfig, { server = false, maxBufferBytes = 1048576 } = {}) {
  const gate = new RecordGate(raw, { server, maxBufferBytes });
  const secure = server
    ? new tls.TLSSocket(gate, { ...tlsConfig, isServer: true, allowHalfOpen: true })
    : tls.connect({ ...tlsConfig, socket: gate, allowHalfOpen: true });
  secure.on('keylog', (line) => {
    try {
      gate.secret(line);
    } catch (error) {
      gate.destroy(error);
    }
  });
  let directWrite = false;
  let requestedDirect = false;
  let automatic = false;
  const stream = new Duplex({
    allowHalfOpen: true,
    highWaterMark: Math.min(16384, maxBufferBytes),
    read() {
      if (gate.direct || automatic) {
        gate.blocked = false;
        gate.schedule();
      }
    },
    write(chunk, encoding, callback) {
      (directWrite ? raw : secure).write(chunk, callback);
    },
    final(callback) {
      (directWrite ? raw : secure).end(callback);
    },
    destroy(error, callback) {
      secure.destroy();
      gate.destroy();
      raw.destroy();
      callback(error);
    },
  });
  stream.on('error', () => {});
  function deliver(chunk) {
    if (stream.readableLength + chunk.length > maxBufferBytes)
      return stream.destroy(
        failure('ERR_LIMIT', 'Vision receive buffer exceeded its limit.', 'transport'),
      );
    gate.blocked = true;
    const accepted = stream.push(chunk);
    if (gate.direct || automatic) gate.blocked = !accepted;
  }
  secure.on('data', (chunk) => {
    try {
      if (gate.started) gate.credit(chunk.length);
      deliver(chunk);
      if (requestedDirect && !gate.pending && !gate.direct) gate.switchRead();
    } catch (error) {
      stream.destroy(error);
    }
  });
  secure.on('error', (cause) =>
    stream.destroy(failure('ERR_TLS', 'Vision TLS transport failed.', 'tls', cause)),
  );
  gate.on('error', (cause) => stream.destroy(cause));
  // Native TLS may close its custom socket before emitting a certificate error.
  gate.on('close', () => setImmediate(() => stream.destroy(gate.errored)));
  secure.on('end', () => {
    if (!gate.direct) stream.push(null);
  });
  gate.onDirectReadable = () => {
    while (!gate.blocked && raw.readableLength) {
      const chunk = raw.read(Math.min(raw.readableLength, stream.readableHighWaterMark));
      if (chunk) deliver(chunk);
      else break;
    }
    if (raw.readableEnded) stream.push(null);
  };
  stream.switchRead = () => {
    requestedDirect = true;
    if (!gate.pending) gate.switchRead();
  };
  stream.requestRecord = () => {
    if (!stream.readableLength) {
      gate.blocked = false;
      gate.schedule();
    }
  };
  stream.releaseTLS = () => {
    automatic = true;
    gate.blocked = false;
    gate.schedule();
  };
  // Called only after the final padded write callback: all outer ciphertext has
  // passed through the gate to raw TCP before the first direct byte is written.
  stream.switchWrite = () => {
    directWrite = true;
    gate.writeDirect = true;
  };
  stream.getProtocol = () => secure.getProtocol();
  Object.defineProperty(stream, 'transportBufferBytes', {
    get: () =>
      gate.buffer.length +
      secure.readableLength +
      secure.writableLength +
      raw.readableLength +
      raw.writableLength,
  });
  stream.visionState = () => ({
    readDirect: gate.direct,
    writeDirect: directWrite,
    records: gate.records,
  });
  for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    stream[method] = (...args) => {
      raw[method](...args);
      return stream;
    };
  raw.on('timeout', () => stream.emit('timeout'));
  Object.defineProperty(stream, 'remoteAddress', { get: () => raw.remoteAddress });
  secure.once(server ? 'secure' : 'secureConnect', () => stream.emit('secureConnect'));
  return stream;
}
module.exports = { wrap, RecordGate };
