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
module.exports = { Js2rayError, failure };
