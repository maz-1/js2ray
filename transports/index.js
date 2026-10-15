'use strict';
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const WebSocket = require('ws');
const { failure } = require('../runtime/errors');

function tlsOptions(options = {}) {
  const out = { rejectUnauthorized: options.rejectUnauthorized !== false };
  for (const field of ['ca', 'cert', 'key']) {
    if (options[field] !== undefined) out[field] = options[field];
    if (options[field + 'File']) out[field] = fs.readFileSync(options[field + 'File']);
  }
  if (options.serverName !== undefined)
    out.servername = net.isIP(options.serverName) ? '' : options.serverName;
  return out;
}
function ready(emitter, event, { signal, timeoutMs, phase, close }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(event, success);
      emitter.removeListener('error', error);
      emitter.removeListener('close', closed);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause) {
        close();
        reject(cause);
      } else resolve(emitter);
    };
    const success = () => finish();
    const error = (cause) =>
      finish(
        failure(
          cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN'
            ? 'ERR_DNS'
            : phase === 'tls'
              ? 'ERR_TLS'
              : 'ERR_TRANSPORT',
          'Transport negotiation failed.',
          phase,
          cause,
        ),
      );
    const closed = () =>
      finish(failure('ERR_TRANSPORT', 'Transport closed before it was ready.', phase));
    const abort = () =>
      finish(failure('ERR_CANCELLED', 'Transport negotiation cancelled.', phase, signal.reason));
    const timer = setTimeout(
      () => finish(failure('ERR_TIMEOUT', 'Transport negotiation timed out.', phase)),
      timeoutMs,
    );
    emitter.once(event, success);
    emitter.once('error', error);
    emitter.once('close', closed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function wsStream(
  ws,
  { maxBufferBytes = 1024 * 1024, idleTimeoutMs = 0, closeTimeoutMs = 1000 } = {},
) {
  const stream = WebSocket.createWebSocketStream(ws, {
    highWaterMark: Math.min(65536, maxBufferBytes),
    allowHalfOpen: false,
  });
  stream.on('error', () => {});
  let closeTimer;
  let idleTimer;
  let timeout = idleTimeoutMs;
  const activity = () => {
    clearTimeout(idleTimer);
    if (timeout) {
      idleTimer = setTimeout(() => {
        stream.emit('timeout');
        stream.destroy(failure('ERR_TIMEOUT', 'WebSocket was idle.', 'transport'));
      }, timeout);
      idleTimer.unref();
    }
  };
  ws.prependListener('message', (data, binary) => {
    if (!binary)
      stream.destroy(
        failure('ERR_PROTOCOL', 'WebSocket transport requires binary messages.', 'transport'),
      );
    activity();
  });
  const send = stream._write.bind(stream);
  stream._write = (chunk, encoding, callback) => {
    if (chunk.length > maxBufferBytes)
      return callback(failure('ERR_LIMIT', 'WebSocket write exceeds its limit.', 'transport'));
    activity();
    send(chunk, encoding, callback);
  };
  const final = stream._final.bind(stream);
  stream._final = (callback) => {
    closeTimer = setTimeout(() => ws.terminate(), closeTimeoutMs);
    closeTimer.unref();
    final(callback);
  };
  stream.once('close', () => {
    clearTimeout(closeTimer);
    clearTimeout(idleTimer);
  });
  stream.setTimeout = (milliseconds, callback) => {
    timeout = milliseconds;
    if (callback) stream.once('timeout', callback);
    activity();
    return stream;
  };
  for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    stream[method] = (...args) => {
      ws._socket?.[method]?.(...args);
      return stream;
    };
  Object.defineProperty(stream, 'remoteAddress', { get: () => ws._socket?.remoteAddress });
  activity();
  return stream;
}
async function connect(network, options = {}) {
  const { signal, lookup, connectTimeoutMs = 10000, handshakeTimeoutMs = 10000 } = options;
  if (signal?.aborted)
    throw failure('ERR_CANCELLED', 'Dial was cancelled.', 'transport', signal.reason);
  let socket = new net.Socket({ allowHalfOpen: true });
  socket.on('error', () => {});
  try {
    const connecting = ready(socket, 'connect', {
      signal,
      timeoutMs: connectTimeoutMs,
      phase: 'connect',
      close: () => socket.destroy(),
    });
    socket.connect({ host: network.address, port: network.port, lookup });
    await connecting;
    const option = network.option ?? {};
    if (option.tls) {
      const raw = socket;
      const name = option.tls.serverName ?? network.address;
      socket = tls.connect({
        ...tlsOptions(option.tls),
        socket: raw,
        servername: net.isIP(name) ? '' : name,
        checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(name, cert),
      });
      socket.on('error', () => {});
      await ready(socket, 'secureConnect', {
        signal,
        timeoutMs: handshakeTimeoutMs,
        phase: 'tls',
        close: () => {
          socket.destroy();
          raw.destroy();
        },
      });
    }
    if (network.type === 'ws') {
      const connection = socket;
      const host = net.isIPv6(network.address) ? `[${network.address}]` : network.address;
      const ws = new WebSocket(
        `${option.tls ? 'wss' : 'ws'}://${host}:${network.port}${option.path ?? '/'}`,
        {
          ...tlsOptions(option.tls),
          createConnection: () => connection,
          headers: option.headers,
          perMessageDeflate: false,
          maxPayload: options.maxBufferBytes ?? 1024 * 1024,
          handshakeTimeout: handshakeTimeoutMs,
          closeTimeout: 1000,
          followRedirects: false,
        },
      );
      ws.on('error', () => {});
      const stream = wsStream(ws, options);
      await ready(ws, 'open', {
        signal,
        timeoutMs: handshakeTimeoutMs,
        phase: 'upgrade',
        close: () => {
          ws.terminate();
          connection.destroy();
        },
      });
      if (stream.destroyed)
        throw failure('ERR_PROTOCOL', 'WebSocket closed during setup.', 'upgrade');
      return stream;
    }
    return socket;
  } catch (cause) {
    socket.destroy();
    if (cause.code?.startsWith('ERR_') && cause.phase) throw cause;
    throw failure('ERR_TRANSPORT', 'Cannot create transport.', 'transport', cause);
  }
}
function createListener(network, onConnection, options = {}) {
  const option = network.option ?? {};
  let server;
  let wss;
  const connections = new Set();
  const rawConnection = (socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    if (connections.size > options.maxConnections) socket.destroy();
  };
  if (network.type === 'ws') {
    const request = (req, res) => {
      res.writeHead(404);
      res.end();
    };
    server = option.tls
      ? https.createServer(
          { ...tlsOptions(option.tls), handshakeTimeout: options.handshakeTimeoutMs },
          request,
        )
      : http.createServer(request);
    server.headersTimeout = options.handshakeTimeoutMs;
    server.requestTimeout = options.handshakeTimeoutMs;
    wss = new WebSocket.WebSocketServer({
      noServer: true,
      maxPayload: options.maxBufferBytes,
      perMessageDeflate: false,
      closeTimeout: 1000,
    });
    server.on('upgrade', (request, socket, head) => {
      const expectedHost = Object.entries(option.headers ?? {}).find(
        ([key]) => key.toLowerCase() === 'host',
      )?.[1];
      if (
        request.url !== (option.path ?? '/') ||
        (expectedHost && request.headers.host !== expectedHost)
      )
        return socket.destroy();
      wss.handleUpgrade(request, socket, head, (ws) => onConnection(wsStream(ws, options)));
    });
  } else if (option.tls) {
    server = tls.createServer(
      {
        ...tlsOptions(option.tls),
        allowHalfOpen: true,
        handshakeTimeout: options.handshakeTimeoutMs,
      },
      onConnection,
    );
  } else server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.on('connection', rawConnection);
  server.on('tlsClientError', () => {});
  // HTTP sockets that never finish an Upgrade must also have a bounded lifetime.
  if (network.type === 'ws')
    server.on('connection', (socket) =>
      socket.setTimeout(options.handshakeTimeoutMs, () => socket.destroy()),
    );
  if (network.type === 'ws')
    server.on('upgrade', (request) => request.socket.setTimeout(options.idleTimeoutMs ?? 0));
  return {
    server,
    destroy() {
      for (const socket of connections) socket.destroy();
      wss?.close();
    },
  };
}
module.exports = { connect, createListener, tlsOptions, wsStream };
