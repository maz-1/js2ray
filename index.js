'use strict';
const { createRuntime, Runtime } = require('./runtime');
const { checkConfig, normalizeConfig, redact } = require('./config');
const { Js2rayError } = require('./runtime/errors');
function config(data, options) {
  const runtime = createRuntime(data, options);
  runtime.stop = runtime.close.bind(runtime);
  return runtime;
}
module.exports = {
  createRuntime,
  Runtime,
  config,
  checkConfig,
  normalizeConfig,
  redact,
  Js2rayError,
};
