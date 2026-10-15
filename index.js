'use strict';
const { createRuntime, Runtime } = require('./runtime');
const { checkConfig, normalizeConfig, redact } = require('./config');
const { Js2rayError } = require('./runtime/errors');
const adapters = require('./adapters/http');
const { createWebSocket } = require('./adapters/websocket');
function config(data, options) {
  const runtime = createRuntime(data, options);
  runtime.stop = runtime.close.bind(runtime);
  return runtime;
}
module.exports = {
  ...adapters,
  createWebSocket,
  createRuntime,
  Runtime,
  config,
  checkConfig,
  normalizeConfig,
  redact,
  Js2rayError,
};
