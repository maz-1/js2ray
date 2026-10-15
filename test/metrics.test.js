'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRuntime, Js2rayError } = require('../');
const { echo, readBytes } = require('./helpers');

test('metrics count logical stream bytes without starting flowing, snapshots and instances are isolated', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime(),
    other = createRuntime();
  t.after(() => Promise.all([runtime.close(), other.close()]));
  await Promise.all([runtime.start(), other.start()]);
  const stream = await runtime.dial(target);
  assert.notEqual(stream.readableFlowing, true);
  const payload = Buffer.from([0, 1, 255, 99]);
  stream.write(payload);
  assert.deepEqual(await readBytes(stream, payload.length), payload);
  assert.equal(runtime.metrics.bytesWritten, payload.length);
  assert.equal(runtime.metrics.bytesRead, payload.length);
  assert.equal(runtime.metrics.succeeded, 1);
  assert.equal(runtime.metrics.timings.dial.count, 1);
  assert.equal(other.metrics.bytesRead, 0);
  const snapshot = runtime.metrics;
  snapshot.errors.injected = 99;
  assert.equal(runtime.metrics.errors.injected, undefined);
  await runtime.close();
  assert.equal(runtime.metrics.mux.queuedBytes, 0);
});

test('post-connect native errors and write callbacks normalize before subscribers and logs are sanitized', async (t) => {
  const target = await echo(t),
    logs = [],
    errors = [];
  const runtime = createRuntime({}, { logger: (record) => logs.push(record) });
  runtime.on('diagnostic', (error) => errors.push(error));
  t.after(() => runtime.close());
  await runtime.start();
  const stream = await runtime.dial(target);
  const native = Object.assign(new Error('secret.example:12345 UUID hidden'), {
    code: 'ECONNRESET',
  });
  const error = new Promise((resolve) => stream.once('error', resolve));
  stream.destroy(native);
  const received = await error;
  assert.ok(received instanceof Js2rayError);
  assert.equal(received.code, 'ERR_TRANSPORT');
  assert.equal(received.cause, native);
  assert.equal(runtime.metrics.errors.ERR_TRANSPORT, 1);
  assert.equal(JSON.stringify(logs).includes('secret.example'), false);
  assert.equal(errors.length, 1);
  const callbackError = await new Promise((resolve) => stream.write('late', resolve));
  assert.ok(callbackError instanceof Js2rayError);
});

test('failed dials, DNS cache and cancellation are observable with no names in snapshots', async (t) => {
  const runtime = createRuntime(
    {},
    {
      lookup(host, options, callback) {
        if (host === 'cancel.example') return;
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    },
  );
  t.after(() => runtime.close());
  await runtime.start();
  await runtime.resolve('cache.example', { family: 4 });
  await runtime.resolve('cache.example', { family: 4 });
  assert.equal(runtime.metrics.dns.cacheHits, 1);
  assert.equal(runtime.metrics.dns.cacheMisses, 1);
  const abort = new AbortController();
  const pending = runtime.dial({ host: 'cancel.example', port: 80, signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'ERR_CANCELLED' });
  abort.abort();
  await rejected;
  await assert.rejects(runtime.dial({ host: 'bad host', port: 0 }), { code: 'ERR_TARGET' });
  assert.equal(runtime.metrics.failed, 2);
  assert.equal(runtime.metrics.errors.ERR_CANCELLED, 1);
  assert.equal(runtime.metrics.timings.dns.count, 2);
  assert.equal(JSON.stringify(runtime.metrics).includes('.example'), false);
  await runtime.close();
  assert.equal(runtime.metrics.dns.pending, 0);
});
