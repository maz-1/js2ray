'use strict';
const net = require('node:net');
const { once } = require('node:events');
const { failure } = require('../../runtime/errors');
const handshake = require('./handshake');
const { RealityStream } = require('./stream');
const { watch } = require('../inbound');
async function client(raw, network, options) {
  try {
    const result = await handshake.client(raw, network.option.reality, options);
    return new RealityStream(raw, result, {
      ...options,
      manual: Boolean(network[Symbol.for('js2ray.vision')]),
    });
  } catch (cause) {
    raw.destroy();
    throw cause.phase ? cause : failure('ERR_TLS', 'REALITY handshake failed.', 'reality', cause);
  }
}
async function targetConnect(dest, options, signal) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(dest);
  const raw = new net.Socket({ allowHalfOpen: true });
  raw.on('error', () => {});
  const abort = () =>
    raw.destroy(failure('ERR_CANCELLED', 'REALITY target connection cancelled.', 'reality'));
  const timer = setTimeout(
    () => raw.destroy(failure('ERR_TIMEOUT', 'REALITY target connection timed out.', 'reality')),
    options.connectTimeoutMs ?? 10000,
  );
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted)
      throw failure('ERR_CANCELLED', 'REALITY target connection cancelled.', 'reality');
    raw.connect({ host: match[1] || match[2], port: Number(match[3]), lookup: options.lookup });
    await once(raw, 'connect');
    return raw;
  } catch (cause) {
    raw.destroy();
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
function createListener(network, onConnection, options = {}) {
  const connections = new Set();
  const tasks = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    const controller = new AbortController();
    const limits = options,
      settings = network.option.reality;
    const observer = watch(raw, limits, 'reality');
    const entry = { raw, target: undefined, controller, observer };
    connections.add(entry);
    raw.on('error', () => {});
    const stop = () => {
      controller.abort();
      entry.target?.destroy();
      raw.destroy();
    };
    raw.once('close', () => {
      connections.delete(entry);
      controller.abort();
      entry.target?.destroy();
    });
    if (connections.size > (limits.maxConnections ?? 1024)) {
      observer.reject();
      return stop();
    }
    const timer = setTimeout(() => {
      observer.timeout();
      stop();
    }, limits.handshakeTimeoutMs ?? 10000);
    const pending = (async () => {
      try {
        observer.cover();
        let target;
        try {
          target = await targetConnect(settings.dest, limits, controller.signal);
        } catch (cause) {
          observer.cover(true);
          throw failure(
            cause.code === 'ERR_CANCELLED'
              ? 'ERR_CANCELLED'
              : cause.code === 'ERR_TIMEOUT'
                ? 'ERR_TIMEOUT'
                : 'ERR_TRANSPORT',
            'REALITY cover connection failed.',
            'inbound',
            cause,
          );
        }
        entry.target = target;
        const result = await handshake.server(raw, settings, target, {
          ...limits,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (raw.destroyed || controller.signal.aborted) return;
        if (result.fallback) {
          observer.fallback();
          raw.setTimeout(limits.idleTimeoutMs || limits.handshakeTimeoutMs || 10000, stop);
          raw.once('end', () => target.end());
          target.once('end', () => raw.end());
          target.once('error', stop);
          // A clean target EOF must flush queued fallback bytes before FIN.
          target.once('close', (hadError) => {
            if (hadError) stop();
            else raw.end();
          });
          raw.pipe(target).pipe(raw);
          return;
        }
        target.destroy();
        entry.target = undefined;
        const stream = new RealityStream(raw, result, { ...limits, manual: true });
        observer.success();
        onConnection(stream);
      } catch (cause) {
        observer.fail(
          cause.phase
            ? cause
            : failure('ERR_TLS', 'Inbound REALITY handshake failed.', 'inbound', cause),
        );
        stop();
      } finally {
        clearTimeout(timer);
      }
    })();
    tasks.add(pending);
    pending.finally(() => tasks.delete(pending));
  });
  return {
    server,
    prepareUpdate(nextNetwork, nextOptions) {
      if (nextNetwork.type !== 'tcp' || !nextNetwork.option?.reality)
        throw failure(
          'ERR_ROTATION',
          'A shared REALITY listener must retain its security type.',
          'rotation',
        );
      const previous = { network, options };
      return {
        commit: () => {
          network = nextNetwork;
          options = nextOptions;
        },
        rollback: () => {
          network = previous.network;
          options = previous.options;
        },
      };
    },
    destroy() {
      for (const entry of connections) {
        entry.observer.cancel();
        entry.controller.abort();
        entry.target?.destroy();
        entry.raw.destroy();
      }
    },
  };
}
async function inspectCover(config, options = {}) {
  const crypto = require('node:crypto'),
    keys = require('./crypto');
  const privateKey = keys.privateKey(Buffer.from(config.privateKey, 'base64url'));
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url');
  const results = [];
  for (const serverName of config.serverNames) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(
        (options.connectTimeoutMs ?? 10000) + (options.handshakeTimeoutMs ?? 10000),
      ),
      ...(options.signal ? [options.signal] : []),
    ]);
    const raw = await targetConnect(config.dest, options, signal);
    const own = handshake.clientHello(
      { publicKey, serverName, shortId: config.shortIds[0], fingerprint: 'chrome120' },
      keys.keyPair(),
    );
    try {
      const wire = require('./wire');
      await require('../../runtime/streams').write(raw, wire.record(22, own.hello));
      const flight = await handshake.targetFlight(
        handshake.reader(raw, { ...options, signal }),
        wire.hello(own.hello),
      );
      results.push({
        ok: true,
        suite: flight.suite.algorithm,
        layout: flight.layout,
        recordLengths: flight.lengths,
        requiredLengths: flight.requiredLengths,
      });
    } finally {
      own.auth.fill(0);
      raw.destroy();
    }
  }
  return results;
}
module.exports = { client, createListener, inspectCover };
