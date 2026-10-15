'use strict';
const { Duplex } = require('node:stream');
const { randomInt, timingSafeEqual } = require('node:crypto');
const { failure } = require('../../runtime/errors');
const { write } = require('../../runtime/streams');
const FLOW = 'xtls-rprx-vision';

function state() {
  return {
    packets: 0,
    tls: false,
    modern: false,
    direct: false,
    directions: [Buffer.alloc(0), Buffer.alloc(0)],
    stopped: [false, false],
  };
}
// Inspect complete inner TLS records, independently in both directions. Bounds
// are fixed even when a peer sends fragmented or malformed handshake lengths.
function inspect(shared, data, direction) {
  shared.packets++;
  if (shared.stopped[direction] || shared.direct) return;
  let buffer = shared.directions[direction];
  if (buffer.length + data.length > 65540) {
    shared.stopped[direction] = true;
    return;
  }
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 5) {
    if (buffer[1] !== 3 || buffer[2] > 3 || ![20, 21, 22, 23].includes(buffer[0])) {
      shared.stopped[direction] = true;
      buffer = Buffer.alloc(0);
      break;
    }
    const length = buffer.readUInt16BE(3);
    if (length > 18432) {
      shared.stopped[direction] = true;
      buffer = Buffer.alloc(0);
      break;
    }
    if (buffer.length < 5 + length) break;
    const body = buffer.subarray(5, 5 + length);
    if (buffer[0] === 22 && body[0] === 1) shared.tls = true;
    if (buffer[0] === 22 && body[0] === 2 && body.length >= 42) {
      shared.tls = true;
      shared.modern = body.readUInt16BE(4) >= 0x0303;
      const position = 39 + body[38];
      if (position + 5 <= body.length) {
        const cipher = body.readUInt16BE(position);
        const end = position + 5 + body.readUInt16BE(position + 3);
        for (let offset = position + 5; offset + 4 <= Math.min(end, body.length); ) {
          const type = body.readUInt16BE(offset),
            size = body.readUInt16BE(offset + 2);
          if (offset + 4 + size > Math.min(end, body.length)) break;
          if (
            type === 43 &&
            size === 2 &&
            body.readUInt16BE(offset + 4) === 0x0304 &&
            [0x1301, 0x1302, 0x1303, 0x1304].includes(cipher)
          )
            shared.direct = true;
          offset += 4 + size;
        }
      }
    }
    buffer = buffer.subarray(5 + length);
  }
  shared.directions[direction] = buffer;
}

class Decoder {
  constructor(uuid) {
    this.uuid = uuid;
    this.prefix = Buffer.alloc(0);
    this.header = Buffer.alloc(0);
    this.content = 0;
    this.padding = 0;
    this.command = 0;
    this.ended = false;
    this.direct = false;
    this.started = false;
  }
  decode(data) {
    const output = [];
    if (this.ended) return [data];
    if (this.uuid) {
      const size = Math.min(16 - this.prefix.length, data.length);
      this.prefix = Buffer.concat([this.prefix, data.subarray(0, size)]);
      data = data.subarray(size);
      if (this.prefix.length !== 16) return output;
      if (!timingSafeEqual(this.prefix, this.uuid))
        throw failure('ERR_PROTOCOL', 'Invalid Vision padding identity.', 'protocol');
      this.uuid = undefined;
    }
    while (data.length) {
      if (!this.content && !this.padding && this.header.length < 5) {
        const size = Math.min(5 - this.header.length, data.length);
        this.header = Buffer.concat([this.header, data.subarray(0, size)]);
        data = data.subarray(size);
        if (this.header.length < 5) break;
        this.command = this.header[0];
        if (this.command > 2) throw failure('ERR_PROTOCOL', 'Invalid Vision command.', 'protocol');
        this.content = this.header.readUInt16BE(1);
        this.padding = this.header.readUInt16BE(3);
        this.started = true;
      }
      if (this.content) {
        const size = Math.min(this.content, data.length);
        if (size) output.push(data.subarray(0, size));
        data = data.subarray(size);
        this.content -= size;
      }
      if (!this.content && this.padding) {
        const size = Math.min(this.padding, data.length);
        data = data.subarray(size);
        this.padding -= size;
      }
      if (!this.content && !this.padding && this.header.length === 5) {
        this.header = Buffer.alloc(0);
        if (this.command !== 0) {
          this.ended = true;
          this.direct = this.command === 2;
          if (data.length) output.push(data);
          break;
        }
      }
    }
    return output;
  }
  finish() {
    if (!this.started || this.uuid || this.header.length || this.content || this.padding)
      throw failure('ERR_PROTOCOL', 'Truncated Vision padding.', 'protocol');
  }
}
function padding(uuid, data, command, long) {
  const count = Math.min(
    8192 - 21 - data.length,
    long && data.length < 900 ? randomInt(500) + 900 - data.length : randomInt(256),
  );
  const header = Buffer.alloc(5);
  header[0] = command;
  header.writeUInt16BE(data.length, 1);
  header.writeUInt16BE(count, 3);
  return Buffer.concat([uuid ?? Buffer.alloc(0), header, data, Buffer.alloc(count)]);
}

class VisionStream extends Duplex {
  constructor(
    socket,
    uuid,
    {
      maxBufferBytes = 1048576,
      responseHeader = false,
      initialPaddingWritten = false,
      onSwitch = () => {},
    } = {},
  ) {
    super({ allowHalfOpen: true, highWaterMark: Math.min(16384, maxBufferBytes) });
    if (socket.getProtocol?.() !== 'TLSv1.3' || !socket.switchRead)
      throw failure('ERR_TLS', 'Vision requires an outer TLS 1.3 record gate.', 'tls');
    this.socket = socket;
    this.limit = maxBufferBytes;
    this.shared = state();
    this.decoder = new Decoder(uuid);
    this.writeUuid = initialPaddingWritten ? undefined : uuid;
    this.isPadding = true;
    this.onSwitch = onSwitch;
    this.response = responseHeader ? Buffer.alloc(0) : undefined;
    this.on('error', () => {});
    socket.on('data', (chunk) => {
      try {
        if (this.response !== undefined) {
          this.response = Buffer.concat([this.response, chunk]);
          if (this.response.length < 2) return socket.requestRecord();
          if (this.response[0] !== 0)
            throw failure('ERR_PROTOCOL', 'Invalid VLESS response version.', 'protocol');
          const size = 2 + this.response[1];
          if (this.response.length < size) return socket.requestRecord();
          chunk = this.response.subarray(size);
          this.response = undefined;
        }
        const before = this.decoder.direct;
        for (const data of this.decoder.decode(chunk)) {
          inspect(this.shared, data, 0);
          if (this.readableLength + data.length > this.limit)
            throw failure('ERR_LIMIT', 'Vision plaintext buffer exceeded its limit.', 'protocol');
          if (!this.push(data)) socket.pause();
        }
        if (!before && this.decoder.direct) {
          socket.switchRead();
          this.onSwitch('read');
          this.emit('visionSwitch', 'read');
        }
        if (this.readableLength < this.readableHighWaterMark) socket.requestRecord();
      } catch (error) {
        this.destroy(error);
      }
    });
    socket.on('end', () => {
      try {
        if (this.response !== undefined)
          throw failure('ERR_PROTOCOL', 'Truncated VLESS response.', 'protocol');
        this.decoder.finish();
        this.push(null);
      } catch (error) {
        this.destroy(error);
      }
    });
    socket.on('error', (error) => this.destroy(error));
    socket.on('close', () => this.destroy());
    socket.on('timeout', () => this.emit('timeout'));
    for (const method of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'])
      this[method] = (...args) => {
        socket[method]?.(...args);
        return this;
      };
    Object.defineProperty(this, 'remoteAddress', { get: () => socket.remoteAddress });
    socket.resume();
    socket.requestRecord();
  }
  _read() {
    queueMicrotask(() => {
      if (!this.destroyed) {
        this.socket.resume();
        this.socket.requestRecord();
      }
    });
  }
  _write(chunk, encoding, callback) {
    if (chunk.length > this.limit)
      return callback(failure('ERR_LIMIT', 'Vision write exceeds its buffer limit.', 'protocol'));
    this.send(chunk).then(() => callback(), callback);
  }
  async send(chunk) {
    if (!this.isPadding) return write(this.socket, chunk);
    inspect(this.shared, chunk, 1);
    const application =
      this.shared.tls && chunk.length >= 6 && chunk[0] === 23 && chunk[1] === 3 && chunk[2] === 3;
    const end = application || (!this.shared.modern && this.shared.packets >= 7);
    const command = end ? (application && this.shared.direct ? 2 : 1) : 0;
    for (let offset = 0; offset < chunk.length; offset += 8171) {
      const part = chunk.subarray(offset, offset + 8171);
      await write(
        this.socket,
        padding(
          this.writeUuid,
          part,
          offset + part.length === chunk.length ? command : 0,
          this.shared.tls,
        ),
      );
      this.writeUuid = undefined;
    }
    if (end) this.isPadding = false;
    if (command === 2) {
      this.socket.switchWrite();
      this.onSwitch('write');
      this.emit('visionSwitch', 'write');
    }
  }
  _final(callback) {
    this.socket.end(callback);
  }
  _destroy(error, callback) {
    this.socket.destroy();
    callback(error);
  }
}
module.exports = { FLOW, Decoder, VisionStream, inspect, state, padding };
