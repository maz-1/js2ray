'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createRuntime, checkConfig } = require('..');
const { echo, readBytes } = require('./helpers');
const { portalConfig, bridgeConfig, waitFor } = require('./fixtures/reverse');
test('Bridge and Portal route concurrent business sessions with no Bridge listeners', async (t) => {
  const destination = await echo(t),
    portal = createRuntime(portalConfig(0));
  await portal.start();
  t.after(() => portal.close());
  const configuration = bridgeConfig(portal.listenersInfo[0].address.port, destination);
  configuration.outbounds.push({ tag: 'missing-metadata', protocol: 'blackhole' });
  configuration.routing.rules.unshift(
    { source: ['127.0.0.1'], outboundTag: 'missing-metadata' },
    { user: ['tenant@synthetic'], outboundTag: 'missing-metadata' },
  );
  const bridge = createRuntime(configuration);
  const events = [];
  bridge.on('reverse', (event) => events.push(event));
  await bridge.start();
  t.after(() => bridge.close());
  await waitFor(() => events.some((event) => event.state === 'active'));
  assert.equal(bridge.listenersInfo.length, 0);
  await Promise.all(
    Array.from({ length: 24 }, async (_, i) => {
      const stream = await portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
      const payload = Buffer.alloc(16384, i);
      stream.write(payload);
      assert.deepEqual(await readBytes(stream, payload.length), payload);
      stream.destroy();
    }),
  );
  await bridge.close();
  await waitFor(() => portal.stats.reverse[0].transports === 0);
  assert.equal(bridge.stats.connections, 0);
  await assert.rejects(portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' }), {
    code: 'ERR_REVERSE',
  });
});
test('registered in-process service has an exact target scope and is closed with runtime', async (t) => {
  const runtime = createRuntime(
    {
      outbounds: [
        { protocol: 'service', service: 'echo', allow: { host: 'service.test', port: 80 } },
      ],
    },
    { services: { echo: () => new PassThrough() } },
  );
  await runtime.start();
  t.after(() => runtime.close());
  const stream = await runtime.dial({ host: 'service.test', port: 80 });
  stream.write('service');
  assert.equal((await readBytes(stream, 7)).toString(), 'service');
  await assert.rejects(runtime.dial({ host: 'other.test', port: 80 }), { code: 'ERR_BLOCKED' });
  await runtime.close();
  assert.equal(stream.destroyed, true);
  assert.equal(
    checkConfig({ reverse: { portals: [{ tag: 'direct', domain: 'control.test' }] } }).ok,
    false,
  );
});
test('missing and invalid service handlers fail with structured errors and clean resources', async () => {
  const config = {
    outbounds: [
      { protocol: 'service', service: 'test', allow: { host: 'service.test', port: 80 } },
    ],
  };
  const missing = createRuntime(config);
  await assert.rejects(missing.start(), { code: 'ERR_CONFIG' });
  assert.equal(missing.state, 'closed');
  const invalid = createRuntime(config, { services: { test: () => ({}) } });
  await invalid.start();
  try {
    await assert.rejects(invalid.dial({ host: 'service.test', port: 80 }), {
      code: 'ERR_PROTOCOL',
    });
  } finally {
    await invalid.close();
  }
});
test('Portal restart ends affected streams and Bridge reconnects without replay', async (t) => {
  const destination = await echo(t),
    first = createRuntime(portalConfig(0));
  await first.start();
  t.after(() => first.close());
  const port = first.listenersInfo[0].address.port;
  const bridge = createRuntime(bridgeConfig(port, destination));
  const events = [];
  bridge.on('reverse', (event) => events.push(event));
  await bridge.start();
  t.after(() => bridge.close());
  await waitFor(() => events.some((event) => event.state === 'active'));
  const stream = await first.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
  stream.write('before');
  assert.equal((await readBytes(stream, 6)).toString(), 'before');
  await first.close();
  assert.equal(stream.destroyed, true);
  const second = createRuntime(portalConfig(port));
  await second.start();
  t.after(() => second.close());
  await waitFor(() => second.stats.reverse[0].active > 0);
  const next = await second.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
  next.write('after');
  assert.equal((await readBytes(next, 5)).toString(), 'after');
  next.destroy();
  assert.ok(events.some((event) => event.state === 'disconnected'));
});
test('reverse drains a busy transport after its session budget and releases it after held business closes', async (t) => {
  const destination = await echo(t),
    portal = createRuntime(portalConfig(0));
  await portal.start();
  t.after(() => portal.close());
  const config = bridgeConfig(portal.listenersInfo[0].address.port, destination);
  const bridge = createRuntime(config);
  const events = [];
  portal.on('reverse', (event) => events.push(event));
  await bridge.start();
  t.after(() => bridge.close());
  await waitFor(() => portal.stats.reverse[0].active > 0);
  const held = await portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
  held.write('held');
  assert.equal((await readBytes(held, 4)).toString(), 'held');
  for (let i = 0; i < 258; i++) {
    await waitFor(() => portal.stats.reverse[0].active > 0);
    const stream = await portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
    stream.write('x');
    assert.equal((await readBytes(stream, 1)).toString(), 'x');
    stream.destroy();
  }
  await waitFor(() => events.some((event) => event.state === 'draining'));
  await waitFor(() => portal.stats.reverse[0].active > 0);
  held.write('after');
  assert.equal((await readBytes(held, 5)).toString(), 'after');
  held.destroy();
  await waitFor(() => portal.stats.reverse[0].transports === 1);
  assert.equal(bridge.listenersInfo.length, 0);
});
