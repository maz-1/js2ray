'use strict';
const { failure } = require('./errors');

// Read only requested bytes. Surplus stays on the paused stream for its next owner.
class StreamReader {
  constructor(stream, { signal, timeoutMs = 10000, maxBytes = 65536, onRead } = {}) {
    this.stream = stream;
    this.signal = signal;
    this.maxBytes = maxBytes;
    this.deadline = Date.now() + timeoutMs;
    this.total = 0;
    this.onRead = onRead;
    stream.pause();
  }
  async read(size) {
    if (!Number.isInteger(size) || size < 0 || this.total + size > this.maxBytes)
      throw failure('ERR_LIMIT', 'Handshake exceeds the byte limit.', 'protocol');
    this.total += size;
    const parts = [];
    let remaining = size;
    while (remaining) {
      if (this.signal?.aborted)
        throw failure('ERR_CANCELLED', 'Handshake was cancelled.', 'protocol', this.signal.reason);
      const chunk = this.stream.read(Math.min(remaining, this.stream.readableLength || remaining));
      if (chunk) {
        this.onRead?.(chunk);
        parts.push(chunk);
        remaining -= chunk.length;
        continue;
      }
      if (this.stream.destroyed || this.stream.readableEnded)
        throw failure('ERR_PROTOCOL', 'Peer closed during handshake.', 'protocol');
      this.stream.requestRecord?.();
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          for (const event of ['readable', 'end', 'close'])
            this.stream.removeListener(event, listeners[event]);
          this.stream.removeListener('error', onError);
          this.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error) => {
          cleanup();
          error ? reject(error) : resolve();
        };
        const onError = (error) => finish(error);
        const onAbort = () =>
          finish(
            failure('ERR_CANCELLED', 'Handshake was cancelled.', 'protocol', this.signal.reason),
          );
        const listeners = {
          readable: () => finish(),
          end: () => finish(failure('ERR_PROTOCOL', 'Truncated handshake.', 'protocol')),
          close: () => finish(failure('ERR_PROTOCOL', 'Peer closed during handshake.', 'protocol')),
        };
        const timer = setTimeout(
          () => finish(failure('ERR_TIMEOUT', 'Protocol handshake timed out.', 'protocol')),
          Math.max(1, this.deadline - Date.now()),
        );
        for (const [event, listener] of Object.entries(listeners))
          this.stream.once(event, listener);
        this.stream.once('error', onError);
        this.signal?.addEventListener('abort', onAbort, { once: true });
        if (this.signal?.aborted) onAbort();
      });
    }
    return Buffer.concat(parts, size);
  }
}
module.exports = { StreamReader };
