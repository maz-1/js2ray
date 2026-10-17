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
  if (options.alpn) out.ALPNProtocols = options.alpn;
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
  for (const field of ['remotePort', 'localAddress', 'localPort'])
    Object.defineProperty(stream, field, { get: () => ws._socket?.[field] });
  activity();
  return stream;
}
async function connect(network, options = {}) {
  if (network.type === 'quic') return require('./quic').connect(network, options);
  if (network.type === 'xhttp') return require('./xhttp').connect(network, options, connect);
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
    if (option.reality) return await require('./reality').client(socket, network, options);
    if (option.tls) {
      const raw = socket;
      const name = option.tls.serverName ?? network.address;
      const secureOptions = {
        ...tlsOptions(option.tls),
        servername: net.isIP(name) ? '' : name,
        checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(name, cert),
      };
      socket = network[Symbol.for('js2ray.vision')]
        ? require('./vision-tls').wrap(
            raw,
            { ...secureOptions, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
            options,
          )
        : tls.connect({ ...secureOptions, socket: raw });
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
  if (network.type === 'quic')
    return require('./quic').createListener(network, onConnection, options);
  if (network.option?.reality)
    return require('./reality').createListener(network, onConnection, options);
  if (network.type === 'xhttp')
    return require('./xhttp').createListener(network, onConnection, options, tlsOptions);
  let option = network.option ?? {};
  let currentTLS = option.tls ? tlsOptions(option.tls) : undefined;
  let server;
  let wss;
  const connections = new Set();
  const observations = new Map(),
    peers = new Map();
  const peerKey = (socket) => `${socket.remoteAddress}:${socket.remotePort}`;
  const observed = (socket) => observations.get(socket) ?? peers.get(peerKey(socket));
  const ready = (socket) => {
    observed(socket)?.success();
    onConnection(socket);
  };
  const rawConnection = (socket) => {
    const observer = require('./inbound').watch(
      socket,
      options,
      network.type === 'ws' ? (option.tls ? 'wss' : 'ws') : option.tls ? 'tls' : 'tcp',
    );
    observations.set(socket, observer);
    observer.clearSocketTimeout = () => socket.setTimeout(0);
    const key = peerKey(socket);
    peers.set(key, observer);
    connections.add(socket);
    socket.on('error', () => {});
    let timer;
    if (option.tls || network.type === 'ws') {
      timer = setTimeout(() => {
        observer.timeout();
        socket.destroy();
      }, options.handshakeTimeoutMs ?? 10000);
      const complete = observer.success;
      observer.success = () => {
        clearTimeout(timer);
        complete();
      };
    }
    socket.once('close', () => {
      clearTimeout(timer);
      connections.delete(socket);
      observations.delete(socket);
      if (peers.get(key) === observer) peers.delete(key);
    });
    if (connections.size > (options.maxConnections ?? 1024)) {
      observer.reject();
      socket.destroy();
    }
  };
  if (network.type === 'ws') {
    const request = (req, res) => {
      res.writeHead(404);
      res.end();
    };
    server = option.tls
      ? https.createServer({ ...currentTLS, handshakeTimeout: options.handshakeTimeoutMs }, request)
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
      ) {
        observed(socket)?.fail(
          failure('ERR_PROTOCOL', 'Inbound WebSocket Upgrade rejected.', 'inbound'),
        );
        return socket.destroy();
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        observed(socket)?.success();
        onConnection(wsStream(ws, options));
      });
    });
    wss.on('wsClientError', (cause, socket) => {
      observed(socket)?.fail(
        failure('ERR_PROTOCOL', 'Invalid inbound WebSocket handshake.', 'inbound', cause),
      );
      socket.destroy();
    });
    server.on('clientError', (cause, socket) => {
      observed(socket)?.fail(
        failure('ERR_PROTOCOL', 'Invalid inbound HTTP handshake.', 'inbound', cause),
      );
      socket.destroy();
    });
  } else if (option.tls) {
    if (network[Symbol.for('js2ray.vision')]) {
      const contextOptions = (settings) => ({
        ...settings,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      });
      let context = tls.createSecureContext(contextOptions(currentTLS));
      server = net.createServer({ allowHalfOpen: true }, (raw) => {
        const stream = require('./vision-tls').wrap(
          raw,
          { secureContext: context },
          { ...options, server: true },
        );
        const timer = setTimeout(() => {
          observed(raw)?.timeout();
          stream.destroy();
        }, options.handshakeTimeoutMs ?? 10000);
        stream.once('error', (cause) =>
          observed(raw)?.fail(
            failure('ERR_TLS', 'Inbound Vision TLS handshake failed.', 'inbound', cause),
          ),
        );
        stream.once('secureConnect', () => {
          clearTimeout(timer);
          observed(raw)?.success();
          onConnection(stream);
        });
        stream.once('close', () => clearTimeout(timer));
      });
      server.setSecureContext = (settings) => {
        context = tls.createSecureContext(contextOptions(settings));
      };
    } else
      server = tls.createServer(
        {
          ...currentTLS,
          allowHalfOpen: true,
          handshakeTimeout: options.handshakeTimeoutMs,
        },
        ready,
      );
  } else server = net.createServer({ allowHalfOpen: true }, ready);
  server.prependListener('connection', rawConnection);
  server.on('tlsClientError', (cause, socket) => {
    observed(socket)?.fail(
      failure(
        cause.code?.includes('TIMEOUT') ? 'ERR_TIMEOUT' : 'ERR_TLS',
        'Inbound TLS handshake failed.',
        'inbound',
        cause,
      ),
    );
    socket.destroy();
  });
  // HTTP sockets that never finish an Upgrade must also have a bounded lifetime.
  if (network.type === 'ws')
    server.on('connection', (socket) =>
      socket.setTimeout(options.handshakeTimeoutMs, () => {
        observed(socket)?.timeout();
        socket.destroy();
      }),
    );
  if (network.type === 'ws')
    server.on('upgrade', (request) => {
      observed(request.socket)?.clearSocketTimeout();
      request.socket.setTimeout(options.idleTimeoutMs ?? 0);
    });
  return {
    server,
    prepareUpdate(nextNetwork, nextOptions) {
      if (
        network.type !== nextNetwork.type ||
        Boolean(option.tls) !== Boolean(nextNetwork.option?.tls) ||
        Boolean(network[Symbol.for('js2ray.vision')]) !==
          Boolean(nextNetwork[Symbol.for('js2ray.vision')])
      )
        throw failure(
          'ERR_ROTATION',
          'A shared listener must retain its transport type.',
          'rotation',
        );
      let nextTLS;
      try {
        nextTLS = nextNetwork.option?.tls ? tlsOptions(nextNetwork.option.tls) : undefined;
        if (nextTLS) tls.createSecureContext(nextTLS);
      } catch (cause) {
        throw failure('ERR_TLS', 'Candidate listener TLS material is invalid.', 'rotation', cause);
      }
      const previous = { network, options, tls: currentTLS };
      const apply = (settings, limits, secure) => {
        if (secure) server.setSecureContext(secure);
        network = settings;
        option = network.option ?? {};
        options = limits;
        currentTLS = secure;
        if (wss) {
          wss.options.maxPayload = limits.maxBufferBytes;
          server.headersTimeout = limits.handshakeTimeoutMs;
          server.requestTimeout = limits.handshakeTimeoutMs;
        }
      };
      return {
        commit: () => apply(nextNetwork, nextOptions, nextTLS),
        rollback: () => apply(previous.network, previous.options, previous.tls),
      };
    },
    destroy() {
      for (const socket of connections) {
        observations.get(socket)?.cancel();
        socket.destroy();
      }
      wss?.close();
    },
  };
}
module.exports = { connect, createListener, tlsOptions, wsStream };
