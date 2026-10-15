'use strict';
const { Duplex } = require('node:stream');
const { failure } = require('../../runtime/errors');
const { write } = require('../../runtime/streams');
class RealityStream extends Duplex {
  constructor(raw, { tx, rx }, { maxBufferBytes = 1048576, manual = false } = {}) {
    super({ allowHalfOpen: true, highWaterMark: Math.min(16384, maxBufferBytes) });
    this.raw = raw;
    this.tx = tx;
    this.rx = rx;
    this.limit = maxBufferBytes;
    this.window = Math.min(16384, maxBufferBytes);
    this.manual = manual;
    this.blocked = false;
    this.readDirect = false;
    this.writeDirect = false;
    this.buffer = Buffer.alloc(0);
    this.control = Buffer.alloc(0);
    this.queue = Promise.resolve();
    this.on('error', () => {});
    raw.on('readable', () => this.schedule());
    raw.on('end', () => this.schedule());
    raw.on('error', (cause) =>
      this.destroy(failure('ERR_TRANSPORT', 'REALITY TCP transport failed.', 'transport', cause)),
    );
    raw.on('close', () => {
      if (!this.destroyed && !this.readableEnded && !this.eof)
        this.destroy(failure('ERR_PROTOCOL', 'REALITY transport closed before EOF.', 'reality'));
      // Let Duplex drain authenticated plaintext before autoDestroy closes it.
    });
    raw.on('timeout', () => this.emit('timeout'));
    for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'])
      this[method] = (...args) => {
        raw[method](...args);
        return this;
      };
    Object.defineProperty(this, 'remoteAddress', { get: () => raw.remoteAddress });
    for (const field of ['remotePort', 'localAddress', 'localPort'])
      Object.defineProperty(this, field, { get: () => raw[field] });
    Object.defineProperty(this, 'transportBufferBytes', {
      get: () => this.buffer.length + this.control.length + raw.readableLength + raw.writableLength,
    });
    this.schedule();
  }
  _read() {
    queueMicrotask(() => {
      if (!this.manual || this.readDirect) {
        this.blocked = false;
        this.schedule();
      }
    });
  }
  serial(operation) {
    const pending = this.queue.then(() => {
      if (this.destroyed) throw failure('ERR_CLOSED', 'REALITY stream is closed.', 'reality');
      return operation();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
  _write(data, encoding, callback) {
    if (data.length > this.limit)
      return callback(failure('ERR_LIMIT', 'REALITY write exceeds its buffer limit.', 'reality'));
    this.serial(async () => {
      if (this.writeDirect) return write(this.raw, data);
      for (let offset = 0; offset < data.length; offset += 16384)
        await write(this.raw, this.tx.seal(23, data.subarray(offset, offset + 16384)));
    }).then(() => callback(), callback);
  }
  _final(callback) {
    this.serial(async () => {
      if (!this.writeDirect) await write(this.raw, this.tx.seal(21, Buffer.from([1, 0])));
      await new Promise((resolve, reject) =>
        this.raw.end((error) => (error ? reject(error) : resolve())),
      );
    }).then(() => callback(), callback);
  }
  _destroy(error, callback) {
    this.tx.destroy();
    this.rx.destroy();
    this.buffer = Buffer.alloc(0);
    this.control = Buffer.alloc(0);
    this.raw.destroy();
    callback(error);
  }
  getProtocol() {
    return 'TLSv1.3';
  }
  switchRead() {
    this.readDirect = true;
    this.rx.destroy();
    this.schedule();
  }
  switchWrite() {
    this.writeDirect = true;
    this.tx.destroy();
  }
  requestRecord() {
    if (!this.readableLength) {
      this.blocked = false;
      this.schedule();
    }
  }
  releaseTLS() {
    this.manual = false;
    this.blocked = false;
    this.schedule();
  }
  schedule() {
    if (this.scheduled || this.destroyed || this.eof) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      try {
        this.pump();
      } catch (cause) {
        this.destroy(
          cause.phase
            ? cause
            : failure('ERR_TLS', 'REALITY TLS record rejected.', 'reality', cause),
        );
      }
    });
  }
  deliver(data) {
    if (!data.length) return;
    if (data.length + this.readableLength > this.limit)
      throw failure('ERR_LIMIT', 'REALITY receive buffer exceeded its limit.', 'reality');
    this.blocked = true;
    const accepted = this.push(data);
    if (!this.manual || this.readDirect) this.blocked = !accepted;
  }
  pump() {
    if (this.destroyed || this.blocked || this.eof) return;
    if (this.readDirect) {
      const data = this.raw.read(Math.min(this.window, this.raw.readableLength || this.window));
      if (data) {
        this.deliver(data);
        this.schedule();
      } else if (this.raw.readableEnded) {
        this.eof = true;
        this.push(null);
      }
      return;
    }
    const size = this.buffer.length < 5 ? 5 : 5 + this.buffer.readUInt16BE(3);
    if (size > 16645)
      throw failure('ERR_LIMIT', 'REALITY TLS record exceeds its limit.', 'reality');
    if (this.buffer.length < size) {
      const data = this.raw.read(
        Math.min(size - this.buffer.length, this.raw.readableLength || size - this.buffer.length),
      );
      if (data) this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length < size) {
        if (this.raw.readableEnded)
          throw failure('ERR_PROTOCOL', 'Truncated REALITY TLS record.', 'reality');
        if (data) this.schedule();
        return;
      }
    }
    if (size === 5) {
      if (this.buffer.readUInt16BE(3) < 17)
        throw failure('ERR_TLS', 'Invalid REALITY TLS record size.', 'reality');
      return this.schedule();
    }
    const record = this.buffer;
    this.buffer = Buffer.alloc(0);
    if (record[0] !== 23 || record[1] !== 3 || record[2] !== 3)
      throw failure('ERR_TLS', 'Unexpected REALITY TLS record.', 'reality');
    const plain = this.rx.open(record);
    if (this.control.length && plain.type !== 22)
      throw failure('ERR_TLS', 'Interleaved fragmented TLS control message.', 'reality');
    if (plain.type === 23) this.deliver(plain.data);
    else if (plain.type === 21) {
      if (plain.data.length !== 2 || plain.data[1] !== 0)
        throw failure('ERR_TLS', 'REALITY peer sent a TLS alert.', 'reality');
      this.eof = true;
      this.push(null);
    } else this.handshake(plain.data);
    this.schedule();
  }
  handshake(data) {
    this.control = Buffer.concat([this.control, data]);
    if (this.control.length > Math.min(this.limit, 65536))
      throw failure('ERR_LIMIT', 'TLS control buffer exceeded its limit.', 'reality');
    while (this.control.length >= 4) {
      const size = 4 + this.control.readUIntBE(1, 3);
      if (size > Math.min(this.limit, 65536))
        throw failure('ERR_LIMIT', 'TLS control message exceeded its limit.', 'reality');
      if (this.control.length < size) break;
      const message = this.control.subarray(0, size);
      this.control = this.control.subarray(size);
      if (message[0] === 4) continue; // Session tickets are consumed without resumption.
      if (message[0] !== 24 || size !== 5 || message[4] > 1)
        throw failure('ERR_TLS', 'Unsupported TLS control message.', 'reality');
      if (this.control.length)
        throw failure('ERR_TLS', 'TLS KeyUpdate must end its record.', 'reality');
      this.rx.update();
      if (message[4])
        this.serial(async () => {
          if (this.writeDirect)
            throw failure('ERR_TLS', 'TLS control write attempted after Vision Direct.', 'reality');
          await write(this.raw, this.tx.seal(22, Buffer.from([24, 0, 0, 1, 0])));
          this.tx.update();
        }).catch((error) => this.destroy(error));
    }
  }
}
module.exports = { RealityStream };
