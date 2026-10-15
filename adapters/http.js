'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { tlsOptions } = require('../transports');
const { failure } = require('../runtime/errors');

function connector(runtime, settings = {}) {
  if (!runtime || typeof runtime.dial !== 'function')
    throw failure('ERR_CONFIG', 'Expected a runtime.', 'config');
  const timeoutMs = settings.timeoutMs ?? 20000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw failure('ERR_CONFIG', 'Expected a positive connection timeout.', 'config');
  const lifetime = new AbortController(),
    sockets = new Set();
  let destroyed = false;
  const open = (options, callback) => {
    const hostname = (options.hostname ?? options.host ?? '').replace(/^\[|\]$/g, ''),
      secure = options.protocol === 'https:';
    if (destroyed) {
      queueMicrotask(() => callback(failure('ERR_CLOSED', 'HTTP adapter is closed.', 'http')));
      return;
    }
    if (
      !['http:', 'https:'].includes(options.protocol) ||
      options.httpSocket ||
      options.socketPath ||
      options.localAddress
    ) {
      queueMicrotask(() =>
        callback(failure('ERR_UNSUPPORTED', 'Unsupported HTTP connector option.', 'http')),
      );
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      lifetime.signal,
      ...(settings.signal ? [settings.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    let socket,
      completed = false;
    const finish = (error, stream) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) socket?.destroy();
      callback(error ?? null, error ? null : stream);
    };
    const abort = () =>
      finish(
        controller.signal.reason?.code === 'ERR_TIMEOUT'
          ? controller.signal.reason
          : failure('ERR_CANCELLED', 'HTTP connection cancelled.', 'http', signal.reason),
      );
    const timer = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'HTTP connection budget exceeded.', 'http')),
      timeoutMs,
    );
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    const track = (stream) => {
      sockets.add(stream);
      stream.on('error', () => {});
      stream.once('close', () => sockets.delete(stream));
      return stream;
    };
    runtime
      .dial({
        host: hostname,
        port: Number(options.port || (secure ? 443 : 80)),
        outboundTag: settings.outboundTag,
        inboundTag: settings.inboundTag,
        signal,
      })
      .then(
        (raw) => {
          socket = track(raw);
          if (completed) {
            raw.destroy();
            return;
          }
          if (!secure) {
            finish(null, raw);
            return;
          }
          const name = settings.targetTls?.serverName ?? options.servername ?? hostname;
          const perRequest = {};
          for (const key of [
            'ca',
            'cert',
            'key',
            'pfx',
            'passphrase',
            'ciphers',
            'minVersion',
            'maxVersion',
            'rejectUnauthorized',
          ])
            if (options[key] !== undefined) perRequest[key] = options[key];
          try {
            const secureStream = track(
              tls.connect({
                ...tlsOptions(settings.targetTls),
                ...perRequest,
                socket: raw,
                host: hostname,
                servername: net.isIP(name) ? '' : name,
                ALPNProtocols: ['http/1.1'],
                checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(name, cert),
              }),
            );
            socket = secureStream;
            secureStream.once('error', (cause) =>
              finish(failure('ERR_TLS', 'Target TLS handshake failed.', 'tls', cause)),
            );
            secureStream.once('secureConnect', () => finish(null, secureStream));
          } catch (cause) {
            finish(failure('ERR_TLS', 'Cannot start target TLS.', 'tls', cause));
          }
        },
        (error) => finish(error),
      );
  };
  open.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    runtime.removeListener('state', changed);
  };
  const changed = (state) => {
    if (state === 'closing' || state === 'closed') open.destroy();
  };
  runtime.on('state', changed);
  return open;
}

function createAgent(runtime, secure, options = {}) {
  const { outboundTag, inboundTag, signal, timeoutMs, targetTls, ...pool } = options;
  const agent = secure
    ? new https.Agent({ keepAlive: true, ...pool })
    : new http.Agent({ keepAlive: true, ...pool });
  const open = connector(runtime, { outboundTag, inboundTag, signal, timeoutMs, targetTls });
  agent.createConnection = (settings, callback) => {
    open({ ...settings, protocol: secure ? 'https:' : 'http:' }, callback);
  };
  // Node removes the request AbortSignal before calling Agent, and defers its
  // close event until an asynchronous socket factory completes. Cancel the
  // pending factory when this specific request is destroyed.
  const createSocket = agent.createSocket.bind(agent);
  agent.createSocket = (request, settings, callback) => {
    const pending = new AbortController(),
      originalDestroy = request.destroy;
    const destroyRequest = function (...args) {
      pending.abort();
      return originalDestroy.apply(this, args);
    };
    request.destroy = destroyRequest;
    createSocket(request, { ...settings, signal: pending.signal }, (error, stream) => {
      if (request.destroy === destroyRequest) request.destroy = originalDestroy;
      callback(error, stream);
    });
    if (request.destroyed) pending.abort();
  };
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => {
    open.destroy();
    destroy();
  };
  return agent;
}
function createUndiciConnector(runtime, options) {
  return connector(runtime, options);
}
function createUndiciDispatcher(runtime, { undici, ...options } = {}) {
  if (typeof undici?.Agent !== 'function')
    throw failure(
      'ERR_CONFIG',
      'Pass the supported optional Undici module as { undici }.',
      'config',
    );
  const { outboundTag, inboundTag, signal, timeoutMs, targetTls, ...pool } = options;
  if (pool.connect !== undefined || pool.factory !== undefined)
    throw failure(
      'ERR_CONFIG',
      'Dispatcher connection factories are owned by this adapter.',
      'config',
    );
  const open = connector(runtime, { outboundTag, inboundTag, signal, timeoutMs, targetTls });
  const dispatcher = new undici.Agent({ ...pool, connect: open });
  const close = dispatcher.close.bind(dispatcher),
    destroy = dispatcher.destroy.bind(dispatcher);
  dispatcher.close = (...args) => {
    const promise = close(...args);
    Promise.resolve(promise)
      .finally(() => open.destroy())
      .catch(() => {});
    return promise;
  };
  dispatcher.destroy = (...args) => {
    open.destroy();
    return destroy(...args);
  };
  return dispatcher;
}
module.exports = {
  createHttpAgent: (runtime, options) => createAgent(runtime, false, options),
  createHttpsAgent: (runtime, options) => createAgent(runtime, true, options),
  createUndiciConnector,
  createUndiciDispatcher,
};
