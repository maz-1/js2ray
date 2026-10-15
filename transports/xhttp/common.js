'use strict';
const { Duplex } = require('node:stream');
const { randomInt } = require('node:crypto');
const { failure, normalizeError } = require('../../runtime/errors');

function settings(option = {}, limits = {}) {
  const sourcePath = option.path ?? '/';
  const queryIndex = sourcePath.indexOf('?');
  const path = queryIndex < 0 ? sourcePath : sourcePath.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : sourcePath.slice(queryIndex + 1);
  const padding = option.xPaddingBytes ?? '100-1000';
  const [from, to = from] = String(padding).split('-').map(Number);
  return {
    ...option,
    host: option.host || undefined,
    path: path.endsWith('/') ? path : path + '/',
    query,
    mode: option.mode ?? 'auto',
    httpVersion: option.httpVersion ?? 'auto',
    padding: { from, to },
    maxBytes: limits.maxBufferBytes ?? 1024 * 1024,
    maxSessions: limits.maxConnections ?? 256,
    timeout: limits.handshakeTimeoutMs ?? 10000,
    maxPostBytes: Math.min(option.scMaxEachPostBytes ?? 1000000, limits.maxBufferBytes ?? 1048576),
    maxPosts: option.scMaxBufferedPosts ?? 30,
  };
}
function padding(config) {
  return 'X'.repeat(randomInt(config.padding.from, config.padding.to + 1));
}
function transportError(cause) {
  return normalizeError(cause, 'transport');
}

// One logical XHTTP connection, independent of its HTTP requests and sockets.
// Pausing the readable side pauses the body producer, including HTTP/2 flow control.
class XhttpStream extends Duplex {
  constructor(config, { send, finish, dispose, resume, control, remoteAddress } = {}) {
    super({ allowHalfOpen: false, highWaterMark: Math.min(16384, config.maxBytes) });
    this.maxBytes = config.maxBytes;
    this.send = send;
    this.finish = finish;
    this.dispose = dispose;
    this.resumeSource = resume;
    this.control = control;
    this.remoteAddress = remoteAddress;
    this.on('error', () => {});
  }
  _read() {
    if (this.readScheduled) return;
    this.readScheduled = true;
    // Node invokes _read before removing the bytes requested by read(n).
    // Pull after that removal so the available window reflects actual capacity.
    queueMicrotask(() => {
      this.readScheduled = false;
      if (this.destroyed) return;
      this.pullBody?.();
      this.resumeSource?.();
    });
  }
  write(data, encoding, callback) {
    const length =
      typeof data === 'string'
        ? Buffer.byteLength(data, typeof encoding === 'string' ? encoding : undefined)
        : (data?.byteLength ?? 0);
    if (!this.destroyed && this.writableLength + length > this.maxBytes) {
      const cause = failure('ERR_LIMIT', 'XHTTP send queue exceeded its limit.', 'transport');
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) process.nextTick(done, cause);
      this.destroy(cause);
      return false;
    }
    return super.write(data, encoding, callback);
  }
  _write(data, encoding, callback) {
    if (this.writableLength > this.maxBytes)
      return callback(failure('ERR_LIMIT', 'XHTTP send queue exceeded its limit.', 'transport'));
    this.activity();
    this.send(data, (error) => callback(error ? transportError(error) : undefined));
  }
  _final(callback) {
    this.finish?.(callback);
  }
  _destroy(error, callback) {
    clearTimeout(this.idleTimer);
    this.dispose?.(error);
    callback(error ? transportError(error) : undefined);
  }
  receive(data) {
    if (this.destroyed) return false;
    if (this.readableLength + data.length > this.maxBytes) {
      this.destroy(failure('ERR_LIMIT', 'XHTTP receive queue exceeded its limit.', 'transport'));
      return false;
    }
    this.activity();
    return this.push(data) && this.readableLength < Math.min(16384, this.maxBytes);
  }
  setTimeout(milliseconds, callback) {
    this.idleMs = milliseconds;
    if (callback) this.once('timeout', callback);
    this.activity();
    return this;
  }
  activity() {
    clearTimeout(this.idleTimer);
    if (this.idleMs) {
      this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMs);
      this.idleTimer.unref();
    }
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    this.control?.(true);
    this.idleTimer?.ref();
    return this;
  }
  unref() {
    this.control?.(false);
    this.idleTimer?.unref();
    return this;
  }
}
function attachBody(body, stream) {
  body.on('error', (cause) => stream.destroy(transportError(cause)));
  body.on('aborted', () =>
    stream.destroy(failure('ERR_CLOSED', 'XHTTP body was aborted.', 'transport')),
  );
  // read(n) can raise a Readable's highWaterMark. Enforce our own window and
  // pull only available space; a native HTTP body may coalesce a much larger chunk.
  const pull = () => {
    if (stream.destroyed) return;
    const window = Math.min(16384, stream.maxBytes);
    while (stream.readableLength < window && body.readableLength) {
      const data = body.read(Math.min(window - stream.readableLength, body.readableLength));
      if (!data || !stream.receive(data)) break;
    }
  };
  stream.pullBody = pull;
  body.on('readable', pull);
  stream.once('close', () => {
    body.removeListener('readable', pull);
    stream.pullBody = undefined;
  });
  body.once('end', () => {
    if (!stream.destroyed) stream.push(null);
  });
  pull();
}
module.exports = { settings, padding, transportError, XhttpStream, attachBody };
