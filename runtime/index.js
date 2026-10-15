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
const { Js2rayError, failure, normalizeError, normalizeEmitter } = require('./errors');
const { Metrics } = require('./metrics');
const { FramedDatagram, directDatagram, serveDatagrams } = require('./datagram');
const socksDatagram = require('../protocols/socks/datagram');
const { VMessDatagram } = require('../protocols/vmess/datagram');
const { Router } = require('../routing');
const { Resolver } = require('../dns');
const { sniff } = require('../routing/sniff');
const { Mux } = require('../protocols/mux');
const { abortable } = require('./abortable');
const { Reverse } = require('../reverse');

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
  #router;
  #resolver;
  #muxes = new Set();
  #muxClients = new Map();
  #reverse;
  #metrics = new Metrics();

  constructor(config, options = {}) {
    super();
    if (options.lookup !== undefined && typeof options.lookup !== 'function')
      throw failure('ERR_CONFIG', 'Expected a DNS lookup function.', 'config');
    this.#config = normalizeConfig(config, options);
    this.#options = options;
    this.#router =
      typeof this.#config.routing === 'object'
        ? new Router(this.#config.routing, this.#config._assets)
        : undefined;
    this.#resolver = new Resolver(this.#config.dns, {
      data: this.#config._assets,
      dial: (target) => this.dial(target),
      openDatagram: (target) => this.openDatagram(target),
      signal: this.#lifetime.signal,
      lookup: options.lookup,
    });
    this.#reverse = new Reverse(this.#config.reverse, {
      dial: (target) => (target.network === 'udp' ? this.openDatagram(target) : this.dial(target)),
      signal: this.#lifetime.signal,
      limits: this.#config.limits,
      event: (event) => {
        this.#metrics.reverse[event.state] = (this.#metrics.reverse[event.state] ?? 0) + 1;
        this.emit('reverse', event);
      },
    });
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
      reverse: this.#reverse.stats,
    };
  }
  get protocols() {
    return this.#vmess ? { vmess: this.#vmess } : {};
  }
  get metrics() {
    const muxes = [...this.#muxes, ...this.#reverse.muxes];
    return {
      ...this.#metrics.snapshot(),
      dns: this.#resolver.stats,
      mux: {
        transports: muxes.length,
        sessions: muxes.reduce((n, mux) => n + mux.sessions.size, 0),
        queuedBytes: muxes.reduce(
          (n, mux) => n + mux.pendingBytes + mux.receivedBytes + mux.buffer.length,
          0,
        ),
      },
    };
  }

  #setState(state) {
    this.#state = state;
    this.emit('state', state);
  }
  #report(error) {
    error = normalizeError(error);
    if (!this.#metrics.error(error)) return;
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
    normalizeEmitter(stream, (error) => this.#report(error));
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
        if (
          bound.protocol === 'service' &&
          typeof this.#options.services?.[bound.service] !== 'function'
        )
          throw failure('ERR_CONFIG', 'Service handler is not registered.', 'config');
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
              else if (bound.protocol === 'tcp') this.#acceptTcp(socket, bound);
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
      this.#reverse.start();
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
        (target) => this.#inboundDial(socket, bound, target),
        {
          signal: this.#lifetime.signal,
          timeoutMs: this.#config.limits.handshakeTimeoutMs,
          earlyReply: bound.sniffing?.enabled,
          ...(bound.udp
            ? {
                associate: async (target) => {
                  const local = this.#track(
                    await socksDatagram.association(socket, target, this.#config.limits),
                  );
                  serveDatagrams(local, (destination) =>
                    this.openDatagram({ ...destination, inboundTag: bound.tag }),
                  ).catch((error) => this.#report(error));
                },
              }
            : {}),
        },
      );
      if (!remote) return;
      if (socket.destroyed) remote.destroy();
      else relay(socket, remote);
    } catch (error) {
      socket.destroy();
      this.#report(error);
    }
  }

  async #inboundDial(socket, bound, target) {
    const name = await sniff(socket, bound.sniffing, this.#lifetime.signal);
    if (name)
      target = { ...target, ...(bound.sniffing.routeOnly ? { routeHost: name } : { host: name }) };
    return this.dial({ ...target, inboundTag: bound.tag });
  }

  async #acceptTcp(socket, bound) {
    try {
      const remote = await this.#inboundDial(socket, bound, bound.target);
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
      if (target.command === 3) {
        await require('./streams').write(socket, Buffer.from([0, 0]));
        this.#trackMux(
          new Mux(socket, {
            server: true,
            dispatch: (target) =>
              target.network === 'udp'
                ? this.openDatagram({ ...target, inboundTag: bound.tag })
                : this.dial({ ...target, inboundTag: bound.tag }),
            maxBufferBytes: this.#config.limits.maxBufferBytes,
          }),
        );
        return;
      }
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
      await require('./streams').write(socket, Buffer.from([0, 0]));
      const remote = await this.#inboundDial(socket, bound, {
        host: target.host,
        port: target.port,
        inboundTag: bound.tag,
      });
      if (socket.destroyed) return remote.destroy();
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
    socket.once('end', () => socket.app?.remote?.end?.());
  }

  #legacyDial(bound) {
    const runtime = this;
    return function (address, destinationPort, cmd, connected, message, closed) {
      let remote;
      let destroyed = false;
      const inbound = this;
      if (cmd === 2) {
        runtime.openDatagram({ host: address, port: destinationPort, inboundTag: bound.tag }).then(
          (session) => {
            remote = session;
            if (destroyed) return remote.destroy();
            remote.on('message', (data) => {
              if (data.length > 65455)
                return remote.destroy(
                  failure('ERR_LIMIT', 'VMess UDP response exceeds its frame limit.', 'protocol'),
                );
              try {
                message(data);
              } catch (error) {
                remote.destroy(error);
              }
            });
            remote.once('close', closed);
            connected();
          },
          () => closed(),
        );
        return {
          message(data) {
            remote?.send(data).catch((error) => remote.destroy(error));
          },
          close() {
            destroyed = true;
            remote?.destroy();
          },
        };
      }
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
      this.#connect(network, {
        ...this.#config.limits,
        signal: AbortSignal.any([pending.signal, this.#lifetime.signal]),
        lookup: this.#resolver.bootstrapLookup,
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
    return this.#operation(target, false);
  }
  #connect(network, options) {
    return this.#metrics.measure('transport', () => connect(network, options));
  }
  #trackMux(mux) {
    this.#muxes.add(mux);
    mux.once('close', () => this.#muxes.delete(mux));
    return mux;
  }
  async #outboundMux(bound) {
    if (!this.#muxClients.has(bound.tag)) {
      const pending = (async () => {
        let stream;
        try {
          stream = this.#track(
            await this.#connect(bound.networks[0], {
              ...this.#config.limits,
              signal: this.#lifetime.signal,
              lookup: this.#resolver.bootstrapLookup,
            }),
          );
          const raw = stream;
          stream = this.#track(
            await vless.client(
              raw,
              bound,
              { host: 'v1.mux.cool', port: 0 },
              this.#config.limits,
              3,
            ),
          );
          this.#streams.delete(raw);
          const mux = this.#trackMux(
            new Mux(stream, {
              maxSessions: bound.mux.concurrency ?? 8,
              maxBufferBytes: this.#config.limits.maxBufferBytes,
            }),
          );
          mux.once('close', () => this.#muxClients.delete(bound.tag));
          return mux;
        } catch (error) {
          stream?.destroy();
          this.#muxClients.delete(bound.tag);
          throw error;
        }
      })();
      this.#muxClients.set(bound.tag, pending);
    }
    return this.#muxClients.get(bound.tag);
  }
  openDatagram(target) {
    return this.#operation(target, true);
  }
  async #operation(target, datagram) {
    this.#metrics.counters.dials++;
    return this.#metrics.measure('dial', async () => {
      try {
        const socket = await this.#dial(target, datagram);
        this.#metrics.counters.succeeded++;
        this.#metrics.observe(socket, datagram);
        return socket;
      } catch (cause) {
        const error = normalizeError(cause);
        this.#metrics.counters.failed++;
        this.#report(error);
        throw error;
      }
    });
  }
  resolve(host, options) {
    if (this.#state !== 'running')
      return Promise.reject(
        failure('ERR_STATE', 'Runtime must be running before resolving.', 'runtime'),
      );
    return this.#metrics
      .measure('dns', () => this.#resolver.resolve(host, options))
      .catch((cause) => {
        const error = normalizeError(cause, 'dns');
        this.#report(error);
        throw error;
      });
  }

  async #dial(target, datagram) {
    if (this.#state !== 'running')
      throw failure('ERR_STATE', 'Runtime must be running before dialing.', 'runtime');
    const control =
      target &&
      target.port === 0 &&
      (this.#config.reverse?.bridges?.some(
        (item) => item.domain === target.host && item.tag === target.inboundTag,
      ) ||
        this.#config.reverse?.portals?.some((item) => item.domain === target.host));
    if (!target || !host(target.host) || !port(target.port, control))
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
      if (tag === undefined && this.#router)
        tag = await this.#metrics.measure('routing', () =>
          this.#router.selectAsync({ ...target, network: datagram ? 'udp' : 'tcp' }, (name) =>
            this.#metrics.measure('dns', () =>
              target.dnsInternal
                ? this.#resolver.bootstrap(name, 0, signal)
                : this.#resolver.resolve(name, { signal }),
            ),
          ),
        );
      else if (tag === undefined && typeof this.#config.routing === 'function') {
        tag = this.#config.routing(target.host, target.port, datagram ? 2 : 1, target.inboundTag);
        if (tag === true) tag = undefined;
        if (tag === false || tag === null)
          throw failure('ERR_ROUTING', 'Routing rejected the target.', 'routing');
      }
      const bound =
        tag === undefined
          ? this.#config.outbounds[0]
          : (this.#config.outbounds.find((item) => item.tag === tag) ??
            this.#config.reverse?.portals?.find((item) => item.tag === tag));
      if (!bound) throw failure('ERR_ROUTING', 'Outbound tag does not exist.', 'routing');
      if (bound.protocol === 'blackhole')
        throw failure('ERR_BLOCKED', 'Target blocked by routing.', 'routing');
      if (bound.redirect) {
        const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(bound.redirect);
        target = { ...target, host: match[1] || match[2], port: Number(match[3]) };
      }
      let lookup = this.#resolver.bootstrapLookup;
      if (
        bound.protocol === 'freedom' &&
        !target.dnsInternal &&
        (bound.domainStrategy ?? 'AsIs') !== 'AsIs'
      ) {
        const family =
          bound.domainStrategy === 'UseIPv4' ? 4 : bound.domainStrategy === 'UseIPv6' ? 6 : 0;
        const records = await this.#metrics.measure('dns', () =>
          this.#resolver.resolve(target.host, { family, signal }),
        );
        if (!records.length) throw failure('ERR_DNS', 'No target address.', 'dns');
        target = { ...target, host: records[0].address };
      }
      const options = {
        ...this.#config.limits,
        signal,
        lookup,
        timeoutMs: this.#config.limits.handshakeTimeoutMs,
      };
      if (
        datagram &&
        !this.#reverse.portals.has(bound.tag) &&
        !['vless', 'freedom', 'vmess', 'socks'].includes(bound.protocol)
      )
        throw failure('ERR_UNSUPPORTED', 'UDP is supported by VLESS and Freedom only.', 'protocol');
      if (this.#reverse.portals.has(bound.tag)) {
        socket = this.#track(
          this.#reverse.connect(bound.tag, { ...target, network: datagram ? 'udp' : 'tcp' }),
        );
      } else if (bound.protocol === 'service') {
        if (datagram || target.host !== bound.allow.host || target.port !== bound.allow.port)
          throw failure('ERR_BLOCKED', 'Target is outside service scope.', 'routing');
        const pendingService = Promise.resolve().then(() =>
          this.#options.services[bound.service]({ ...target, signal }),
        );
        pendingService.then(
          (stream) => {
            if (signal.aborted) stream?.destroy?.();
          },
          () => {},
        );
        const service = await abortable(pendingService, signal);
        if (!(service instanceof require('node:stream').Duplex))
          throw failure('ERR_PROTOCOL', 'Service handler must return a Duplex.', 'reverse');
        socket = this.#track(service);
      } else if (bound.mux?.enabled || (datagram && bound.packetEncoding === 'xudp')) {
        const dedicated = !bound.mux?.enabled;
        const mux = await abortable(
          this.#outboundMux(
            dedicated ? { ...bound, tag: Symbol(), mux: { concurrency: 1 } } : bound,
          ),
          signal,
        );
        socket = this.#track(
          datagram
            ? mux.openDatagram({ ...target, xudp: bound.packetEncoding === 'xudp' })
            : mux.open(target),
        );
        if (dedicated) socket.once('close', () => mux.close());
      } else if (datagram && bound.protocol === 'freedom') {
        socket = this.#track(await directDatagram(target, options));
      } else if (datagram && bound.protocol === 'vmess') {
        socket = this.#track(
          new VMessDatagram(
            this.#clients.get(bound.tag),
            target,
            this.#config.limits.maxBufferBytes,
          ),
        );
        await abortable(socket.ready, signal);
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
        socket = this.#track(await this.#connect(network, options));
        if (datagram && bound.protocol === 'socks') {
          const control = socket;
          socket = this.#track(await socksDatagram.clientDatagram(control, bound, target, options));
        } else if (bound.protocol === 'socks')
          await this.#metrics.measure('protocol', () =>
            socks.client(socket, bound, target, options),
          );
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
    this.#reverse.close();
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
    for (const mux of this.#muxes) mux.close();
    this.#muxClients.clear();
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
    this.#streams.clear();
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
    this.#resolver.close();
  }
}

module.exports = { createRuntime: (config, options) => new Runtime(config, options), Runtime };
