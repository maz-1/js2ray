'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const { tlsOptions } = require('../transports');
const { failure } = require('../runtime/errors');
const { CAPTURE } = require('../runtime/hooks');
const { watch } = require('../runtime/watch');

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

    (options[CAPTURE]?.runtime ?? runtime)
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
    unwatch();
  };
  const changed = (state) => {
    if (state === 'closing' || state === 'closed') open.destroy();
  };
  const unwatch = watch(runtime, 'state', changed);
  return open;
}

function createAgent(runtime, secure, options = {}) {
  const { outboundTag, inboundTag, signal, timeoutMs, targetTls, ...pool } = options;
  const agent = secure
    ? new https.Agent({ keepAlive: true, ...pool })
    : new http.Agent({ keepAlive: true, ...pool });
  const open = connector(runtime, { outboundTag, inboundTag, signal, timeoutMs, targetTls });
  const generationChanged = () => {
    for (const sockets of Object.values(agent.freeSockets))
      for (const socket of sockets) socket.destroy();
  };
  let unwatchGeneration = () => {};
  if (runtime[CAPTURE]) {
    const getName = agent.getName.bind(agent),
      addRequest = agent.addRequest.bind(agent);
    agent.getName = (settings) =>
      `${getName(settings)}:js2ray-generation-${settings[CAPTURE]?.id ?? runtime.generation}`;
    agent.addRequest = (request, settings, ...args) => {
      const scope = runtime[CAPTURE]();
      request.once('close', scope.release);
      try {
        return addRequest(request, { ...settings, [CAPTURE]: scope }, ...args);
      } catch (error) {
        scope.release();
        throw error;
      }
    };
    unwatchGeneration = watch(runtime, 'generation', generationChanged);
    agent.on('free', (socket, settings) => {
      if (
        settings[CAPTURE]?.id !== runtime.generation &&
        Object.values(agent.freeSockets).some((sockets) => sockets.includes(socket))
      )
        socket.destroy();
    });
  }
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
    unwatchGeneration();
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
  if (runtime[CAPTURE]) {
    const dispatcher = new undici.Agent(pool),
      children = new Map();
    const baseClose = dispatcher.close.bind(dispatcher),
      baseDestroy = dispatcher.destroy.bind(dispatcher);
    let closed = false;
    const retire = (id) => {
      for (const [generation, child] of children)
        if (generation !== id) {
          child
            .close()
            .finally(() => children.delete(generation))
            .catch(() => {});
        }
    };
    const unwatchGeneration = watch(runtime, 'generation', retire);
    dispatcher.dispatch = (settings, handler) => {
      if (closed) {
        handler.onError(failure('ERR_CLOSED', 'Dispatcher is closed.', 'http'));
        return false;
      }
      const scope = runtime[CAPTURE]();
      if (!children.has(scope.id))
        children.set(scope.id, createUndiciDispatcher(scope.runtime, { undici, ...options }));
      const wrapped = new Proxy(handler, {
        get(target, name) {
          const member = Reflect.get(target, name, target);
          if (typeof member !== 'function') return member;
          if (['onComplete', 'onError', 'onUpgrade'].includes(name))
            return (...args) => {
              scope.release();
              return member.apply(target, args);
            };
          return member.bind(target);
        },
      });
      try {
        return children.get(scope.id).dispatch(settings, wrapped);
      } catch (error) {
        scope.release();
        throw error;
      }
    };
    dispatcher.close = (callback) => {
      closed = true;
      unwatchGeneration();
      const result = Promise.all([...children.values()].map((child) => child.close())).then(
        () =>
          new Promise((resolve, reject) =>
            baseClose((error) => (error ? reject(error) : resolve())),
          ),
      );
      if (callback) {
        result.then(() => callback(null), callback);
        return;
      }
      return result;
    };
    dispatcher.destroy = (error, callback) => {
      if (typeof error === 'function') {
        callback = error;
        error = undefined;
      }
      closed = true;
      unwatchGeneration();
      const result = Promise.all([...children.values()].map((child) => child.destroy(error))).then(
        () =>
          new Promise((resolve, reject) =>
            baseDestroy(error, (cause) => (cause ? reject(cause) : resolve())),
          ),
      );
      if (callback) {
        result.then(() => callback(null), callback);
        return;
      }
      return result;
    };
    return dispatcher;
  }
  const open = connector(runtime, { outboundTag, inboundTag, signal, timeoutMs, targetTls });
  const dispatcher = new undici.Agent({ ...pool, connect: open });
  const close = dispatcher.close.bind(dispatcher),
    destroy = dispatcher.destroy.bind(dispatcher);
  dispatcher.close = (callback) => {
    const promise = new Promise((resolve, reject) =>
      close((error) => (error ? reject(error) : resolve())),
    ).finally(() => open.destroy());
    if (callback) {
      promise.then(() => callback(null), callback);
      return;
    }
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
