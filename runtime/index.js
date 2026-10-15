'use strict';

const { EventEmitter } = require('node:events');
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');
const { normalizeConfig, host, port } = require('../config');
const { createStorage } = require('../core/storage');
const { createVMess } = require('../protocols/vmess');
const socks = require('../protocols/socks/stream');
const vless = require('../protocols/vless');
const { connect, createListener } = require('../transports');
const { relay, legacyDuplex } = require('./streams');
const { Js2rayError, failure } = require('./errors');
const { FramedDatagram, directDatagram } = require('./datagram');

class Runtime extends EventEmitter {
  #state = 'created';
  #config;
  #options;
  #servers = [];
  #streams = new Set();
  #pending = new Set();
  #lifetime = new AbortController();
  #starting;
  #closing;
  #vmess;
  #clients = new Map();
  #storage;

  constructor(config, options = {}) {
    super();
    if (options.lookup !== undefined && typeof options.lookup !== 'function')
      throw failure('ERR_CONFIG', 'Expected a DNS lookup function.', 'config');
    this.#config = normalizeConfig(config, options);
    this.#options = options;
    this.#storage = createStorage(this.#config.storage);
    this.#storage.on('storageError', (error) => this.#report(error));
  }

  get state() {
    return this.#state;
  }
  get listenersInfo() {
    return this.#servers.map(({ server, tag }) => ({ tag, address: server.address() }));
  }
  get stats() {
    return {
      state: this.#state,
      connections: this.#streams.size,
      pendingDials: this.#pending.size,
      listeners: this.#servers.length,
    };
  }
  get protocols() {
    return this.#vmess ? { vmess: this.#vmess } : {};
  }

  #setState(state) {
    this.#state = state;
    this.emit('state', state);
  }
  #report(error) {
    const logger = this.#options.logger ?? this.#config.debug;
    try {
      if (typeof logger === 'function')
        logger(error.toJSON?.() ?? { code: 'ERR_INTERNAL', message: 'Runtime operation failed.' });
      else
        logger?.error?.(
          error.toJSON?.() ?? { code: 'ERR_INTERNAL', message: 'Runtime operation failed.' },
        );
    } catch {
      /* A host logger cannot own the runtime's lifecycle. */
    }
    this.emit('diagnostic', error);
  }
  #track(stream) {
    if (this.#streams.has(stream)) return stream;
    this.#streams.add(stream);
    stream.on('error', () => {});
    stream.once('close', () => {
      this.#streams.delete(stream);
      this.emit('connectionClosed');
    });
    const idle = this.#config.limits.idleTimeoutMs;
    if (idle && typeof stream.setTimeout === 'function')
      stream.setTimeout(idle, () =>
        stream.destroy(failure('ERR_TIMEOUT', 'Connection was idle.', 'transport')),
      );
    return stream;
  }

  start() {
    if (this.#state === 'running') return Promise.resolve(this);
    if (this.#state === 'starting') return this.#starting;
    if (this.#state !== 'created')
      return Promise.reject(
        failure('ERR_CLOSED', 'A closed runtime cannot be restarted.', 'runtime'),
      );
    const started = Promise.withResolvers();
    this.#starting = started.promise;
    this.#setState('starting');
    this.#start().then(started.resolve, started.reject);
    return this.#starting;
  }

  async #start() {
    try {
      if (this.#lifetime.signal.aborted)
        throw failure('ERR_CANCELLED', 'Startup was cancelled.', 'runtime');
      this.#storage.start();
      this.#vmess = createVMess({
        storage: this.#storage,
        events: this,
        limits: this.#config.limits,
        logger: () => this.#report(failure('ERR_PROTOCOL', 'VMess processing failed.', 'protocol')),
      });
      for (const bound of this.#config.outbounds) {
        if (bound.protocol === 'vmess')
          this.#clients.set(bound.tag, this.#vmess.client(bound, this.#legacyTransport(bound)));
      }
      for (const bound of this.#config.inbounds) {
        const handler =
          bound.protocol === 'vmess'
            ? this.#vmess.server(bound, this.#legacyDial(bound))
            : undefined;
        for (const network of bound.networks) {
          if (this.#lifetime.signal.aborted)
            throw failure('ERR_CANCELLED', 'Startup was cancelled.', 'runtime');
          const listener = createListener(
            network,
            (socket) => {
              if (
                this.#state !== 'running' ||
                this.#streams.size >= this.#config.limits.maxConnections
              )
                return socket.destroy();
              this.#track(socket);
              if (handler) this.#acceptLegacy(socket, handler);
              else if (bound.protocol === 'vless') this.#acceptVless(socket, bound);
              else this.#acceptSocks(socket, bound);
            },
            this.#config.limits,
          );
          const { server } = listener;
          server.on('error', (error) =>
            this.#report(failure('ERR_LISTEN', 'Inbound listener failed.', 'inbound', error)),
          );
          this.#servers.push({ server, tag: bound.tag, destroy: listener.destroy });
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              server.removeListener('listening', ready);
              server.removeListener('error', error);
              this.#lifetime.signal.removeEventListener('abort', cancelled);
            };
            const error = (cause) => {
              cleanup();
              reject(failure('ERR_LISTEN', 'Cannot start inbound listener.', 'inbound', cause));
            };
            const cancelled = () => {
              cleanup();
              reject(failure('ERR_CANCELLED', 'Startup was cancelled.', 'runtime'));
            };
            const ready = () => {
              cleanup();
              resolve();
            };
            server.once('error', error);
            server.once('listening', ready);
            this.#lifetime.signal.addEventListener('abort', cancelled, { once: true });
            server.listen({
              host: network.address,
              port: network.port,
              signal: this.#lifetime.signal,
            });
          });
        }
      }
      if (this.#lifetime.signal.aborted)
        throw failure('ERR_CANCELLED', 'Startup was cancelled.', 'runtime');
      this.#setState('running');
      return this;
    } catch (error) {
      if (!this.#closing) {
        this.#closing = Promise.resolve()
          .then(() => this.#cleanup(0))
          .finally(() => this.#setState('closed'));
        this.#setState('closing');
        this.#lifetime.abort();
        await this.#closing;
      }
      throw error instanceof Js2rayError
        ? error
        : failure('ERR_START', 'Runtime startup failed.', 'runtime', error);
    }
  }

  async #acceptSocks(socket, bound) {
    try {
      const remote = await socks.server(
        socket,
        bound,
        (target) => this.dial({ ...target, inboundTag: bound.tag }),
        { signal: this.#lifetime.signal, timeoutMs: this.#config.limits.handshakeTimeoutMs },
      );
      if (socket.destroyed) remote.destroy();
      else relay(socket, remote);
    } catch (error) {
      socket.destroy();
      this.#report(error);
    }
  }

  async #acceptVless(socket, bound) {
    try {
      const target = await vless.readRequest(socket, bound, {
        signal: this.#lifetime.signal,
        timeoutMs: this.#config.limits.handshakeTimeoutMs,
      });
      if (target.command === 2) {
        const remote = await this.openDatagram({
          host: target.host,
          port: target.port,
          inboundTag: bound.tag,
        });
        if (socket.destroyed) return remote.destroy();
        await require('./streams').write(socket, Buffer.from([0, 0]));
        const local = this.#track(
          new FramedDatagram(socket, target, this.#config.limits.maxBufferBytes),
        );
        const pump = async (source, destination) => {
          try {
            for await (const message of source) await destination.send(message.data);
          } finally {
            source.destroy();
            destination.destroy();
          }
        };
        pump(local, remote).catch((error) => this.#report(error));
        pump(remote, local).catch((error) => this.#report(error));
        return;
      }
      const remote = await this.dial({
        host: target.host,
        port: target.port,
        inboundTag: bound.tag,
      });
      if (socket.destroyed) return remote.destroy();
      await require('./streams').write(socket, Buffer.from([0, 0]));
      relay(socket, remote);
    } catch (error) {
      socket.destroy();
      this.#report(error);
    }
  }

  #acceptLegacy(socket, handler) {
    socket.localMessage = (data) => {
      if (socket.writableLength + data.length > this.#config.limits.maxBufferBytes)
        return socket.destroy(
          failure('ERR_LIMIT', 'Inbound send queue exceeded its limit.', 'protocol'),
        );
      const writable = socket.write(data);
      if (!writable) socket.app?.remote?.pause();
      return writable;
    };
    socket.localClose = () => socket.destroy();
    socket.on('drain', () => socket.app?.remote?.resume());
    const connection = handler(socket, socket.remoteAddress);
    const timer = setTimeout(() => {
      if (!socket.app?._isHeaderRecv) socket.destroy();
    }, this.#config.limits.handshakeTimeoutMs);
    socket.on('data', (data) => {
      try {
        connection.message(data);
      } catch (error) {
        this.#report(failure('ERR_PROTOCOL', 'Invalid VMess request.', 'protocol', error));
        socket.destroy();
      }
    });
    socket.once('close', () => {
      clearTimeout(timer);
      connection.close();
    });
    socket.once('end', () => socket.app?.remote?.end());
  }

  #legacyDial(bound) {
    const runtime = this;
    return function (address, destinationPort, cmd, connected, message, closed) {
      let remote;
      let destroyed = false;
      const inbound = this;
      if (cmd !== 1) {
        queueMicrotask(closed);
        return { message() {}, close() {} };
      }
      runtime.dial({ host: address, port: destinationPort, inboundTag: bound.tag }).then(
        (stream) => {
          remote = stream;
          if (destroyed) return remote.destroy();
          remote.on('data', message);
          remote.once('end', () => inbound.end?.());
          remote.once('close', closed);
          connected();
          if (inbound.readableEnded) remote.end();
        },
        () => closed(),
      );
      return {
        message: (data) => {
          if (!remote || destroyed) return;
          if (remote.writableLength + data.length > runtime.#config.limits.maxBufferBytes)
            return remote.destroy(
              failure('ERR_LIMIT', 'VMess relay send queue exceeded its limit.', 'protocol'),
            );
          const writable = remote.write(data);
          if (!writable) {
            inbound.pause?.();
            remote.once('drain', () => inbound.resume?.());
          }
          return writable;
        },
        pause() {
          remote?.pause();
        },
        resume() {
          remote?.resume();
        },
        end() {
          remote?.end();
        },
        close() {
          destroyed = true;
          remote?.destroy();
        },
      };
    };
  }

  #legacyTransport(bound) {
    return (address, destinationPort, selected, ready, message, closed) => {
      let socket;
      let destroyed = false;
      const pending = new AbortController();
      const network =
        typeof selected === 'object'
          ? selected
          : bound.networks.find(
              (item) => item.address === address && item.port === destinationPort,
            );
      const adapter = {
        onTransport: undefined,
        message(data) {
          return socket?.write(data);
        },
        close() {
          destroyed = true;
          pending.abort();
          socket?.destroy();
        },
      };
      connect(network, {
        ...this.#config.limits,
        signal: AbortSignal.any([pending.signal, this.#lifetime.signal]),
        lookup: this.#options.lookup,
      }).then(
        (stream) => {
          socket = stream;
          if (destroyed) return socket.destroy();
          adapter.onTransport?.(socket);
          socket.on('data', (data) => {
            try {
              message(data);
            } catch (cause) {
              this.#report(failure('ERR_PROTOCOL', 'Invalid VMess response.', 'protocol', cause));
              adapter.close();
            }
          });
          socket.once('close', closed);
          try {
            ready();
          } catch (cause) {
            this.#report(
              failure('ERR_PROTOCOL', 'Cannot encode VMess request.', 'protocol', cause),
            );
            adapter.close();
          }
        },
        () => closed(),
      );
      return adapter;
    };
  }

  dial(target) {
    return this.#dial(target, false);
  }
  openDatagram(target) {
    return this.#dial(target, true);
  }

  async #dial(target, datagram) {
    if (this.#state !== 'running')
      throw failure('ERR_STATE', 'Runtime must be running before dialing.', 'runtime');
    if (!target || !host(target.host) || !port(target.port))
      throw failure('ERR_TARGET', 'Invalid connection target.', 'config');
    target = { ...target, host: isIP(target.host) ? target.host : domainToASCII(target.host) };
    if (target.signal !== undefined && !(target.signal instanceof AbortSignal))
      throw failure('ERR_TARGET', 'Expected an AbortSignal.', 'config');
    if (target.network && target.network !== (datagram ? 'udp' : 'tcp'))
      throw failure('ERR_UNSUPPORTED', 'Use dial for TCP and openDatagram for UDP.', 'config');
    if (
      this.#pending.size >= this.#config.limits.maxPendingDials ||
      this.#streams.size + this.#pending.size >= this.#config.limits.maxConnections
    )
      throw failure('ERR_LIMIT', 'Connection limit reached.', 'runtime');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      controller.signal,
      ...(target.signal ? [target.signal] : []),
    ]);
    const token = { controller };
    this.#pending.add(token);
    let socket;
    const timeout = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'Dial timed out.', 'transport')),
      this.#config.limits.connectTimeoutMs + this.#config.limits.handshakeTimeoutMs,
    );
    const abort = () =>
      socket?.destroy(failure('ERR_CANCELLED', 'Dial was cancelled.', 'transport', signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted)
        throw failure('ERR_CANCELLED', 'Dial was cancelled.', 'transport', signal.reason);
      let tag = target.outboundTag;
      if (tag === undefined && this.#config.routing) {
        tag = this.#config.routing(target.host, target.port, datagram ? 2 : 1, target.inboundTag);
        if (tag === true) tag = undefined;
        if (tag === false || tag === null)
          throw failure('ERR_ROUTING', 'Routing rejected the target.', 'routing');
      }
      const bound =
        tag === undefined
          ? this.#config.outbounds[0]
          : this.#config.outbounds.find((item) => item.tag === tag);
      if (!bound) throw failure('ERR_ROUTING', 'Outbound tag does not exist.', 'routing');
      const options = {
        ...this.#config.limits,
        signal,
        lookup: this.#options.lookup,
        timeoutMs: this.#config.limits.handshakeTimeoutMs,
      };
      if (datagram && !['vless', 'freedom'].includes(bound.protocol))
        throw failure('ERR_UNSUPPORTED', 'UDP is supported by VLESS and Freedom only.', 'protocol');
      if (datagram && bound.protocol === 'freedom') {
        socket = this.#track(await directDatagram(target, options));
      } else if (bound.protocol === 'vmess') {
        const client = this.#clients.get(bound.tag);
        const wrapped = legacyDuplex((callbacks) => {
          const connection = client(
            target.host,
            target.port,
            1,
            callbacks.ready,
            callbacks.data,
            callbacks.close,
          );
          // The protocol attaches its state to this transport adapter.
          connection.setTransportObserver?.(callbacks.transport);
          return connection;
        }, this.#config.limits);
        socket = this.#track(wrapped.stream);
        await Promise.race([
          wrapped.ready,
          new Promise((resolve, reject) => {
            const cancelled = () =>
              reject(failure('ERR_CANCELLED', 'Dial was cancelled.', 'transport', signal.reason));
            signal.addEventListener('abort', cancelled, { once: true });
            wrapped.ready
              .finally(() => signal.removeEventListener('abort', cancelled))
              .catch(() => {});
            if (signal.aborted) cancelled();
          }),
        ]);
      } else {
        const network =
          bound.protocol === 'freedom'
            ? { address: target.host, port: target.port }
            : bound.networks[Math.floor(Math.random() * bound.networks.length)];
        socket = this.#track(await connect(network, options));
        if (bound.protocol === 'socks') await socks.client(socket, bound, target, options);
        if (bound.protocol === 'vless') {
          const raw = socket;
          socket = this.#track(await vless.client(raw, bound, target, options, datagram ? 2 : 1));
          this.#streams.delete(raw);
          if (datagram) {
            const framed = socket;
            socket = this.#track(
              new FramedDatagram(framed, target, this.#config.limits.maxBufferBytes),
            );
            this.#streams.delete(framed);
          }
        }
      }
      if (signal.aborted || this.#state !== 'running' || socket.destroyed)
        throw failure(
          'ERR_CANCELLED',
          'Dial was cancelled before completion.',
          'transport',
          signal.reason,
        );
      if (target.signal) {
        const stream = socket;
        const cancelled = () =>
          stream.destroy(
            failure(
              'ERR_CANCELLED',
              'Connection was cancelled.',
              'transport',
              target.signal.reason,
            ),
          );
        target.signal.addEventListener('abort', cancelled, { once: true });
        stream.once('close', () => target.signal.removeEventListener('abort', cancelled));
        if (target.signal.aborted) cancelled();
      }
      return socket;
    } catch (cause) {
      socket?.destroy();
      if (controller.signal.reason?.code === 'ERR_TIMEOUT') throw controller.signal.reason;
      if (signal.aborted)
        throw failure('ERR_CANCELLED', 'Dial was cancelled.', 'transport', signal.reason);
      throw cause instanceof Js2rayError
        ? cause
        : failure('ERR_PROTOCOL', 'Protocol negotiation failed.', 'protocol', cause);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      this.#pending.delete(token);
      this.emit('dialFinished');
    }
  }

  close({ drainTimeoutMs = 0 } = {}) {
    if (this.#closing) return this.#closing;
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0)
      return Promise.reject(failure('ERR_CONFIG', 'Invalid drain timeout.', 'config'));
    if (this.#state === 'closed') return Promise.resolve();
    const closed = Promise.withResolvers();
    this.#closing = closed.promise;
    this.#setState('closing');
    this.#lifetime.abort();
    (async () => {
      await this.#starting?.catch(() => {});
      try {
        await this.#cleanup(drainTimeoutMs);
      } finally {
        this.#setState('closed');
      }
    })().then(closed.resolve, closed.reject);
    return this.#closing;
  }

  async #cleanup(drainTimeoutMs) {
    for (const token of this.#pending) token.controller.abort();
    const listenersClosed = this.#servers.map(
      ({ server }) =>
        new Promise((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    );
    if (drainTimeoutMs && this.#streams.size) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.removeListener('connectionClosed', changed);
          resolve();
        };
        const changed = () => {
          if (!this.#streams.size) finish();
        };
        const timer = setTimeout(finish, drainTimeoutMs);
        this.on('connectionClosed', changed);
      });
    }
    const streamsClosed = [...this.#streams].map(
      (stream) =>
        new Promise((resolve) => {
          if (stream.closed) return resolve();
          stream.once('close', resolve);
          stream.destroy();
        }),
    );
    for (const listener of this.#servers) listener.destroy();
    await Promise.all([...listenersClosed, ...streamsClosed]);
    if (this.#pending.size)
      await new Promise((resolve) => {
        const changed = () => {
          if (!this.#pending.size) {
            this.removeListener('dialFinished', changed);
            resolve();
          }
        };
        this.on('dialFinished', changed);
        changed();
      });
    this.#servers = [];
    this.#vmess?.close();
    this.#clients.clear();
    this.#storage.close();
  }
}

module.exports = { createRuntime: (config, options) => new Runtime(config, options), Runtime };
