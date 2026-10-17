'use strict';

// HTTP/3 only. Requiring this module does not load node:quic.
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { isIP, SocketAddress } = require('node:net');
const { lookup } = require('node:dns');
const { createPrivateKey, X509Certificate } = require('node:crypto');
const { failure, normalizeError } = require('../../runtime/errors');
const { abortable } = require('../../runtime/abortable');

const error = (code, message, cause) => failure(code, message, 'http3', cause);
const closed = () => error('ERR_CLOSED', 'HTTP/3 stream closed.');
function identity(tls) {
  const certificate = new X509Certificate(tls.cert);
  const names = [...(certificate.subjectAltName ?? '').matchAll(/(?:^|, )DNS:([^,]+)/g)].map(
    (match) => match[1],
  );
  const rotatable = names.length > 0 && names.every((name) => !name.includes('*'));
  const value = {
    keys: createPrivateKey(tls.key),
    certs: Buffer.from(tls.cert),
    verifyPrivateKey: true,
  };
  return {
    sni: Object.fromEntries((rotatable ? names : ['*']).map((name) => [name, value])),
    rotatable,
  };
}
function native() {
  require('../quic').capability('http3');
  return require('node:quic');
}
function options(network, limits, server = false) {
  if (!network.option?.tls) throw error('ERR_TLS', 'HTTP/3 requires explicit TLS.');
  const tls = require('../index').tlsOptions(network.option.tls);
  const size = limits.maxBufferBytes ?? 1048576;
  const result = {
    alpn: server ? ['h3'] : 'h3',
    handshakeTimeout: limits.handshakeTimeoutMs ?? 10000,
    maxWindow: size,
    maxStreamWindow: size,
    truncatedReads: 'error',
    application: { maxHeaderPairs: 64, maxHeaderLength: 8192, maxFieldSectionSize: 8192 },
    transportParams: {
      maxIdleTimeout: 30000,
      initialMaxData: size,
      initialMaxStreamDataBidiLocal: size,
      initialMaxStreamDataBidiRemote: size,
      initialMaxStreamDataUni: 65536,
      initialMaxStreamsBidi: Math.min((limits.maxConnections ?? 256) * 3, 1024),
      // h3 control + QPACK encoder and decoder; raw QUIC's uni=0 is invalid here.
      initialMaxStreamsUni: 3,
    },
  };
  if (server) result.sni = identity(tls).sni;
  else {
    result.servername = network.option.tls.serverName ?? network.address;
    result.verifyPeer = tls.rejectUnauthorized ? 'auto' : 'manual';
    result.rejectUnauthorized = tls.rejectUnauthorized;
    if (tls.ca) result.ca = Buffer.from(tls.ca);
    if (tls.cert) result.certs = Buffer.from(tls.cert);
    if (tls.key) result.keys = createPrivateKey(tls.key);
  }
  return result;
}
function resolve(host, resolver = lookup) {
  if (isIP(host)) return Promise.resolve(host);
  return new Promise((yes, no) =>
    resolver(host, { all: false }, (cause, address) =>
      cause ? no(cause) : yes(Array.isArray(address) ? address[0]?.address : address),
    ),
  );
}
function validHeaders(headers, response = false) {
  if (!headers || typeof headers !== 'object') return false;
  const allowed = response ? [':status'] : [':method', ':path', ':scheme', ':authority'];
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    bytes += Buffer.byteLength(name + String(value));
    if (name.startsWith(':')) {
      if (!allowed.includes(name) || Array.isArray(value)) return false;
    } else if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      /^(connection|proxy-connection|keep-alive|upgrade|transfer-encoding|http2-settings)$/.test(
        name,
      )
    )
      return false;
    if (typeof value !== 'string' && !(response && name === ':status' && Number.isInteger(value)))
      return false;
    if (/[\x00-\x1f\x7f]/.test(String(value))) return false;
  }
  if (bytes > 8192 || Object.keys(headers).length > 64) return false;
  if (response)
    return (
      /^\d{3}$/.test(String(headers[':status'])) &&
      Number(headers[':status']) >= 200 &&
      Number(headers[':status']) <= 599
    );
  if (
    !/^[A-Z]+$/.test(headers[':method'] ?? '') ||
    headers[':scheme'] !== 'https' ||
    !/^\/[^\s#]*$/.test(headers[':path'] ?? '')
  )
    return false;
  const authority = headers[':authority'];
  if (typeof authority !== 'string' || !authority || /[\s/\\?#@]/.test(authority)) return false;
  try {
    if (!new URL('https://' + authority).hostname) return false;
  } catch {
    return false;
  }
  if (headers.host && headers.host !== authority) return false;
  if (headers.te && headers.te !== 'trailers') return false;
  return true;
}

// A real HTTP/3 request and response body, not an HTTP/2 session/socket.
// Every asynchronous writer operation has a classic stream callback owner.
class Body extends Duplex {
  constructor(limits = {}) {
    const size = Math.min(16384, limits.maxBufferBytes ?? 1048576);
    super({ allowHalfOpen: true, autoDestroy: false, highWaterMark: size });
    this.size = size;
    this.limit = limits.maxBufferBytes ?? 1048576;
    this.timeout = limits.handshakeTimeoutMs ?? 10000;
    this.lifetime = new AbortController();
    this.httpVersion = '3.0';
    this.stream = this; // Shared native request/response; never emit H1 Connection:close.
    this.outHeaders = {};
    this.on('error', () => {});
    this.once('end', () => {
      this.complete = true;
      this.normalClose();
    });
    this.once('finish', () => this.normalClose());
  }
  bind(raw, session) {
    this.raw = raw;
    this.session = session;
    raw.budget = this.size;
    this.writer = raw.writer;
    this.iterator = (async function* (size) {
      for await (const batch of raw)
        for (const chunk of batch)
          for (let offset = 0; offset < chunk.length; offset += size)
            yield Buffer.from(chunk.subarray(offset, offset + size));
    })(this.size);
    raw.onerror = (cause) => this.destroy(normalizeError(cause, 'http3'));
    raw.onreset = (cause) => {
      this.emit('aborted');
      this.destroy(error('ERR_CLOSED', 'HTTP/3 peer reset the request.', cause));
    };
    raw.onstopsending = (cause) =>
      this.destroy(error('ERR_CLOSED', 'HTTP/3 peer cancelled the response.', cause));
    raw.closed.then(
      () => {
        this.nativeClosed = true;
        this.normalClose();
      },
      (cause) => this.destroy(normalizeError(cause, 'http3')),
    );
    if (this.destroyed) raw.destroy();
    return this;
  }
  normalClose() {
    if (this.nativeClosed && this.readableEnded && this.writableFinished) this.destroy();
  }
  _read() {
    if (this.readEOF) return;
    this.readAgain = true;
    if (this.reading) return;
    this.reading = true;
    (async () => {
      await this.ready;
      while (!this.destroyed) {
        this.readAgain = false;
        const { value, done } = await this.iterator.next();
        if (done) {
          this.readEOF = true;
          this.push(null);
          break;
        }
        if (!this.push(value) && !this.readAgain) break;
      }
    })()
      .catch((cause) => this.destroy(normalizeError(cause, 'http3')))
      .finally(() => {
        this.reading = false;
        if (this.readAgain && !this.destroyed && !this.readEOF) this._read();
      });
  }
  _write(chunk, encoding, callback) {
    (async () => {
      await this.ready;
      if (this.destroyed) throw closed();
      if (chunk.length > this.limit) throw error('ERR_LIMIT', 'HTTP/3 write exceeds buffer limit.');
      for (let i = 0; i < chunk.length; i += this.size)
        await this.writer.write(chunk.subarray(i, i + this.size));
    })().then(
      () => callback(),
      (cause) => callback(normalizeError(cause, 'http3')),
    );
  }
  _final(callback) {
    (async () => {
      await this.ready;
      if (this.destroyed) throw closed();
      await this.writer.end();
    })().then(
      () => callback(),
      (cause) => callback(normalizeError(cause, 'http3')),
    );
  }
  _destroy(cause, callback) {
    this.lifetime.abort(cause ?? closed());
    clearTimeout(this.rejectTimer);
    this.raw?.destroy(cause ?? undefined);
    callback(cause);
  }
  setHeader(name, value) {
    this.outHeaders[name.toLowerCase()] = String(value);
  }
  writeHead(status) {
    if (!this.headersSent) {
      this.raw.sendHeaders({ ':status': String(status), ...this.outHeaders });
      this.headersSent = true;
      if (status >= 400) {
        // Reject early while bounding an unfinished/malicious request body.
        this.resume();
        this.rejectTimer = setTimeout(() => this.destroy(), this.timeout);
        this.rejectTimer.unref();
      }
    }
    return this;
  }
  flushHeaders() {}
}
function request(session, headers, limits) {
  const body = new Body(limits);
  body.ready = (async () => {
    if (!validHeaders(headers)) throw error('ERR_PROTOCOL', 'Invalid HTTP/3 request headers.');
    const pending = session.createBidirectionalStream({ budget: body.size });
    const deadline = AbortSignal.timeout(body.timeout);
    const signal = AbortSignal.any([deadline, body.lifetime.signal]);
    let raw;
    try {
      raw = await abortable(pending, signal);
      body.bind(raw, session);
      await abortable(raw.opened, signal);
    } catch (cause) {
      pending.then(
        (value) => value.destroy(),
        () => {},
      );
      raw?.destroy();
      if (deadline.aborted)
        throw error('ERR_TIMEOUT', 'HTTP/3 request stream credit timed out.', cause);
      if (body.lifetime.signal.aborted) throw body.lifetime.signal.reason;
      throw cause;
    }
    if (body.destroyed) throw closed();
    let responded = false;
    raw.onheaders = (value) => {
      if (responded || !validHeaders(value, true)) {
        body.destroy(error('ERR_PROTOCOL', 'Invalid HTTP/3 response headers.'));
        return;
      }
      responded = true;
      body.emit('response', value);
    };
    raw.oninfo = (value) => body.emit('information', value);
    raw.ontrailers = (value) => body.emit('trailers', value);
    raw.sendHeaders(headers); // Nonterminal, even for a streaming POST without a body option.
  })();
  body.ready.catch((cause) => body.destroy(normalizeError(cause, 'http3')));
  if (headers[':method'] === 'GET') body.end();
  return body;
}
async function connect(network, limits, entry) {
  const quic = native();
  const timeout = AbortSignal.timeout(
    limits.connectTimeoutMs ?? limits.handshakeTimeoutMs ?? 10000,
  );
  const signal = limits.signal ? AbortSignal.any([limits.signal, timeout]) : timeout;
  let endpoint, session;
  try {
    const address = await abortable(resolve(network.address, limits.lookup), signal);
    signal.throwIfAborted();
    endpoint = new quic.QuicEndpoint();
    endpoint.closed.catch(() => {});
    entry.endpoint = endpoint;
    session = await quic.connect(
      new SocketAddress({
        address,
        port: network.port,
        family: isIP(address) === 6 ? 'ipv6' : 'ipv4',
      }),
      { ...options(network, limits), endpoint },
    );
    entry.h3 = session;
    entry.disposeH3 = (force) => {
      if (force) {
        // Explicit close options are required to send CONNECTION_CLOSE;
        // destroy() without options can be silent in this pinned runtime.
        // Fixed Node exports no H3 error constants; RFC 9114 H3_NO_ERROR.
        session.destroy(undefined, { code: 0x100, type: 'application' });
        endpoint.close().catch(() => endpoint.destroy());
        return;
      }
      // Let stream RESETs and H3 GOAWAY reach the peer before releasing UDP.
      const timer = setTimeout(() => {
        session.destroy();
        endpoint.destroy();
      }, limits.handshakeTimeoutMs ?? 10000);
      timer.unref();
      session.close().then(
        () => {
          clearTimeout(timer);
          endpoint.destroy();
        },
        () => {
          clearTimeout(timer);
          session.destroy();
          endpoint.destroy();
        },
      );
    };
    session.closed
      .then(
        () => entry.destroy(),
        (cause) => entry.destroy(normalizeError(cause, 'http3')),
      )
      .finally(() => endpoint.close().catch(() => endpoint.destroy()));
    session.ongoaway = () => {
      entry.goaway = true;
      entry.retire();
    };
    const info = await abortable(session.opened, signal);
    if (info.protocol !== 'h3') throw error('ERR_PROTOCOL', 'Peer did not negotiate HTTP/3.');
    if (entry.closed) throw closed();
    entry.version = '3';
    entry.remoteAddress = info.remote.address;
    entry.request = (headers) => request(session, headers, limits);
  } catch (cause) {
    session?.destroy();
    endpoint?.destroy();
    if (timeout.aborted) throw error('ERR_TIMEOUT', 'HTTP/3 DNS/handshake timed out.', cause);
    const tlsFailure = (value) =>
      value &&
      (/cert|tls|validation/i.test(value.message ?? '') ||
        (value.type === 'transport' && value.errorCode >= 0x100n && value.errorCode <= 0x1ffn) ||
        tlsFailure(value.cause));
    if (tlsFailure(cause)) throw error('ERR_TLS', 'HTTP/3 TLS verification failed.', cause);
    throw normalizeError(cause, 'http3');
  }
}

function createServer(network, limits, handle) {
  const quic = native();
  let material = require('../index').tlsOptions(network.option.tls);
  let secure = options(network, limits, true),
    endpoint,
    closing = false;
  const rotatable = identity(material).rotatable;
  const sessions = new Set(),
    bodies = new Set(),
    seen = new WeakSet(),
    headerTimers = new Map(),
    firstHeaders = new Map();
  const server = new EventEmitter();
  server.listening = false;
  server.address = () => {
    if (!server.listening) return null;
    const a = endpoint.address.toJSON();
    return { address: a.address, port: a.port, family: a.family === 'ipv6' ? 'IPv6' : 'IPv4' };
  };
  server.validateSecureContext = (next) => {
    if (
      (!rotatable || !identity(next).rotatable) &&
      (String(next.cert) !== String(material.cert) || String(next.key) !== String(material.key))
    )
      throw error(
        'ERR_ROTATION',
        'Pinned HTTP/3 runtime cannot replace a wildcard/default TLS identity; use a new listener.',
      );
  };
  server.setSecureContext = (next) => {
    server.validateSecureContext(next);
    const sni = identity(next).sni;
    endpoint?.setSNIContexts(sni, { replace: true });
    secure = { ...secure, sni };
    material = next;
  };
  server.listen = (bind, host) => {
    if (endpoint?.destroyed) closing = false;
    if (typeof bind === 'number') bind = { port: bind, host };
    const stop = () => server.destroy();
    bind.signal?.addEventListener('abort', stop, { once: true });
    (async () => {
      const signal = bind.signal
        ? AbortSignal.any([bind.signal, AbortSignal.timeout(limits.handshakeTimeoutMs ?? 10000)])
        : AbortSignal.timeout(limits.handshakeTimeoutMs ?? 10000);
      const address = await abortable(
        resolve(bind.host ?? network.address ?? '0.0.0.0', limits.lookup),
        signal,
      );
      if (closing || signal.aborted) throw closed();
      endpoint = new quic.QuicEndpoint({
        address: { address, port: bind.port, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' },
        maxConnectionsTotal: limits.maxConnections ?? 256,
      });
      endpoint.closed.then(
        () => {
          server.listening = false;
          bind.signal?.removeEventListener('abort', stop);
          server.emit('close');
        },
        (cause) => server.emit('error', normalizeError(cause, 'http3')),
      );
      await quic.listen(
        (session) => {
          sessions.add(session);
          const ended = () => {
            sessions.delete(session);
            clearTimeout(firstHeaders.get(session));
            firstHeaders.delete(session);
            for (const body of bodies) if (body.session === session) body.destroy();
          };
          session.closed.then(ended, ended);
          session.opened.then(
            () => {
              if (session.destroyed) return;
              const timer = setTimeout(() => {
                firstHeaders.delete(session);
                session.destroy(error('ERR_TIMEOUT', 'HTTP/3 initial request headers timed out.'), {
                  type: 'application',
                  code: 0x10c,
                });
              }, limits.handshakeTimeoutMs ?? 10000);
              firstHeaders.set(session, timer);
            },
            () => {},
          );
          session.onstream = (raw) => {
            if (seen.has(raw)) return;
            const timer = setTimeout(() => {
              headerTimers.delete(raw);
              raw.destroy();
            }, limits.handshakeTimeoutMs ?? 10000);
            headerTimers.set(raw, timer);
            raw.closed.then(
              () => {
                clearTimeout(timer);
                headerTimers.delete(raw);
              },
              () => {
                clearTimeout(timer);
                headerTimers.delete(raw);
              },
            );
          };
        },
        {
          ...secure,
          endpoint,
          // Installed before onstream: the first request HEADERS may already arrive there.
          onheaders: function (headers) {
            const raw = this;
            if (seen.has(raw)) {
              raw.destroy();
              return;
            }
            seen.add(raw);
            clearTimeout(firstHeaders.get(raw.session));
            firstHeaders.delete(raw.session);
            clearTimeout(headerTimers.get(raw));
            headerTimers.delete(raw);
            const body = new Body(limits).bind(raw, raw.session);
            const path = raw.session?.path;
            body.socket = {
              remoteAddress: path?.remote.address,
              remotePort: path?.remote.port,
              localAddress: path?.local.address,
              localPort: path?.local.port,
              setTimeout() {},
            };
            raw.onheaders = () =>
              body.destroy(error('ERR_PROTOCOL', 'Duplicate HTTP/3 request headers.'));
            bodies.add(body);
            body.once('close', () => bodies.delete(body));
            if (
              closing ||
              bodies.size > (limits.maxConnections ?? 256) * 4 ||
              !validHeaders(headers)
            ) {
              body.writeHead(closing ? 503 : validHeaders(headers) ? 429 : 400);
              body.end();
              body.resume();
              return;
            }
            body.headers = headers;
            body.method = headers[':method'];
            body.url = headers[':path'];
            handle(body, body);
          },
        },
      );
      if (closing) {
        endpoint.destroy();
        return;
      }
      server.listening = true;
      server.emit('listening');
    })().catch((cause) => {
      endpoint?.destroy();
      server.emit('error', normalizeError(cause, 'http3'));
    });
    return server;
  };
  server.close = (callback) => {
    closing = true;
    server.listening = false;
    if (callback) {
      if (!endpoint || endpoint.destroyed) queueMicrotask(callback);
      else
        endpoint.closed.then(
          () => callback(),
          () => callback(),
        );
    }
    endpoint?.close().catch(() => {});
    return server;
  };
  server.destroy = () => {
    closing = true;
    for (const timer of headerTimers.values()) clearTimeout(timer);
    headerTimers.clear();
    for (const timer of firstHeaders.values()) clearTimeout(timer);
    firstHeaders.clear();
    for (const body of bodies) body.destroy();
    for (const session of sessions)
      session.destroy(undefined, { code: 0x100, type: 'application' });
    endpoint?.close().catch(() => endpoint.destroy());
  };
  server.h3Stats = () => ({ http3Sessions: sessions.size, http3Requests: bodies.size });
  return server;
}
module.exports = { connect, createServer, request, validHeaders };
