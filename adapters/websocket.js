'use strict';
const WebSocket = require('ws');
const { createHttpAgent, createHttpsAgent } = require('./http');
const { failure, normalizeEmitter, normalizeError } = require('../runtime/errors');

function createWebSocket(runtime, address, options = {}) {
  let url;
  try {
    url = new URL(address);
  } catch (cause) {
    throw failure('ERR_TARGET', 'Invalid WebSocket URL.', 'websocket', cause);
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw failure(
      'ERR_TARGET',
      'Expected a WS/WSS URL without credentials or fragment.',
      'websocket',
    );
  const {
    protocols = [],
    headers,
    origin,
    signal,
    timeoutMs = 20000,
    targetTls,
    outboundTag,
    inboundTag,
    maxPayload = 1024 * 1024,
    maxBufferBytes = 1024 * 1024,
    closeTimeoutMs = 5000,
  } = options;
  for (const value of [timeoutMs, maxPayload, maxBufferBytes, closeTimeoutMs])
    if (!Number.isSafeInteger(value) || value < 1)
      throw failure('ERR_CONFIG', 'WebSocket limits must be positive integers.', 'config');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw failure('ERR_CONFIG', 'Expected an AbortSignal.', 'config');
  const agent = (url.protocol === 'wss:' ? createHttpsAgent : createHttpAgent)(runtime, {
    outboundTag,
    inboundTag,
    signal,
    timeoutMs,
    targetTls,
    keepAlive: false,
  });
  let socket;
  try {
    socket = new WebSocket(url, protocols, {
      agent,
      headers,
      origin,
      handshakeTimeout: timeoutMs,
      maxPayload,
      closeTimeout: closeTimeoutMs,
      perMessageDeflate: false,
      followRedirects: false,
    });
  } catch (cause) {
    agent.destroy();
    throw failure('ERR_CONFIG', 'Cannot construct WebSocket client.', 'websocket', cause);
  }
  normalizeEmitter(
    socket,
    () => {},
    (cause) => {
      if (signal?.aborted)
        return failure('ERR_CANCELLED', 'WebSocket was cancelled.', 'websocket', cause);
      if (cause?.message === 'Opening handshake has timed out')
        return failure('ERR_TIMEOUT', 'WebSocket Upgrade timed out.', 'websocket', cause);
      return normalizeError(cause, 'websocket');
    },
  );
  // Do not expose server text (which may contain credentials) in diagnostics.
  socket.once('unexpected-response', (request, response) => {
    response.resume();
    request.destroy(failure('ERR_WS_UPGRADE', 'WebSocket Upgrade was rejected.', 'websocket'));
  });
  const abort = () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else {
      socket.emit('error', failure('ERR_CANCELLED', 'WebSocket was cancelled.', 'websocket'));
      socket.terminate();
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  socket.once('close', () => {
    signal?.removeEventListener('abort', abort);
    agent.destroy();
  });
  const send = socket.send;
  socket.send = function (data, settings, callback) {
    const done = typeof settings === 'function' ? settings : callback;
    if (this.readyState !== WebSocket.OPEN) {
      const error =
        this.readyState === WebSocket.CONNECTING
          ? failure('ERR_STATE', 'WebSocket is not open yet.', 'websocket')
          : failure('ERR_CLOSED', 'WebSocket is closed.', 'websocket');
      if (done && this.readyState !== WebSocket.CONNECTING) {
        queueMicrotask(() => done(error));
        return;
      }
      throw error;
    }
    const length =
      data == null ? 0 : Buffer.byteLength(typeof data === 'number' ? String(data) : data);
    if (this.bufferedAmount + length > maxBufferBytes) {
      const error = failure('ERR_LIMIT', 'WebSocket send queue exceeded its limit.', 'websocket');
      if (done) queueMicrotask(() => done(error));
      else throw error;
      return;
    }
    if (length <= 8192) {
      const completed = done
        ? (error) => done(error ? normalizeError(error, 'websocket') : undefined)
        : undefined;
      try {
        return typeof settings === 'function'
          ? send.call(this, data, completed)
          : send.call(this, data, settings, completed);
      } catch (cause) {
        throw normalizeError(cause, 'websocket');
      }
    }
    const flags = typeof settings === 'object' ? settings : {};
    const bytes =
      typeof data === 'string' || typeof data === 'number'
        ? Buffer.from(String(data))
        : Buffer.isBuffer(data)
          ? data
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(data);
    let pending = Math.ceil(bytes.length / 8192),
      failed = false;
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      send.call(
        this,
        bytes.subarray(offset, offset + 8192),
        {
          ...flags,
          binary: flags.binary ?? typeof data !== 'string',
          fin: offset + 8192 >= bytes.length ? flags.fin !== false : false,
        },
        (error) => {
          pending--;
          if (error && !failed) {
            failed = true;
            done?.(normalizeError(error, 'websocket'));
          } else if (!pending && !failed) done?.();
        },
      );
    }
  };
  socket.on('error', () => {});
  if (signal?.aborted) queueMicrotask(abort);
  return socket;
}
module.exports = { createWebSocket };
