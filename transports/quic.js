'use strict';

const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const { isIP, SocketAddress } = require('node:net');
const { lookup: dnsLookup } = require('node:dns');
const { createPrivateKey } = require('node:crypto');
const { failure, normalizeError } = require('../runtime/errors');

// isBuiltin does not load the module or emit its experimental warning.
function capability(phase = 'quic') {
  if (!require('node:module').isBuiltin('node:quic'))
    throw failure(
      'ERR_UNSUPPORTED',
      process.versions.ngtcp2
        ? 'Native QUIC is disabled; start this Node.js build with --experimental-quic.'
        : 'This Node.js runtime was built without native QUIC; use a QUIC-enabled build with --experimental-quic.',
      phase,
    );
}
function guard(config) {
  const check = (network) => {
    if (network.type === 'quic') capability();
    if (network.type === 'xhttp' && network.option?.httpVersion === '3') capability('http3');
    if (network.option?.downloadSettings) check(network.option.downloadSettings);
  };
  for (const bound of [...config.inbounds, ...config.outbounds])
    for (const network of bound.networks ?? []) check(network);
}
function settings(network, options, server = false) {
  const tls = require('./index').tlsOptions(network.option?.tls);
  const alpn = network.option?.tls?.alpn ?? ['h2', 'http/1.1'];
  const limit = options.maxBufferBytes ?? 1024 * 1024;
  const out = {
    alpn: server ? alpn : alpn[0],
    handshakeTimeout: options.handshakeTimeoutMs ?? 10000,
    maxWindow: limit,
    maxStreamWindow: limit,
    streamIdleTimeout: 0,
    truncatedReads: 'error',
    transportParams: {
      maxIdleTimeout: 30000,
      initialMaxData: limit,
      initialMaxStreamDataBidiLocal: limit,
      initialMaxStreamDataBidiRemote: limit,
      initialMaxStreamsBidi: server ? (options.maxConnections ?? 1024) : 1,
      initialMaxStreamsUni: 0,
    },
  };
  if (server) {
    out.sni = {
      '*': {
        keys: createPrivateKey(tls.key),
        certs: Buffer.from(tls.cert),
        verifyPrivateKey: true,
      },
    };
  } else {
    out.servername = network.option?.tls?.serverName ?? network.address;
    out.verifyPeer = tls.rejectUnauthorized ? 'auto' : 'manual';
    out.rejectUnauthorized = tls.rejectUnauthorized;
    if (tls.ca) out.ca = Buffer.from(tls.ca);
    if (tls.cert) out.certs = Buffer.from(tls.cert);
    if (tls.key) out.keys = createPrivateKey(tls.key);
  }
  return out;
}

function wrap(raw, session, options, owned = false) {
  const limit = options.maxBufferBytes ?? 1024 * 1024;
  const size = Math.min(65536, limit);
  raw.budget = size;
  const writer = raw.writer;
  const iterator = (async function* () {
    for await (const chunks of raw)
      for (const chunk of chunks)
        for (let offset = 0; offset < chunk.length; offset += size)
          yield Buffer.from(chunk.subarray(offset, offset + size));
  })();
  let reading = false;
  let readAgain = false;
  let timer;
  let timeout = options.idleTimeoutMs ?? 0;
  const activity = () => {
    clearTimeout(timer);
    if (timeout) {
      timer = setTimeout(() => stream.emit('timeout'), timeout);
      timer.unref();
    }
  };
  let nativeClosed = false;
  const finishNormally = () => {
    if (nativeClosed && stream.readableEnded && stream.writableFinished) stream.destroy();
  };
  const stream = new Duplex({
    allowHalfOpen: true,
    autoDestroy: false,
    highWaterMark: size,
    read() {
      readAgain = true;
      if (reading) return;
      reading = true;
      (async () => {
        try {
          while (!stream.destroyed) {
            readAgain = false;
            const { value, done } = await iterator.next();
            activity();
            if (done) {
              stream.push(null);
              break;
            }
            if (!stream.push(value) && !readAgain) break;
          }
        } catch (cause) {
          stream.destroy(normalizeError(cause, 'quic'));
        } finally {
          reading = false;
          if (readAgain && !stream.destroyed && !stream.readableEnded) stream._read();
        }
      })();
    },
    write(chunk, encoding, callback) {
      (async () => {
        for (let offset = 0; offset < chunk.length; offset += size) {
          await writer.write(chunk.subarray(offset, offset + size));
          activity();
        }
      })().then(
        () => callback(),
        (cause) => callback(normalizeError(cause, 'quic')),
      );
    },
    final(callback) {
      writer.end().then(
        () => callback(),
        (cause) => callback(normalizeError(cause, 'quic')),
      );
    },
    destroy(error, callback) {
      clearTimeout(timer);
      raw.destroy(error ?? undefined);
      if (owned) {
        if (nativeClosed && !error) session.close().catch(() => {});
        else session.destroy();
      }
      callback(error);
    },
  });
  // Internal normal-close hook used by relays; public destroy remains immediate.
  stream[Symbol.for('js2ray.quicGracefulClose')] = finishNormally;
  stream.on('end', finishNormally);
  stream.on('finish', finishNormally);
  stream.on('error', (cause) => stream.destroy(cause));
  raw.onerror = (cause) => stream.destroy(normalizeError(cause, 'quic'));
  // Native clean close can precede draining the iterator's final buffered batch.
  raw.closed.then(
    () => {
      nativeClosed = true;
      finishNormally();
    },
    (cause) => stream.destroy(normalizeError(cause, 'quic')),
  );
  session.opened.then(
    ({ local, remote }) => {
      Object.assign(stream, {
        localAddress: local.address,
        localPort: local.port,
        remoteAddress: remote.address,
        remotePort: remote.port,
      });
    },
    () => {},
  );
  stream.setTimeout = (ms, callback) => {
    timeout = ms;
    if (callback) stream.once('timeout', callback);
    activity();
    return stream;
  };
  for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    stream[method] = () => stream;
  activity();
  return stream;
}

function resolveHost(host, lookup = dnsLookup) {
  return new Promise((resolve, reject) => {
    if (isIP(host)) return resolve(host);
    lookup(host, { all: false }, (error, address) => {
      if (error) return reject(error);
      resolve(Array.isArray(address) ? address[0]?.address : address);
    });
  });
}

async function connect(network, options = {}) {
  capability();
  const quic = require('node:quic');
  const controller = new AbortController();
  const { signal } = options;
  let endpoint, session, timer;
  const abort = () =>
    controller.abort(failure('ERR_CANCELLED', 'QUIC dial cancelled.', 'quic', signal.reason));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const cancelled = new Promise((resolve, reject) => {
    const fail = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', fail, { once: true });
    if (controller.signal.aborted) fail();
  });
  timer = setTimeout(
    () => controller.abort(failure('ERR_TIMEOUT', 'QUIC dial timed out.', 'quic')),
    options.connectTimeoutMs ?? 10000,
  );
  try {
    const address = await Promise.race([resolveHost(network.address, options.lookup), cancelled]);
    controller.signal.throwIfAborted();
    endpoint = new quic.QuicEndpoint();
    endpoint.closed.catch(() => {});
    session = await quic.connect(
      new SocketAddress({
        address,
        port: network.port,
        family: isIP(address) === 6 ? 'ipv6' : 'ipv4',
      }),
      {
        ...settings(network, options),
        endpoint,
      },
    );
    session.closed.catch(() => {}).finally(() => endpoint.destroy());
    session.onstream = (raw) => raw.destroy();
    try {
      await Promise.race([session.opened, cancelled]);
    } catch (cause) {
      if (!cause?.phase && /cert|tls|validation/i.test(cause?.message ?? ''))
        throw failure('ERR_TLS', 'QUIC TLS verification/handshake failed.', 'quic', cause);
      throw cause;
    }
    const raw = await Promise.race([
      session.createBidirectionalStream({
        budget: Math.min(65536, options.maxBufferBytes ?? 1024 * 1024),
      }),
      cancelled,
    ]);
    return wrap(raw, session, options, true);
  } catch (cause) {
    session?.destroy();
    endpoint?.destroy();
    throw cause?.phase ? cause : normalizeError(cause, 'quic');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function createListener(network, onConnection, options = {}) {
  capability();
  const quic = require('node:quic');
  let secure = settings(network, options, true);
  let endpoint;
  let closing = false;
  const sessions = new Set(),
    streams = new Set();
  const server = new EventEmitter();
  server.listening = false;
  server.address = () => {
    if (!server.listening) return null;
    const address = endpoint.address.toJSON();
    return {
      address: address.address,
      port: address.port,
      family: address.family === 'ipv6' ? 'IPv6' : 'IPv4',
    };
  };
  server.listen = (bind, host) => {
    if (typeof bind === 'number') bind = { port: bind, host };
    const stop = () => destroy();
    bind.signal?.addEventListener('abort', stop, { once: true });
    if (bind.signal?.aborted) {
      queueMicrotask(stop);
      return server;
    }
    (async () => {
      const address = await resolveHost(bind.host ?? network.address, options.lookup);
      if (closing) {
        server.emit('close');
        return;
      }
      endpoint = new quic.QuicEndpoint({
        address: { address, port: bind.port, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' },
        maxConnectionsTotal: options.maxConnections ?? 1024,
      });
      endpoint.closed.then(
        () => {
          bind.signal?.removeEventListener('abort', stop);
          server.listening = false;
          server.emit('close');
        },
        (cause) => server.emit('error', normalizeError(cause, 'quic')),
      );
      await quic.listen(
        (session) => {
          sessions.add(session);
          session.closed.catch(() => {}).finally(() => sessions.delete(session));
          session.onstream = (raw) => {
            if (
              closing ||
              raw.direction !== 'bidi' ||
              streams.size >= (options.maxConnections ?? 1024)
            ) {
              raw.destroy();
              return;
            }
            const stream = wrap(raw, session, options);
            streams.add(stream);
            stream.once('close', () => streams.delete(stream));
            const observer = require('./inbound').watch(stream, options, 'quic');
            observer.success();
            onConnection(stream);
          };
        },
        { ...secure, endpoint },
      );
      if (closing) {
        endpoint.destroy();
        return;
      }
      server.listening = true;
      server.emit('listening');
    })().catch((cause) => {
      endpoint?.destroy();
      server.emit('error', normalizeError(cause, 'quic'));
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
  function destroy() {
    closing = true;
    for (const stream of streams) stream.destroy();
    for (const session of sessions) session.destroy();
    endpoint?.destroy();
  }
  return {
    server,
    destroy,
    prepareUpdate(nextNetwork, nextOptions) {
      if (
        nextNetwork.type !== 'quic' ||
        JSON.stringify(network.option?.tls?.alpn) !== JSON.stringify(nextNetwork.option?.tls?.alpn)
      )
        throw failure(
          'ERR_ROTATION',
          'Shared QUIC listener must retain its ALPN and transport.',
          'rotation',
        );
      for (const field of new Set([...Object.keys(options), ...Object.keys(nextOptions)])) {
        if (typeof options[field] === 'function' || typeof nextOptions[field] === 'function')
          continue;
        if (JSON.stringify(options[field]) !== JSON.stringify(nextOptions[field]))
          throw failure(
            'ERR_ROTATION',
            `Shared QUIC listener cannot hot-update ${field}; use a new listener.`,
            'rotation',
          );
      }
      let next;
      try {
        next = settings(nextNetwork, nextOptions, true);
        require('node:tls').createSecureContext(
          require('./index').tlsOptions(nextNetwork.option?.tls),
        );
      } catch (cause) {
        throw failure('ERR_TLS', 'Invalid candidate QUIC TLS identity.', 'rotation', cause);
      }
      const previous = { network, options, secure };
      const apply = (n, o, s) => {
        endpoint?.setSNIContexts(s.sni);
        network = n;
        options = o;
        secure = s;
      };
      return {
        commit: () => apply(nextNetwork, nextOptions, next),
        rollback: () => apply(previous.network, previous.options, previous.secure),
      };
    },
  };
}
module.exports = { capability, guard, connect, createListener };
