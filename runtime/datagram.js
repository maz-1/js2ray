'use strict';
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { failure, normalizeError } = require('./errors');
const { write } = require('./streams');

class DatagramSession extends EventEmitter {
  constructor(target, maxBufferBytes) {
    super();
    this.target = Object.freeze({ host: target.host, port: target.port });
    this.maxBufferBytes = maxBufferBytes;
    this.queue = [];
    this.bytes = 0;
    this.waiters = [];
    this.destroyed = false;
    this.closed = false;
    this.on('error', () => {});
  }
  receive(data) {
    if (this.destroyed) return;
    const message = { data, ...this.target };
    this.touch();
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: message, done: false });
    if (this.listenerCount('message')) return this.emit('message', data, this.target);
    if (waiter) return;
    if (this.bytes + data.length > this.maxBufferBytes || this.queue.length >= 1024)
      return this.destroy(
        failure('ERR_LIMIT', 'Datagram receive queue exceeded its limit.', 'protocol'),
      );
    this.queue.push(message);
    this.bytes += data.length;
  }
  next() {
    const message = this.queue.shift();
    if (message) {
      this.bytes -= message.data.length;
      return Promise.resolve({ value: message, done: false });
    }
    if (this.error) return Promise.reject(this.error);
    if (this.destroyed) return Promise.resolve({ done: true });
    if (this.waiters.length >= 1024)
      return Promise.reject(failure('ERR_LIMIT', 'Too many pending datagram reads.', 'protocol'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async return() {
    this.destroy();
    return { done: true };
  }
  validate(data, target) {
    if (this.destroyed) throw failure('ERR_CLOSED', 'Datagram session is closed.', 'protocol');
    if (!Buffer.isBuffer(data) || data.length > 65535)
      throw failure('ERR_TARGET', 'Datagrams must be Buffers of at most 65535 bytes.', 'protocol');
    if (target && (target.host !== this.target.host || target.port !== this.target.port))
      throw failure('ERR_TARGET', 'Traditional UDP sessions have one fixed target.', 'protocol');
    this.touch();
  }
  setTimeout(milliseconds, callback) {
    this.timeout = milliseconds;
    if (callback) this.on('timeout', callback);
    this.touch();
    return this;
  }
  touch() {
    clearTimeout(this.timer);
    if (this.timeout) {
      this.timer = setTimeout(() => this.emit('timeout'), this.timeout);
      this.timer.unref();
    }
  }
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    if (error) error = normalizeError(error);
    this.error = error;
    this.queue = [];
    this.bytes = 0;
    for (const waiter of this.waiters.splice(0))
      error ? waiter.reject(error) : waiter.resolve({ done: true });
    if (error) this.emit('error', error);
    this.dispose();
  }
  finish() {
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }
  close() {
    this.destroy();
  }
}

class FramedDatagram extends DatagramSession {
  constructor(stream, target, maxBufferBytes) {
    super(target, maxBufferBytes);
    this.stream = stream;
    this.buffer = Buffer.alloc(0);
    this.pendingBytes = 0;
    stream.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 2) {
        const length = this.buffer.readUInt16BE();
        if (this.buffer.length < 2 + length) break;
        this.receive(Buffer.from(this.buffer.subarray(2, 2 + length)));
        this.buffer = this.buffer.subarray(2 + length);
        if (this.destroyed) return;
      }
      if (this.buffer.length > Math.min(65537, maxBufferBytes))
        this.destroy(failure('ERR_LIMIT', 'UDP frame exceeds its receive limit.', 'protocol'));
    });
    stream.once('error', (error) => this.destroy(error));
    stream.once('end', () =>
      this.destroy(
        this.buffer.length
          ? failure('ERR_PROTOCOL', 'Truncated UDP frame.', 'protocol')
          : undefined,
      ),
    );
    stream.once('close', () => {
      this.destroy();
      this.finish();
    });
  }
  async send(data, target) {
    this.validate(data, target);
    if (this.pendingBytes + data.length + 2 > this.maxBufferBytes)
      throw failure('ERR_LIMIT', 'Datagram send queue exceeded its limit.', 'protocol');
    const frame = Buffer.alloc(2 + data.length);
    frame.writeUInt16BE(data.length);
    data.copy(frame, 2);
    this.pendingBytes += frame.length;
    try {
      await write(this.stream, frame);
    } finally {
      this.pendingBytes -= frame.length;
    }
  }
  dispose() {
    this.stream.destroy();
    this.buffer = Buffer.alloc(0);
  }
}

async function directDatagram(target, { signal, lookup = dns.lookup, maxBufferBytes }) {
  const address = net.isIP(target.host)
    ? target.host
    : await new Promise((resolve, reject) => {
        const abort = () =>
          reject(failure('ERR_CANCELLED', 'Datagram DNS cancelled.', 'dns', signal.reason));
        signal.addEventListener('abort', abort, { once: true });
        lookup(target.host, {}, (error, address) => {
          signal.removeEventListener('abort', abort);
          error
            ? reject(failure('ERR_DNS', 'Datagram DNS failed.', 'dns', error))
            : resolve(address);
        });
        if (signal.aborted) abort();
      });
  if (signal.aborted) throw failure('ERR_CANCELLED', 'Datagram dial cancelled.', 'transport');
  const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
  const session = new DatagramSession(target, maxBufferBytes);
  let pendingBytes = 0;
  session.dispose = () => {
    try {
      socket.close();
    } catch {
      session.finish();
    }
  };
  session.send = async (data, destination) => {
    session.validate(data, destination);
    if (data.length > 65507)
      throw failure('ERR_TARGET', 'Direct UDP payload exceeds 65507 bytes.', 'protocol');
    if (pendingBytes + data.length > maxBufferBytes)
      throw failure('ERR_LIMIT', 'Datagram send queue exceeded its limit.', 'transport');
    pendingBytes += data.length;
    try {
      await new Promise((resolve, reject) =>
        socket.send(data, (error) =>
          error
            ? reject(failure('ERR_TRANSPORT', 'Datagram send failed.', 'transport', error))
            : resolve(),
        ),
      );
    } finally {
      pendingBytes -= data.length;
    }
  };
  socket.on('message', (data) => session.receive(data));
  socket.on('error', (error) =>
    session.destroy(failure('ERR_TRANSPORT', 'Datagram socket failed.', 'transport', error)),
  );
  socket.once('close', () => session.finish());
  await new Promise((resolve, reject) => {
    const abort = () => {
      session.destroy();
      reject(failure('ERR_CANCELLED', 'Datagram dial cancelled.', 'transport'));
    };
    const error = (cause) => {
      signal.removeEventListener('abort', abort);
      reject(cause);
    };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', error);
    socket.connect(target.port, address, () => {
      socket.removeListener('error', error);
      signal.removeEventListener('abort', abort);
      resolve();
    });
    if (signal.aborted) abort();
  });
  return session;
}

module.exports = { FramedDatagram, directDatagram };
