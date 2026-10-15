'use strict';

class Js2rayError extends Error {
  constructor(code, message, { phase = 'runtime', cause, context = {} } = {}) {
    super(message, { cause });
    this.name = 'Js2rayError';
    this.code = code;
    this.phase = phase;
    this.context = context;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      phase: this.phase,
      context: this.context,
    };
  }
}
function failure(code, message, phase, cause) {
  return new Js2rayError(code, message, { phase, cause });
}
function normalizeError(cause, phase = 'transport') {
  if (cause instanceof Js2rayError) return cause;
  const code = cause?.code;
  if (code === 'ABORT_ERR')
    return failure('ERR_CANCELLED', 'Operation was cancelled.', phase, cause);
  if (code === 'ETIMEDOUT') return failure('ERR_TIMEOUT', 'Operation timed out.', phase, cause);
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
    return failure('ERR_DNS', 'Name resolution failed.', 'dns', cause);
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_|SELF_SIGNED|UNABLE_TO_)/.test(code ?? ''))
    return failure('ERR_TLS', 'TLS operation failed.', 'tls', cause);
  return failure(
    phase === 'dns' ? 'ERR_DNS' : 'ERR_TRANSPORT',
    'Network operation failed.',
    phase,
    cause,
  );
}
// Preserve the native Socket/Datagram object and its half-close contract. Error
// normalization occurs before any subscriber observes the error event.
const normalized = Symbol('normalizedErrors');
function normalizeEmitter(stream, report) {
  if (stream[normalized]) return stream;
  stream[normalized] = true;
  const emit = stream.emit;
  stream.emit = function (event, ...args) {
    if (event === 'error') {
      args[0] = normalizeError(args[0]);
      report(args[0]);
    }
    return emit.call(this, event, ...args);
  };
  if (typeof stream.write === 'function') {
    const write = stream.write;
    stream.write = function (data, encoding, callback) {
      const wrap = (fn) =>
        typeof fn === 'function' ? (error) => fn(error ? normalizeError(error) : undefined) : fn;
      return typeof encoding === 'function'
        ? write.call(this, data, wrap(encoding))
        : write.call(this, data, encoding, wrap(callback));
    };
  }
  return stream;
}
module.exports = { Js2rayError, failure, normalizeError, normalizeEmitter };
