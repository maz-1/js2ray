'use strict';
const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');
const { encode, decode } = require('./frame');
const { failure } = require('../../runtime/errors');
const { write, relay } = require('../../runtime/streams');

class Session extends Duplex {
  constructor(parent, id, target) {
    super({ allowHalfOpen: true, highWaterMark: Math.min(65536, parent.sessionLimit) });
    this.parent = parent;
    this.id = id;
    this.target = target;
    this.sentEnd = false;
    this.remoteEnd = false;
    this.on('error', () => {});
  }
  _read() {}
  _write(chunk, encoding, callback) {
    this.touch();
    if (this.remoteEnd || this.parent.closed)
      return callback(failure('ERR_CLOSED', 'Mux session is closed.', 'mux'));
    if (this.writableLength > this.parent.sessionLimit)
      return callback(failure('ERR_LIMIT', 'Mux session send queue exceeded its limit.', 'mux'));
    (async () => {
      for (let offset = 0; offset < chunk.length; offset += 8192)
        await this.parent.send({
          id: this.id,
          status: 2,
          data: chunk.subarray(offset, offset + 8192),
        });
    })().then(() => callback(), callback);
  }
  _final(callback) {
    this.sentEnd = true;
    this.parent.send({ id: this.id, status: 3 }).then(() => callback(), callback);
    // Mux.Cool END closes both directions in the reference implementation.
  }
  _destroy(error, callback) {
    clearTimeout(this.timer);
    if (!this.parent.closed && !this.remoteEnd) this.parent.retired.add(this.id);
    if (!this.parent.closed && !this.sentEnd && !this.remoteEnd)
      this.parent.send({ id: this.id, status: 3, error: Boolean(error) }).catch(() => {});
    this.parent.sessions.delete(this.id);
    this.parent.emit('sessionClosed', this.id);
    callback(error);
  }
  receive(data) {
    if (this.destroyed) return;
    if (
      this.readableLength + data.length > this.parent.sessionLimit ||
      this.parent.receivedBytes + data.length > this.parent.maxBufferBytes
    )
      return this.destroy(failure('ERR_LIMIT', 'Mux receive queues exceeded their limit.', 'mux'));
    this.touch();
    if (this.target?.network === 'udp') this.emit('packet', Buffer.from(data));
    else this.push(Buffer.from(data));
  }
  setTimeout(ms, callback) {
    this.timeout = ms;
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
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    this.parent.stream.ref?.();
    return this;
  }
  unref() {
    this.parent.stream.unref?.();
    return this;
  }
}

class Mux extends EventEmitter {
  constructor(
    stream,
    {
      server = false,
      dispatch,
      maxSessions = 128,
      maxBufferBytes = 1024 * 1024,
      sessionLimit = 256 * 1024,
      idleTimeoutMs = 60000,
      allowControl = false,
    } = {},
  ) {
    super();
    this.stream = stream;
    this.server = server;
    this.dispatch = dispatch;
    this.maxSessions = maxSessions;
    this.maxBufferBytes = maxBufferBytes;
    this.sessionLimit = Math.min(sessionLimit, maxBufferBytes);
    this.allowControl = allowControl;
    this.sessions = new Map();
    this.retired = new Set();
    this.nextId = 1;
    this.total = 0;
    this.pendingBytes = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.draining = false;
    this.idleTimeoutMs = idleTimeoutMs;
    this.on('error', () => {});
    stream.on('data', (chunk) => {
      if (this.closed) return;
      try {
        if (this.buffer.length + chunk.length > this.maxBufferBytes)
          throw failure('ERR_LIMIT', 'Mux decoder queue exceeded its limit.', 'mux');
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let frame;
        while ((frame = decode(this.buffer))) {
          this.buffer = this.buffer.subarray(frame.bytes);
          this.frame(frame);
          if (this.closed) break;
        }
      } catch (error) {
        this.close(error);
      }
    });
    stream.once('error', (error) => this.close(error));
    stream.once('end', () =>
      this.close(
        this.buffer.length ? failure('ERR_PROTOCOL', 'Truncated Mux frame.', 'mux') : undefined,
      ),
    );
    stream.once('close', () => this.close());
    if (idleTimeoutMs)
      stream.setTimeout?.(idleTimeoutMs, () => {
        if (!this.sessions.size) this.close();
      });
  }
  get receivedBytes() {
    let bytes = 0;
    for (const stream of this.sessions.values()) bytes += stream.readableLength;
    return bytes;
  }
  async send(frame) {
    if (this.closed) throw failure('ERR_CLOSED', 'Mux transport is closed.', 'mux');
    const bytes = encode(frame);
    if (this.pendingBytes + bytes.length > this.maxBufferBytes) {
      const error = failure('ERR_LIMIT', 'Mux transport send queue exceeded its limit.', 'mux');
      this.close(error);
      throw error;
    }
    this.pendingBytes += bytes.length;
    try {
      await write(this.stream, bytes);
    } finally {
      this.pendingBytes -= bytes.length;
    }
  }
  open(target) {
    if (this.closed || this.draining)
      throw failure('ERR_CLOSED', 'Mux transport is unavailable.', 'mux');
    if (this.sessions.size >= this.maxSessions)
      throw failure('ERR_LIMIT', 'Mux concurrency limit reached.', 'mux');
    if (
      target.network === 'udp' &&
      !(this.allowControl && target.host === 'reverse.internal.v2fly.org' && target.port === 0)
    )
      throw failure('ERR_UNSUPPORTED', 'Mux UDP/XUDP business sessions are unsupported.', 'mux');
    let id;
    for (let attempt = 0; attempt < 65536; attempt++) {
      const next = this.nextId;
      this.nextId = (next + 1) & 65535;
      if (!this.sessions.has(next) && !this.retired.has(next)) {
        id = next;
        break;
      }
    }
    if (id === undefined) throw failure('ERR_LIMIT', 'Mux session identifiers exhausted.', 'mux');
    const stream = new Session(this, id, target);
    this.sessions.set(id, stream);
    this.total++;
    if (this.idleTimeoutMs)
      stream.setTimeout(this.idleTimeoutMs, () =>
        stream.destroy(failure('ERR_TIMEOUT', 'Mux session idle timeout.', 'mux')),
      );
    this.send({ id, status: 1, target }).catch((error) => stream.destroy(error));
    return stream;
  }
  frame(frame) {
    if (frame.status === 4) return;
    let session = this.sessions.get(frame.id);
    if (frame.status === 1) {
      if (!this.server || session || this.retired.has(frame.id))
        throw failure('ERR_PROTOCOL', 'Unexpected Mux NEW session.', 'mux');
      const control =
        this.allowControl &&
        frame.target.host === 'reverse.internal.v2fly.org' &&
        frame.target.port === 0 &&
        frame.target.network === 'udp';
      if (this.sessions.size >= this.maxSessions || (frame.target.network !== 'tcp' && !control)) {
        this.send({ id: frame.id, status: 3, error: true }).catch(() => {});
        return;
      }
      session = new Session(this, frame.id, frame.target);
      this.sessions.set(frame.id, session);
      this.total++;
      if (this.idleTimeoutMs)
        session.setTimeout(this.idleTimeoutMs, () =>
          session.destroy(failure('ERR_TIMEOUT', 'Mux session idle timeout.', 'mux')),
        );
      if (control) this.emit('control', session);
      else {
        const pending = new AbortController();
        session.once('close', () => pending.abort());
        Promise.resolve()
          .then(() => this.dispatch({ ...frame.target, signal: pending.signal }))
          .then(
            (remote) => {
              if (session.destroyed) remote.destroy();
              else relay(session, remote);
            },
            (error) => session.destroy(error),
          );
      }
    }
    if (!session) {
      if (frame.status === 3) this.retired.delete(frame.id);
      if (frame.status === 2) this.send({ id: frame.id, status: 3 }).catch(() => {});
      return;
    }
    if (frame.status === 3) {
      session.remoteEnd = true;
      if (frame.error)
        { this.send({ id: frame.id, status: 3 }).catch(() => {}); session.destroy(failure('ERR_MUX_SESSION', 'Remote Mux session failed.', 'mux')); }
      else {
        session.push(null);
        if (!session.writableEnded) session.end();
      }
      return;
    }
    if (frame.data !== undefined) session.receive(frame.data);
  }
  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.retired.clear();
    for (const session of [...this.sessions.values()])
      session.destroy(error ?? failure('ERR_TRANSPORT', 'Mux transport closed.', 'mux'));
    this.stream.destroy();
    if (error) this.emit('error', error);
    this.emit('close');
  }
}
module.exports = { Mux, Session };
