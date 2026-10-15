'use strict';
const { performance } = require('node:perf_hooks');
class Metrics {
  constructor() {
    this.counters = {
      dials: 0,
      succeeded: 0,
      failed: 0,
      bytesRead: 0,
      bytesWritten: 0,
      datagramsRead: 0,
      datagramsWritten: 0,
      visionSessions: 0,
      visionReadSwitches: 0,
      visionWriteSwitches: 0,
    };
    this.errors = {};
    this.timings = {};
    this.reverse = {};
    this.seen = new WeakSet();
    this.observed = new WeakSet();
    this.inbound = {
      accepted: 0,
      active: 0,
      pending: 0,
      succeeded: 0,
      failed: 0,
      rejected: 0,
      cancelled: 0,
      fallback: 0,
      fallbackActive: 0,
      coverDials: 0,
      coverFailures: 0,
      diagnosticsSuppressed: 0,
    };
    this.diagnosticWindow = { start: 0, count: 0 };
  }
  beginInbound(transport, report) {
    const counts = this.inbound;
    counts.accepted++;
    counts.active++;
    counts.pending++;
    let outcome;
    return {
      finish: (value, error) => {
        if (outcome) return;
        outcome = value;
        counts.pending--;
        counts[value]++;
        if (value === 'fallback') counts.fallbackActive++;
        if (error) {
          error.context = { ...error.context, transport };
          const window = this.diagnosticWindow,
            now = performance.now();
          if (now - window.start >= 1000) {
            window.start = now;
            window.count = 0;
          }
          const diagnostic = window.count++ < 8;
          if (!diagnostic) counts.diagnosticsSuppressed++;
          report(error, { diagnostic });
        }
      },
      cover: (failed) => {
        counts[failed ? 'coverFailures' : 'coverDials']++;
      },
      close: () => {
        counts.active--;
        if (outcome === 'fallback') counts.fallbackActive--;
      },
    };
  }
  error(error) {
    if (this.seen.has(error)) return false;
    this.seen.add(error);
    const code =
      Object.hasOwn(this.errors, error.code) || Object.keys(this.errors).length < 64
        ? error.code
        : 'ERR_OTHER';
    this.errors[code] = (this.errors[code] ?? 0) + 1;
    return true;
  }
  timing(phase, started) {
    const ms = performance.now() - started;
    const item = (this.timings[phase] ??= { count: 0, totalMs: 0, minMs: ms, maxMs: ms });
    item.count++;
    item.totalMs += ms;
    item.minMs = Math.min(item.minMs, ms);
    item.maxMs = Math.max(item.maxMs, ms);
  }
  async measure(phase, operation) {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.timing(phase, started);
    }
  }
  observe(stream, datagram) {
    if (this.observed.has(stream)) return;
    this.observed.add(stream);
    const count = this.counters;
    if (datagram) {
      const receive = stream.receive,
        send = stream.send;
      stream.receive = function (data, ...args) {
        if (!this.destroyed) {
          count.bytesRead += data.length;
          count.datagramsRead++;
        }
        return receive.call(this, data, ...args);
      };
      stream.send = async function (data, ...args) {
        await send.call(this, data, ...args);
        count.bytesWritten += data.length;
        count.datagramsWritten++;
      };
    } else {
      // Observing push/write never installs a data listener or starts flowing.
      const push = stream.push,
        write = stream.write;
      stream.push = function (data, encoding) {
        if (data) count.bytesRead += Buffer.byteLength(data, encoding);
        return push.call(this, data, encoding);
      };
      stream.write = function (data, encoding, callback) {
        if (!this.destroyed && !this.writableEnded)
          count.bytesWritten += Buffer.byteLength(
            data,
            typeof encoding === 'string' ? encoding : undefined,
          );
        return write.call(this, data, encoding, callback);
      };
    }
  }
  snapshot() {
    return structuredClone({
      ...this.counters,
      errors: this.errors,
      timings: this.timings,
      reverseEvents: this.reverse,
      inbound: this.inbound,
    });
  }
}
module.exports = { Metrics };
