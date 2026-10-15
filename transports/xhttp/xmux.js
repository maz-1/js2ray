'use strict';
const http = require('node:http');
const http2 = require('node:http2');
const { randomInt } = require('node:crypto');
const { failure } = require('../../runtime/errors');
const { abortable } = require('../../runtime/abortable');
const { settings, transportError } = require('./common');
const { xmuxSettings } = require('../../config/xhttp');

const draw = ({ from, to }) => randomInt(from, to + 1);
const closedError = () => failure('ERR_CLOSED', 'XHTTP HTTP client closed.', 'transport');

// Owned by one Runtime and one normalized network object. Never shared globally,
// across credentials, DNS contexts or configuration generations.
class XmuxPool {
  constructor(network, limits, dial) {
    this.network = network;
    this.limits = limits;
    this.dial = dial;
    this.config = settings(network.option, limits);
    this.policy = xmuxSettings(network.option?.xmux);
    this.concurrency = draw(this.policy.maxConcurrency);
    this.connections = draw(this.policy.maxConnections);
    this.entries = new Set();
    this.counters = { created: 0, retired: 0, requests: 0, pings: 0, failures: 0 };
    this.closed = false;
  }
  get stats() {
    return {
      ...this.counters,
      clients: this.entries.size,
      draining: [...this.entries].filter((entry) => entry.retired).length,
      active: [...this.entries].reduce((n, entry) => n + entry.active, 0),
      sockets: [...this.entries].reduce((n, entry) => n + entry.sockets.size, 0),
      pending: [...this.entries].filter((entry) => !entry.initialized).length,
    };
  }
  async acquire(signal, running = true) {
    if (this.closed) throw closedError();
    if (signal?.aborted) throw failure('ERR_CANCELLED', 'XHTTP dial cancelled.', 'transport');
    for (const entry of this.entries) if (!entry.reusable()) entry.retire();
    const available = [...this.entries].filter((entry) => !entry.retired && !entry.closed);
    const candidates = available.filter(
      (entry) =>
        (!this.concurrency || entry.active < this.concurrency) &&
        (!running || !entry.capacity || entry.active < entry.capacity),
    );
    const entry =
      !available.length ||
      (this.connections && available.length < this.connections) ||
      !candidates.length
        ? this.createEntry()
        : candidates[randomInt(candidates.length)];
    // Reserve synchronously, before awaiting the shared physical handshake.
    entry.users++;
    entry.refCount++;
    if (running) entry.active++;
    if (entry.leftUsage > 0) entry.leftUsage--;
    clearTimeout(entry.idleTimer);
    entry.updateRef();
    let released = false;
    let referenced = true;
    const lease = {
      entry,
      ref: (value) => {
        if (released || referenced === value) return;
        referenced = value;
        entry.refCount += value ? 1 : -1;
        entry.updateRef();
      },
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (referenced) entry.refCount--;
        entry.updateRef();
        if (running) entry.active--;
        if (!entry.users) {
          if (!entry.reusable() || !entry.initialized || this.closed) entry.retire();
          else {
            entry.idleTimer = setTimeout(() => entry.retire(), 90000);
            entry.idleTimer.unref();
          }
        }
      },
    };
    try {
      await (signal ? abortable(entry.ready, signal) : entry.ready);
      if (entry.closed || this.closed) throw closedError();
      if (running && entry.capacity && entry.active > entry.capacity) {
        lease.release();
        return this.acquire(signal, running);
      }
      return lease;
    } catch (cause) {
      lease.release();
      throw transportError(cause);
    }
  }
  createEntry() {
    const pool = this;
    const config = this.config;
    const controller = new AbortController();
    require('node:events').setMaxListeners(0, controller.signal);
    const entry = {
      users: 0,
      refCount: 0,
      active: 0,
      initialized: false,
      closed: false,
      retired: false,
      sockets: new Set(),
      signal: controller.signal,
      requests: new Set(),
      leftUsage: draw(this.policy.cMaxReuseTimes) || -1,
      leftRequests: draw(this.policy.hMaxRequestTimes) || Infinity,
      expires: draw(this.policy.hMaxReusableSecs),
      updateRef() {
        const value = this.refCount > 0;
        for (const socket of this.sockets) socket[value ? 'ref' : 'unref']();
        this.session?.[value ? 'ref' : 'unref']();
      },
      reusable() {
        return !this.closed && !this.retired && this.leftUsage !== 0 && this.packetReusable();
      },
      packetReusable() {
        return (
          !this.closed &&
          !this.goaway &&
          this.leftRequests > 0 &&
          (!this.expires || Date.now() < this.expires)
        );
      },
      countRequest(req) {
        this.leftRequests--;
        pool.counters.requests++;
        this.requests.add(req);
        req.once('close', () => this.requests.delete(req));
        if (this.leftRequests <= 0) this.retire();
      },
      retire() {
        if (!this.retired) {
          this.retired = true;
          pool.counters.retired++;
        }
        if (!this.users) this.destroy();
      },
      destroy(cause) {
        if (this.closed) return;
        this.closed = true;
        if (cause) pool.counters.failures++;
        clearTimeout(this.idleTimer);
        clearTimeout(this.expiryTimer);
        clearTimeout(this.pingTimer);
        clearTimeout(this.pingDeadline);
        clearInterval(this.readObserver);
        controller.abort(cause ?? closedError());
        for (const req of this.requests) req.destroy(cause);
        this.agent?.destroy();
        this.session?.destroy(cause);
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        pool.entries.delete(this);
      },
    };
    this.entries.add(entry);
    this.counters.created++;
    if (entry.expires) {
      entry.expires = Date.now() + entry.expires * 1000;
      const expire = () => {
        if (Date.now() >= entry.expires) entry.retire();
        else {
          entry.expiryTimer = setTimeout(expire, Math.min(entry.expires - Date.now(), 2147483647));
          entry.expiryTimer.unref();
        }
      };
      expire();
    }
    entry.ready = (async () => {
      const tls = config.tls;
      const alpn =
        config.httpVersion === '1.1'
          ? ['http/1.1']
          : config.httpVersion === '2'
            ? ['h2']
            : ['h2', 'http/1.1'];
      const rawNetwork = {
        ...this.network,
        type: 'tcp',
        option: { tls: tls ? { ...tls, alpn } : undefined },
      };
      const options = { ...this.limits, signal: controller.signal };
      const addSocket = (socket) => {
        if (entry.closed) {
          socket.destroy();
          throw closedError();
        }
        entry.sockets.add(socket);
        socket.once('close', () => entry.sockets.delete(socket));
        entry.updateRef();
        return socket;
      };
      const raw = addSocket(await this.dial(rawNetwork, options));
      entry.remoteAddress = raw.remoteAddress;
      entry.version =
        config.httpVersion === 'auto'
          ? raw.alpnProtocol === 'h2'
            ? '2'
            : '1.1'
          : config.httpVersion;
      if (tls && entry.version === '2' && raw.alpnProtocol !== 'h2')
        throw failure('ERR_TRANSPORT', 'XHTTP peer did not negotiate HTTP/2.', 'transport');
      if (entry.version === '2') {
        // TCP is opened allowHalfOpen for other transports. XHTTP owns full
        // connection close semantics, including a peer FIN without GOAWAY.
        raw.once('end', () => entry.destroy(closedError()));
        raw.once('close', () => entry.destroy(closedError()));
        const address = require('node:net').isIPv6(this.network.address)
          ? `[${this.network.address}]`
          : this.network.address;
        const session = (entry.session = http2.connect(
          `${tls ? 'https' : 'http'}://${address}:${this.network.port}`,
          {
            createConnection: () => raw,
            maxSessionMemory: 4,
            maxHeaderListPairs: 64,
            settings: {
              enablePush: false,
              maxHeaderListSize: 8192,
              initialWindowSize: Math.min(config.maxBytes, 65535),
            },
          },
        ));
        session.on('error', (cause) => {
          entry.destroy(transportError(cause));
        });
        // GOAWAY prevents new requests; accepted streams drain without replay.
        session.on('goaway', () => {
          entry.goaway = true;
          entry.retire();
        });
        session.once('close', () => entry.destroy(closedError()));
        const slots = this.limits.xhttpSlots ?? (config.mode === 'stream-one' ? 1 : 2);
        session.on('remoteSettings', (remote) => {
          entry.capacity = Math.floor(remote.maxConcurrentStreams / slots);
          if (entry.capacity < 1) {
            entry.goaway = true;
            entry.retire();
          }
        });
        const period = this.policy.hKeepAlivePeriod;
        if (period >= 0) {
          const interval = (period || 45) * 1000;
          let readBytes = raw.bytesRead;
          const observeRead = () => {
            if (raw.bytesRead === readBytes) return false;
            readBytes = raw.bytesRead;
            if (!entry.closed && !entry.pingDeadline) armPing();
            return true;
          };
          const armPing = () => {
            clearTimeout(entry.pingTimer);
            const due = Date.now() + interval;
            const ping = () => {
              if (entry.closed || entry.goaway) return;
              if (observeRead()) return;
              if (Date.now() < due) {
                entry.pingTimer = setTimeout(ping, Math.min(due - Date.now(), 2147483647));
                entry.pingTimer.unref();
                return;
              }
              if (entry.closed || entry.goaway) return;
              entry.pingDeadline = setTimeout(
                () =>
                  entry.destroy(
                    failure('ERR_TIMEOUT', 'XHTTP HTTP/2 PING timed out.', 'transport'),
                  ),
                config.timeout,
              );
              entry.pingDeadline.unref();
              try {
                session.ping((cause) => {
                  clearTimeout(entry.pingDeadline);
                  entry.pingDeadline = undefined;
                  if (entry.closed) return;
                  if (cause) entry.destroy(transportError(cause));
                  else {
                    pool.counters.pings++;
                    armPing();
                  }
                });
              } catch (cause) {
                entry.destroy(transportError(cause));
              }
            };
            entry.pingTimer = setTimeout(ping, Math.min(interval, 2147483647));
            entry.pingTimer.unref();
          };
          // nghttp2 consumes the socket natively, bypassing JS 'data' events.
          // Its public byte counter includes DATA and control frames, without
          // adding a body consumer or changing stream backpressure. Observation
          // delays an idle PING by at most min(1 s, period / 4).
          entry.readObserver = setInterval(observeRead, Math.min(1000, interval / 4));
          entry.readObserver.unref();
          session.once('connect', armPing);
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => finish(failure('ERR_TIMEOUT', 'XHTTP HTTP/2 settings timed out.', 'transport')),
            config.timeout,
          );
          const finish = (cause) => {
            clearTimeout(timer);
            session.removeListener('remoteSettings', success);
            session.removeListener('error', failed);
            session.removeListener('close', failed);
            cause ? reject(cause) : resolve();
          };
          const success = () =>
            entry.capacity < 1
              ? finish(
                  failure(
                    'ERR_LIMIT',
                    'XHTTP peer stream limit cannot carry this mode.',
                    'transport',
                  ),
                )
              : finish();
          const failed = (cause) => finish(cause instanceof Error ? cause : closedError());
          session.once('remoteSettings', success);
          session.once('error', failed);
          session.once('close', failed);
        });
      } else {
        let first = raw;
        entry.agent = new http.Agent({
          keepAlive: true,
          maxSockets: Math.max(2, config.maxSessions * 2),
          maxFreeSockets: 2,
        });
        entry.agent.createConnection = (_options, callback) => {
          if (entry.closed) return callback(closedError());
          if (first) {
            const socket = first;
            first = undefined;
            callback(null, socket);
            return;
          }
          this.dial(rawNetwork, options).then((socket) => {
            try {
              callback(null, addSocket(socket));
            } catch (cause) {
              callback(cause);
            }
          }, callback);
        };
      }
      entry.initialized = true;
      entry.updateRef();
    })().catch((cause) => {
      entry.destroy(transportError(cause));
      throw transportError(cause);
    });
    entry.ready.catch(() => {});
    return entry;
  }
  close() {
    this.closed = true;
    for (const entry of this.entries) entry.destroy();
  }
}
module.exports = { XmuxPool };
