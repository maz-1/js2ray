import api from './index.js';
export const { createRuntime, Runtime, config, checkConfig, normalizeConfig, redact, Js2rayError } =
  api;
export default api;
export const { createHttpAgent, createHttpsAgent, createUndiciConnector, createUndiciDispatcher } =
  api;
