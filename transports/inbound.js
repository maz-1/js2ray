'use strict';
const { failure } = require('../runtime/errors');
// One physical connection owns one transport-handshake outcome, including early
// closes. The owner is captured before rotation; no peer names enter metrics.
function watch(raw, options, transport) {
  const owner = options.inbound?.(transport);
  let finished = false;
  const finish = (outcome, error) => {
    if (finished) return;
    finished = true;
    owner?.finish(outcome, error);
  };
  raw.once('error', (cause) =>
    finish('failed', failure('ERR_TRANSPORT', 'Inbound transport failed.', 'inbound', cause)),
  );
  raw.once('close', () => {
    finish(
      'failed',
      failure(
        transport.includes('tls') || transport === 'wss' ? 'ERR_TLS' : 'ERR_PROTOCOL',
        'Inbound transport closed during handshake.',
        'inbound',
      ),
    );
    owner?.close();
  });
  return {
    success: () => finish('succeeded'),
    fallback: () => finish('fallback'),
    fail: (error) => finish('failed', error),
    reject: () =>
      finish('rejected', failure('ERR_LIMIT', 'Inbound connection limit exceeded.', 'inbound')),
    timeout: () =>
      finish('failed', failure('ERR_TIMEOUT', 'Inbound handshake timed out.', 'inbound')),
    cancel: () => finish('cancelled'),
    cover: (failed = false) => owner?.cover(failed),
  };
}
module.exports = { watch };
