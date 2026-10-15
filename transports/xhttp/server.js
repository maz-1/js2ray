'use strict';
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const tls = require('node:tls');
const { failure } = require('../../runtime/errors');
const { settings, padding, XhttpStream, attachBody } = require('./common');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createListener(network, onConnection, limits, tlsOptions) {
  let config = settings(network.option, limits);
  let secure = config.tls ? tlsOptions(config.tls) : undefined;
  const sessions = new Map(),
    streams = new Set(),
    sockets = new Set(),
    h2sessions = new Set();
  const bodies = new Set();
  const effectiveVersion = (value) =>
    value.httpVersion === 'auto' && !value.tls ? '1.1' : value.httpVersion;
  const version = effectiveVersion(config);
  const serverOptions = {
    ...secure,
    allowHTTP1: version === 'auto',
    handshakeTimeout: config.timeout,
    maxHeaderSize: 8192,
    maxHeaderListPairs: 64,
    maxSessionMemory: 4,
    settings: {
      maxHeaderListSize: 8192,
      maxConcurrentStreams: Math.min(config.maxSessions * 3, 1024),
      initialWindowSize: Math.min(config.maxBytes, 65535),
    },
  };
  const server =
    version === '1.1'
      ? secure
        ? https.createServer(serverOptions, handle)
        : http.createServer(serverOptions, handle)
      : secure
        ? http2.createSecureServer(serverOptions, handle)
        : http2.createServer(serverOptions, handle);
  server.headersTimeout = config.timeout;
  server.requestTimeout = 0; // Streaming uploads are bounded by logical idle/handshake limits instead.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (sockets.size > config.maxSessions * 3 + 2) socket.destroy();
    else socket.setTimeout(config.timeout, () => socket.destroy());
  });
  server.on('tlsClientError', () => {});
  server.on('session', (session) => {
    h2sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => h2sessions.delete(session));
  });
  const respond = (res, status) => {
    // Rejected HTTP/1 bodies must not pin a keep-alive socket indefinitely.
    if (status >= 400 && !res.headersSent && !res.stream) res.setHeader('Connection', 'close');
    if (!res.headersSent) res.writeHead(status);
    res.end();
  };
  function headers(res, selected, downstream) {
    res.setHeader('X-Padding', padding(selected));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (downstream && !selected.noSSEHeader) res.setHeader('Content-Type', 'text/event-stream');
    res.writeHead(200);
    res.flushHeaders();
  }
  function createSession(key, selected, remoteAddress) {
    if (streams.size >= config.maxSessions) return;
    const state = {
      key,
      config: selected,
      next: 0,
      packets: new Map(),
      receiving: new Set(),
      bytes: 0,
      requests: new Set(),
      responses: new Set(),
      blocked: false,
      response: undefined,
      upload: undefined,
      paired: false,
      kind: undefined,
    };
    state.stream = new XhttpStream(selected, {
      remoteAddress,
      resume: () => {
        state.blocked = false;
        state.upload?.resume();
        pump(state);
      },
      send: (data, callback) => state.response.write(data, callback),
      finish: (callback) => {
        if (!state.response)
          callback(
            failure('ERR_CLOSED', 'XHTTP upload ended before its downlink arrived.', 'transport'),
          );
        else state.response.end(callback);
      },
      dispose: () => {
        clearTimeout(state.timer);
        clearTimeout(state.gapTimer);
        clearInterval(state.keepAlive);
        sessions.delete(key);
        streams.delete(state.stream);
        state.packets.clear();
        state.bytes = 0;
        const targets = new Set();
        for (const request of state.requests) {
          clearTimeout(request.xhttpTimer);
          targets.add(request.stream ?? request);
        }
        for (const response of state.responses) targets.add(response.stream ?? response);
        // HTTP/2 request and response wrappers share one stream. Dispose it once,
        // after the current nghttp2 callback, rather than resetting it reentrantly.
        setImmediate(() => {
          for (const target of targets) target.destroy();
        });
      },
    });
    streams.add(state.stream);
    if (key !== undefined) sessions.set(key, state);
    state.timer = setTimeout(
      () =>
        state.stream.destroy(
          failure('ERR_TIMEOUT', 'XHTTP session was not paired in time.', 'transport'),
        ),
      selected.timeout,
    );
    state.timer.unref();
    return state;
  }
  function pump(state) {
    while (!state.stream.destroyed && !state.blocked && state.packets.has(state.next)) {
      const packet = state.packets.get(state.next);
      const { data } = packet;
      state.packets.delete(state.next++);
      state.bytes -= data.length;
      clearTimeout(state.gapTimer);
      state.gapTimer = undefined;
      state.blocked = !state.stream.receive(data);
      packet.ack();
    }
    if (state.packets.size && !state.packets.has(state.next) && !state.gapTimer) {
      state.gapTimer = setTimeout(
        () =>
          state.stream.destroy(
            failure('ERR_TIMEOUT', 'XHTTP packet sequence has a gap.', 'transport'),
          ),
        state.config.timeout,
      );
      state.gapTimer.unref();
    }
  }
  function pair(state, req, res) {
    if (state.paired) {
      respond(res, 409);
      return false;
    }
    state.paired = true;
    clearTimeout(state.timer);
    state.response = res;
    state.responses.add(res);
    res.once('close', () => state.responses.delete(res));
    state.requests.add(req);
    headers(res, state.config, true);
    res.once('close', () => state.stream.destroy());
    onConnection(state.stream);
    return true;
  }
  function handle(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    req.socket?.setTimeout(0);
    if (bodies.size >= config.maxSessions * 4) {
      respond(res, 429);
      return;
    }
    bodies.add(req);
    res.once('close', () => bodies.delete(req));
    let url;
    try {
      url = new URL(req.url, 'http://xhttp.invalid');
    } catch {
      respond(res, 400);
      return;
    }
    const parts = url.pathname.split('/');
    const tail = parts.at(-1);
    const hasSequence = /^\d+$/.test(tail) && uuid.test(parts.at(-2));
    const id = hasSequence ? parts.at(-2) : tail;
    const prefix = hasSequence
      ? parts.slice(0, -2).join('/') + '/'
      : parts.slice(0, -1).join('/') + '/';
    const key = uuid.test(id) ? prefix + id : undefined;
    // Existing sessions retain their path, limits and mode during a same-port rotation.
    let state = key ? sessions.get(key) : undefined;
    const selected = state?.config ?? config;
    const host = req.headers[':authority'] ?? req.headers.host;
    if ((selected.host && selected.host !== host) || !url.pathname.startsWith(selected.path)) {
      respond(res, 404);
      return;
    }
    if (!['GET', 'POST'].includes(req.method)) {
      respond(res, 405);
      return;
    }
    let paddingLength;
    try {
      paddingLength =
        (req.headers.referer ? new URL(req.headers.referer).searchParams : url.searchParams).get(
          'x_padding',
        )?.length ?? 0;
    } catch {
      respond(res, 400);
      return;
    }
    if (paddingLength < selected.padding.from || paddingLength > selected.padding.to) {
      respond(res, 400);
      return;
    }
    const one = req.method === 'POST' && url.pathname === selected.path;
    if (!one && (!key || prefix !== selected.path)) {
      respond(res, 400);
      return;
    }
    const mode = one
      ? 'stream-one'
      : req.method === 'GET'
        ? undefined
        : hasSequence
          ? 'packet-up'
          : 'stream-up';
    if (
      mode &&
      selected.mode !== 'auto' &&
      selected.mode !== mode &&
      !(selected.mode === 'stream-up' && mode === 'stream-one')
    ) {
      respond(res, 400);
      return;
    }
    if (req.method === 'GET' && hasSequence) {
      respond(res, 400);
      return;
    }
    if (state?.kind && mode && state.kind !== mode) {
      respond(res, 409);
      return;
    }
    if (!state) state = createSession(key, selected, req.socket?.remoteAddress);
    if (!state) {
      respond(res, 429);
      return;
    }
    if (mode) state.kind = mode;
    if (one) {
      if (pair(state, req, res)) {
        state.upload = req;
        attachBody(req, state.stream);
      }
      return;
    }
    if (req.method === 'GET') {
      pair(state, req, res);
      return;
    }
    state.requests.add(req);
    req.once('close', () => state.requests.delete(req));
    state.responses.add(res);
    res.once('close', () => state.responses.delete(res));
    if (mode === 'stream-up') {
      if (state.upload) {
        respond(res, 409);
        return;
      }
      state.upload = req;
      attachBody(req, state.stream);
      headers(res, selected, false);
      const seconds = selected.scStreamUpServerSecs ?? 30;
      if (seconds > 0) {
        state.keepAlive = setInterval(() => {
          // A response is padding only. Never accumulate padding behind a stalled reader.
          if (!res.writableNeedDrain && !res.destroyed) res.write(padding(selected));
        }, seconds * 1000);
        state.keepAlive.unref();
      }
      req.once('end', () => {
        clearInterval(state.keepAlive);
        res.end();
      });
      res.once('close', () => {
        if (!req.complete) state.stream.destroy();
      });
      return;
    }
    const sequence = Number(tail);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < state.next ||
      state.receiving.has(sequence) ||
      state.packets.has(sequence)
    ) {
      respond(res, 409);
      return;
    }
    if (
      sequence > state.next + selected.maxPosts ||
      state.receiving.size + state.packets.size >= selected.maxPosts
    ) {
      respond(res, 429);
      return;
    }
    state.receiving.add(sequence);
    let length = 0,
      chunks = [],
      done = false;
    const release = () => {
      if (done) return;
      done = true;
      state.receiving.delete(sequence);
      state.bytes = Math.max(0, state.bytes - length);
      chunks = [];
      clearTimeout(req.xhttpTimer);
    };
    req.xhttpTimer = setTimeout(() => {
      release();
      state.stream.destroy(failure('ERR_TIMEOUT', 'XHTTP packet upload timed out.', 'transport'));
    }, selected.timeout);
    req.on('data', (data) => {
      if (done) return;
      if (
        length + data.length > selected.maxPostBytes ||
        state.bytes + state.stream.readableLength + data.length > selected.maxBytes
      ) {
        release();
        respond(res, 413);
        state.stream.destroy(
          failure('ERR_LIMIT', 'XHTTP packet buffer exceeded its limit.', 'transport'),
        );
        return;
      }
      length += data.length;
      state.bytes += data.length;
      chunks.push(data);
    });
    req.once('aborted', () => {
      release();
      state.stream.destroy(failure('ERR_CLOSED', 'XHTTP packet upload was aborted.', 'transport'));
    });
    req.once('end', () => {
      if (done || state.stream.destroyed) return;
      done = true;
      clearTimeout(req.xhttpTimer);
      state.receiving.delete(sequence);
      let acknowledged = false;
      const ack = () => {
        if (!acknowledged && !res.destroyed) {
          acknowledged = true;
          respond(res, 200);
        }
      };
      state.packets.set(sequence, { data: Buffer.concat(chunks, length), ack });
      chunks = [];
      // Out-of-order uploads may be concurrent and must not deadlock one another.
      // In-order acknowledgements wait for space in the logical readable stream.
      if (sequence !== state.next) ack();
      pump(state);
    });
  }
  return {
    server,
    get stats() {
      return {
        sessions: streams.size,
        pending: [...sessions.values()].filter((state) => !state.paired).length,
        queuedBytes: [...sessions.values()].reduce(
          (sum, state) => sum + state.bytes + state.stream.readableLength,
          0,
        ),
        requests: bodies.size,
        sockets: sockets.size,
        http2Sessions: h2sessions.size,
      };
    },
    prepareUpdate(nextNetwork, nextLimits) {
      const next = settings(nextNetwork.option, nextLimits);
      if (
        nextNetwork.type !== 'xhttp' ||
        Boolean(next.tls) !== Boolean(config.tls) ||
        effectiveVersion(next) !== version
      )
        throw failure(
          'ERR_ROTATION',
          'A shared XHTTP listener must retain its HTTP version and TLS mode.',
          'rotation',
        );
      let nextSecure;
      try {
        nextSecure = next.tls ? tlsOptions(next.tls) : undefined;
        if (nextSecure) tls.createSecureContext(nextSecure);
      } catch (cause) {
        throw failure('ERR_TLS', 'Candidate XHTTP TLS material is invalid.', 'rotation', cause);
      }
      const previous = { config, secure };
      const apply = (value, material) => {
        if (material) server.setSecureContext(material);
        config = value;
        secure = material;
        server.headersTimeout = config.timeout;
      };
      return {
        commit: () => apply(next, nextSecure),
        rollback: () => apply(previous.config, previous.secure),
      };
    },
    destroy() {
      for (const stream of streams) stream.destroy();
      for (const session of h2sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
    },
  };
}
module.exports = { createListener };
