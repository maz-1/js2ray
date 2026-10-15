'use strict';
const { EventEmitter } = require('node:events');
const { Runtime } = require('./index');
const { createListener } = require('../transports');
const { failure, normalizeError } = require('./errors');
const { abortable } = require('./abortable');
const { LISTENERS, CAPTURE } = require('./hooks');

class RuntimeManager extends EventEmitter {
  #config;
  #options;
  #active;
  #generations = new Set();
  #listeners = new Map();
  #state = 'created';
  #starting;
  #closing;
  #queue = Promise.resolve();
  #pending;
  #sequence = 0;
  #retired = new Set();
  #queued = 0;
  constructor(config = {}, options = {}) {
    super();
    // Validate synchronously, before creating any resources.
    this.#config = new Runtime(config, options);
    this.#options = { ...options };
    if (
      !Number.isSafeInteger(options.maxRetiringGenerations ?? 4) ||
      (options.maxRetiringGenerations ?? 4) < 1 ||
      (options.maxRetiringGenerations ?? 4) > 32
    )
      throw failure('ERR_CONFIG', 'Expected 1–32 retiring generations.', 'config');
  }
  get state() {
    return this.#state;
  }
  get generation() {
    return this.#active?.id ?? 0;
  }
  get listenersInfo() {
    return [...this.#listeners.values()].map((entry) => ({
      tag: entry.tag,
      address: entry.listener.server.address(),
    }));
  }
  get stats() {
    const generations = [...this.#generations];
    return {
      state: this.#state,
      generation: this.generation,
      generations: generations.length,
      connections: generations.reduce((n, gen) => n + gen.runtime.stats.connections, 0),
      pendingDials: generations.reduce((n, gen) => n + gen.runtime.stats.pendingDials, 0),
      listeners: this.#listeners.size,
      reverse: generations.flatMap((gen) => gen.runtime.stats.reverse),
    };
  }
  get metrics() {
    return [...this.#generations].map((gen) => ({
      generation: gen.id,
      retiring: gen !== this.#active,
      metrics: gen.runtime.metrics,
    }));
  }
  #stateTo(state) {
    this.#state = state;
    this.emit('state', state);
  }
  async #register(gen, network, tag, index, limits, accept) {
    const key = `${tag}:${index}`;
    let entry = this.#listeners.get(key);
    if (entry) {
      if (entry.network.address !== network.address || entry.network.port !== network.port)
        entry = undefined;
    }
    if (!entry && network.port)
      entry = [...this.#listeners.values()].find(
        (candidate) =>
          candidate.network.address === network.address && candidate.network.port === network.port,
      );
    if (entry && [...gen.entries.values()].some((item) => item.entry === entry))
      throw failure('ERR_CONFIG', 'Duplicate candidate listener binding.', 'config');
    if (!entry) {
      entry = { key, tag, network, active: undefined };
      entry.listener = createListener(
        network,
        (stream) => {
          const selected = entry.active;
          if (!selected) return stream.destroy();
          this.#retainStream(selected.gen, stream);
          selected.accept(stream);
        },
        limits,
      );
      gen.created.add(entry);
      entry.listener.server.on('error', (cause) =>
        this.emit('diagnostic', normalizeError(cause, 'inbound')),
      );
      await new Promise((resolve, reject) => {
        const server = entry.listener.server;
        const cleanup = () => {
          server.removeListener('error', failed);
          server.removeListener('listening', ready);
          server.removeListener('close', closed);
        };
        const failed = (cause) => {
          cleanup();
          reject(failure('ERR_LISTEN', 'Candidate listener failed.', 'rotation', cause));
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const closed = () =>
          failed(failure('ERR_CANCELLED', 'Candidate listener cancelled.', 'rotation'));
        server.once('error', failed);
        server.once('listening', ready);
        server.once('close', closed);
        server.listen({ host: network.address, port: network.port, signal: gen.controller.signal });
      });
    }
    const update = entry.listener.prepareUpdate(network, limits);
    gen.entries.set(key, { entry, accept, update, network, tag });
  }
  #retainStream(gen, stream) {
    if (gen.streams.has(stream)) return stream;
    gen.streams.add(stream);
    stream.once('close', () => {
      gen.streams.delete(stream);
      gen.changed?.();
    });
    return stream;
  }
  async #dial(gen, target, datagram) {
    if (!this.#generations.has(gen) || gen.runtime.state !== 'running')
      throw failure('ERR_CLOSED', 'Configuration generation has drained.', 'rotation');
    gen.leases++;
    try {
      return this.#retainStream(gen, await gen.runtime[datagram ? 'openDatagram' : 'dial'](target));
    } finally {
      gen.leases--;
      gen.changed?.();
    }
  }
  [CAPTURE]() {
    if (this.#state !== 'running')
      throw failure('ERR_STATE', 'Manager must be running.', 'rotation');
    const gen = this.#active;
    gen.leases++;
    let released = false;
    return {
      id: gen.id,
      runtime: {
        dial: (target) => this.#dial(gen, target, false),
        openDatagram: (target) => this.#dial(gen, target, true),
        on: gen.runtime.on.bind(gen.runtime),
        removeListener: gen.runtime.removeListener.bind(gen.runtime),
      },
      release: () => {
        if (!released) {
          released = true;
          gen.leases--;
          gen.changed?.();
        }
      },
    };
  }
  async dial(target) {
    const scope = this[CAPTURE]();
    return scope.runtime.dial(target).finally(scope.release);
  }
  async openDatagram(target) {
    const scope = this[CAPTURE]();
    return scope.runtime.openDatagram(target).finally(scope.release);
  }
  resolve(host, options) {
    if (this.#state !== 'running')
      return Promise.reject(failure('ERR_STATE', 'Manager must be running.', 'rotation'));
    return this.#active.runtime.resolve(host, options);
  }
  start() {
    if (this.#state === 'running') return Promise.resolve(this);
    if (this.#state === 'starting') return this.#starting;
    if (this.#state !== 'created')
      return Promise.reject(failure('ERR_CLOSED', 'Manager is closed.', 'rotation'));
    const started = Promise.withResolvers();
    this.#starting = started.promise;
    this.#stateTo('starting');
    this.#prepare(this.#config, this.#options, {})
      .then(({ gen }) => {
        if (this.#state !== 'starting')
          throw failure('ERR_CANCELLED', 'Manager startup cancelled.', 'rotation');
        this.#commit(gen);
        this.#stateTo('running');
        return this;
      })
      .then(started.resolve, async (error) => {
        await this.close();
        started.reject(error);
      });
    return this.#starting;
  }
  async #prepare(config, options, { ready, signal, timeoutMs = 20000 } = {}) {
    if (['closing', 'closed'].includes(this.#state))
      throw failure('ERR_CANCELLED', 'Manager is closing.', 'rotation');
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      (ready !== undefined && typeof ready !== 'function')
    )
      throw failure('ERR_CONFIG', 'Invalid rotation preparation options.', 'config');
    const controller = new AbortController();
    this.#pending = controller;
    const active = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(
      () => controller.abort(failure('ERR_TIMEOUT', 'Candidate readiness timed out.', 'rotation')),
      timeoutMs,
    );
    const gen = {
      id: ++this.#sequence,
      controller,
      entries: new Map(),
      created: new Set(),
      streams: new Set(),
      leases: 0,
    };
    try {
      // The initial runtime is already validated and still owns no listeners.
      gen.runtime = config instanceof Runtime ? config : new Runtime(config, options);
      gen.runtime[LISTENERS](
        (...args) => this.#register(gen, ...args),
        () => this.#active === gen,
      );
      this.#generations.add(gen);
      gen.runtime.on('diagnostic', (error) => this.emit('diagnostic', error));
      gen.runtime.on('reverse', (event) => this.emit('reverse', { ...event, generation: gen.id }));
      await abortable(gen.runtime.start(), active);
      if (ready)
        await abortable(
          Promise.resolve().then(() => ready(gen.runtime, active)),
          active,
        );
      if (active.aborted) throw active.reason;
      return { gen };
    } catch (cause) {
      controller.abort();
      await gen.runtime?.close();
      await this.#discard(gen);
      this.#generations.delete(gen);
      throw controller.signal.reason?.code === 'ERR_TIMEOUT'
        ? controller.signal.reason
        : normalizeError(cause, 'rotation');
    } finally {
      clearTimeout(timer);
      if (this.#pending === controller) this.#pending = undefined;
    }
  }
  async #discard(gen) {
    await Promise.all(
      [...gen.created].map(
        (entry) =>
          new Promise((resolve) => {
            entry.active = undefined;
            entry.listener.destroy();
            if (!entry.listener.server.listening) return resolve();
            entry.listener.server.close(resolve);
          }),
      ),
    );
  }
  #commit(gen) {
    const applied = [];
    try {
      for (const item of gen.entries.values()) {
        item.update.commit();
        applied.push(item.update);
      }
    } catch (error) {
      for (const update of applied.reverse()) update.rollback();
      throw error;
    }
    const selected = new Set([...gen.entries.values()].map((item) => item.entry));
    for (const entry of this.#listeners.values()) {
      if (!selected.has(entry)) {
        entry.active = undefined;
        this.#retired.add(entry);
        entry.closePromise = new Promise((resolve) =>
          entry.listener.server.close(() => {
            entry.listener.destroy();
            this.#retired.delete(entry);
            resolve();
          }),
        );
      }
    }
    this.#listeners = new Map(
      [...gen.entries].map(([key, item]) => {
        item.entry.active = { gen, accept: item.accept };
        item.entry.network = item.network;
        item.entry.tag = item.tag;
        return [key, item.entry];
      }),
    );
    this.#active = gen;
  }
  #drain(gen, timeoutMs) {
    const done = Promise.withResolvers();
    let ending = false;
    const finish = () => {
      if (ending) return;
      ending = true;
      clearTimeout(timer);
      clearInterval(poll);
      gen.changed = undefined;
      gen.stopDrain = undefined;
      const removed = [...gen.entries.values()]
        .map((item) => item.entry)
        .filter((entry) => this.#retired.has(entry));
      for (const entry of removed) entry.listener.destroy();
      Promise.all([gen.runtime.close(), ...removed.map((entry) => entry.closePromise)]).then(
        () => {
          this.#generations.delete(gen);
          done.resolve();
        },
        (error) => {
          this.#generations.delete(gen);
          done.reject(error);
        },
      );
    };
    const changed = () => {
      if (!gen.leases && !gen.streams.size && !gen.runtime.metrics.mux.businessSessions) finish();
    };
    const timer = setTimeout(finish, timeoutMs),
      poll = setInterval(changed, 20);
    gen.changed = changed;
    gen.stopDrain = finish;
    changed();
    return done.promise;
  }
  rotate(config, { runtimeOptions = {}, drainTimeoutMs = 5000, ...prepare } = {}) {
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0)
      return Promise.reject(failure('ERR_CONFIG', 'Invalid drain budget.', 'config'));
    if (this.#queued >= 128)
      return Promise.reject(failure('ERR_LIMIT', 'Too many pending rotations.', 'rotation'));
    this.#queued++;
    const operation = this.#queue
      .then(async () => {
        if (this.#state !== 'running')
          throw failure('ERR_STATE', 'Manager must be running before rotation.', 'rotation');
        if (this.#generations.size >= (this.#options.maxRetiringGenerations ?? 4) + 1)
          throw failure('ERR_LIMIT', 'Retiring generation limit reached.', 'rotation');
        const { gen } = await this.#prepare(
          config,
          { ...this.#options, ...runtimeOptions },
          prepare,
        );
        if (this.#state !== 'running') {
          await gen.runtime.close();
          await this.#discard(gen);
          this.#generations.delete(gen);
          throw failure('ERR_CANCELLED', 'Rotation cancelled.', 'rotation');
        }
        const previous = this.#active;
        try {
          this.#commit(gen);
        } catch (error) {
          await gen.runtime.close();
          await this.#discard(gen);
          this.#generations.delete(gen);
          throw error;
        }
        this.emit('generation', gen.id);
        return { generation: gen.id, drained: this.#drain(previous, drainTimeoutMs) };
      })
      .finally(() => {
        this.#queued--;
      });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  close() {
    if (this.#closing) return this.#closing;
    const done = Promise.withResolvers();
    this.#closing = done.promise;
    this.#stateTo('closing');
    this.#pending?.abort();
    (async () => {
      await this.#queue;
      const listeners = [...this.#listeners.values(), ...this.#retired];
      this.#listeners.clear();
      this.#retired.clear();
      const closed = listeners.map(
        (entry) =>
          entry.closePromise ??
          new Promise((resolve) => {
            entry.active = undefined;
            if (!entry.listener.server.listening) return resolve();
            entry.listener.server.close(resolve);
          }),
      );
      for (const gen of this.#generations) gen.stopDrain?.();
      await Promise.all([...this.#generations].map((gen) => gen.runtime.close()));
      for (const entry of listeners) entry.listener.destroy();
      await Promise.all(closed);
      this.#generations.clear();
      this.#active = undefined;
      this.#stateTo('closed');
    })().then(done.resolve, done.reject);
    return this.#closing;
  }
}
module.exports = {
  RuntimeManager,
  createRuntimeManager: (config, options) => new RuntimeManager(config, options),
};
