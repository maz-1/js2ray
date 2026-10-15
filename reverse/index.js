'use strict';
const { duplexPair } = require('node:stream');
const crypto = require('node:crypto');
const { Mux } = require('../protocols/mux');
const { protobuf } = require('../geodata');
const { failure } = require('../runtime/errors');
const INTERNAL = 'reverse.internal.v2fly.org';
const control = (draining) =>
  Buffer.concat([Buffer.from([8, draining ? 1 : 0, 0x9a, 6, 8]), crypto.randomBytes(8)]);

class Reverse {
  constructor(config = {}, { dial, signal, event, limits }) {
    this.config = config;
    this.dial = dial;
    this.signal = signal;
    this.event = event;
    this.limits = limits;
    this.closed = false;
    this.portals = new Map(
      (config.portals ?? []).map((item) => [item.tag, { ...item, workers: new Set() }]),
    );
    this.bridges = (config.bridges ?? []).map((item) => ({
      ...item,
      workers: new Set(),
      attempts: 0,
      timer: undefined,
      connecting: false,
    }));
  }
  emit(tag, state, extra = {}) {
    this.event({ tag, state, ...extra });
  }
  get stats() {
    return [
      ...this.bridges.map((item) => ({
        tag: item.tag,
        role: 'bridge',
        transports: item.workers.size,
        active: [...item.workers].filter((worker) => !worker.draining && worker.reverseReady)
          .length,
        sessions: [...item.workers].reduce((sum, worker) => sum + worker.sessions.size, 0),
        connecting: item.connecting,
      })),
      ...[...this.portals.values()].map((item) => ({
        tag: item.tag,
        role: 'portal',
        transports: item.workers.size,
        active: [...item.workers].filter((worker) => !worker.draining).length,
        sessions: [...item.workers].reduce((sum, worker) => sum + worker.sessions.size, 0),
      })),
    ];
  }
  start() {
    for (const bridge of this.bridges) this.schedule(bridge, 0);
  }
  schedule(bridge, delay) {
    if (this.closed || bridge.timer || bridge.connecting) return;
    bridge.timer = setTimeout(() => {
      bridge.timer = undefined;
      this.monitor(bridge);
    }, delay);
    bridge.timer.unref();
  }
  async monitor(bridge) {
    if (this.closed) return;
    const active = [...bridge.workers].filter((worker) => !worker.closed && !worker.draining);
    if (
      bridge.workers.size >= (bridge.maxWorkers ?? 4) ||
      (active.length &&
        active.reduce((sum, worker) => sum + worker.sessions.size, 0) / active.length <= 16)
    ) {
      this.schedule(bridge, 1000);
      return;
    }
    bridge.connecting = true;
    this.emit(bridge.tag, 'connecting');
    try {
      const stream = await this.dial({
        host: bridge.domain,
        port: 0,
        inboundTag: bridge.tag,
        signal: this.signal,
      });
      if (this.closed) {
        stream.destroy();
        return;
      }
      const worker = new Mux(stream, {
        server: true,
        allowControl: true,
        dispatch: (target) => this.dial({ ...target, inboundTag: bridge.tag }),
        maxSessions: bridge.maxSessions ?? 129,
        maxBufferBytes: this.limits.maxBufferBytes,
      });
      worker.reverseReady = false;
      const readyTimer = setTimeout(() => {
        if (!worker.reverseReady)
          worker.close(failure('ERR_TIMEOUT', 'Reverse control handshake timed out.', 'reverse'));
      }, this.limits.handshakeTimeoutMs);
      bridge.workers.add(worker);
      bridge.attempts = 0;
      worker.on('control', (session) => {
        session.on('packet', (bytes) => {
          try {
            const fields = protobuf(bytes);
            const state = fields.find((field) => field.field === 1)?.value ?? 0;
            if (![0, 1].includes(state)) throw Error('Invalid control state.');
            if (!worker.reverseReady) {
              worker.reverseReady = true;
              clearTimeout(readyTimer);
              this.emit(bridge.tag, 'active');
            }
            if (state === 1) {
              worker.draining = true;
              this.emit(bridge.tag, 'draining');
              this.schedule(bridge, 0);
            }
          } catch {
            worker.close(failure('ERR_PROTOCOL', 'Invalid reverse control message.', 'reverse'));
          }
        });
        session.resume();
        session.once('close', () => {
          if (!worker.closed && !worker.draining)
            worker.close(failure('ERR_REVERSE', 'Reverse control session closed.', 'reverse'));
        });
      });
      worker.on('sessionClosed', () => {
        if (worker.draining && !worker.sessions.size) worker.close();
      });
      worker.once('close', () => {
        clearTimeout(readyTimer);
        bridge.workers.delete(worker);
        this.emit(bridge.tag, 'disconnected');
        this.schedule(bridge, 50);
      });
      this.emit(bridge.tag, 'connected');
    } catch (error) {
      bridge.attempts++;
      this.emit(bridge.tag, 'retrying', {
        code: error.code ?? 'ERR_TRANSPORT',
        attempt: bridge.attempts,
      });
    } finally {
      bridge.connecting = false;
      const delay = bridge.attempts
        ? Math.min(30000, (bridge.reconnectMs ?? 100) * 2 ** Math.min(bridge.attempts - 1, 10)) *
          (0.8 + Math.random() * 0.4)
        : 1000;
      this.schedule(bridge, Math.ceil(delay));
    }
  }
  connect(tag, target) {
    const portal = this.portals.get(tag);
    if (!portal || this.closed)
      throw failure('ERR_REVERSE', 'Reverse Portal is unavailable.', 'reverse');
    if (target.host === portal.domain) {
      if (target.port !== 0 || portal.workers.size >= (portal.maxWorkers ?? 4))
        throw failure('ERR_LIMIT', 'Reverse transport rejected.', 'reverse');
      const [local, remote] = duplexPair();
      local.on('error', () => {});
      remote.on('error', () => {});
      const worker = new Mux(remote, {
        allowControl: true,
        maxSessions: portal.maxSessions ?? 129,
        maxBufferBytes: this.limits.maxBufferBytes,
      });
      portal.workers.add(worker);
      const channel = worker.open({ host: INTERNAL, port: 0, network: 'udp' });
      const heartbeat = () => {
        if (worker.closed) return;
        channel.touch();
        if (worker.total > 256) {
          worker.draining = true;
          this.emit(tag, 'draining');
        }
        worker.send({ id: channel.id, status: 2, data: control(worker.draining) }).then(
          () => {
            if (worker.draining) {
              clearInterval(timer);
              channel.end();
              if (worker.sessions.size <= 1) worker.close();
            }
          },
          (error) => worker.close(error),
        );
      };
      const timer = setInterval(heartbeat, 2000);
      timer.unref();
      heartbeat();
      channel.once('close', () => {
        if (!worker.closed && !worker.draining)
          worker.close(failure('ERR_REVERSE', 'Reverse control session closed.', 'reverse'));
      });
      worker.on('sessionClosed', () => {
        if (worker.draining && !worker.sessions.size) worker.close();
      });
      worker.once('close', () => {
        clearInterval(timer);
        local.destroy();
        portal.workers.delete(worker);
        this.emit(tag, 'disconnected');
      });
      local.once('close', () => worker.close());
      this.emit(tag, 'active');
      return local;
    }
    const workers = [...portal.workers]
      .filter(
        (worker) => !worker.closed && !worker.draining && worker.sessions.size < worker.maxSessions,
      )
      .sort((a, b) => a.sessions.size - b.sessions.size);
    if (!workers.length)
      throw failure('ERR_REVERSE', 'No reverse Bridge transport is available.', 'reverse');
    return workers[0].open(target);
  }
  close() {
    this.closed = true;
    for (const bridge of this.bridges) {
      clearTimeout(bridge.timer);
      for (const worker of bridge.workers) worker.close();
      bridge.workers.clear();
    }
    for (const portal of this.portals.values()) {
      for (const worker of portal.workers) worker.close();
      portal.workers.clear();
    }
  }
}
module.exports = { Reverse, INTERNAL, control };
