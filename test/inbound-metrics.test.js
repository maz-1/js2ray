'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createRuntime, createRuntimeManager } = require('..');
const { Metrics } = require('../runtime/metrics');
const { listen, echo, readBytes } = require('./helpers');
const reality = require('./fixtures/reality');
const vision = require('./fixtures/vision');
const { write } = require('../runtime/streams');
const { waitFor } = require('./fixtures/reverse');
async function blackhole(t) {
  const sockets = new Set();
  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
    raw.once('close', () => sockets.delete(raw));
  });
  const port = await listen(server);
  t.after(() => {
    for (const raw of sockets) raw.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return { port };
}
async function closed(raw) {
  const done = once(raw, 'close');
  raw.once('end', () => raw.destroy());
  raw.resume();
  await done;
}
test('inbound REALITY timeout and cover failure report once without peer or secret details', async (t) => {
  const cover = await blackhole(t),
    logs = [],
    errors = [];
  const runtime = createRuntime(
    { inbounds: [reality.bound(0, cover)], limits: { handshakeTimeoutMs: 30 } },
    { logger: (record) => logs.push(record) },
  );
  runtime.on('diagnostic', (error) => errors.push(error));
  await runtime.start();
  t.after(() => runtime.close());
  const raw = await reality.tcp(runtime.listenersInfo[0].address.port);
  raw.write(Buffer.from('16030300', 'hex'));
  await closed(raw);
  assert.equal(runtime.metrics.inbound.failed, 1);
  assert.equal(runtime.metrics.errors.ERR_TIMEOUT, 1);
  assert.equal(errors.length, 1);
  await waitFor(() => runtime.metrics.inbound.active === 0);
  assert.equal(runtime.metrics.inbound.active + runtime.metrics.inbound.pending, 0);
  assert.equal(runtime.metrics.inbound.coverDials, 1);
  assert.equal(JSON.stringify(logs).includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(logs).includes(reality.privateKey), false);
  const reservation = net.createServer(),
    port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const refused = createRuntime({ inbounds: [reality.bound(0, { port })] });
  await refused.start();
  t.after(() => refused.close());
  await closed(await reality.tcp(refused.listenersInfo[0].address.port));
  assert.equal(refused.metrics.inbound.coverFailures, 1);
  assert.equal(refused.metrics.errors.ERR_TRANSPORT, 1);
  assert.equal(refused.metrics.inbound.failed, 1);
});
test('inbound REALITY fallback is observable separately from errors and drains its active gauge', async (t) => {
  const cover = await echo(t),
    runtime = createRuntime({ inbounds: [reality.bound(0, cover)] });
  await runtime.start();
  t.after(() => runtime.close());
  const raw = await reality.tcp(runtime.listenersInfo[0].address.port),
    payload = Buffer.from('ordinary-cover-request');
  await write(raw, payload);
  assert.deepEqual(await readBytes(raw, payload.length), payload);
  assert.equal(runtime.metrics.inbound.fallback, 1);
  assert.equal(runtime.metrics.inbound.fallbackActive, 1);
  assert.deepEqual(runtime.metrics.errors, {});
  raw.end();
  await closed(raw);
  assert.equal(
    runtime.metrics.inbound.fallbackActive +
      runtime.metrics.inbound.active +
      runtime.metrics.inbound.pending,
    0,
  );
});
test('inbound pending limit and runtime shutdown have distinct, single outcomes', async (t) => {
  const cover = await blackhole(t),
    runtime = createRuntime({ inbounds: [reality.bound(0, cover)], limits: { maxConnections: 1 } });
  await runtime.start();
  t.after(() => runtime.close());
  const first = await reality.tcp(runtime.listenersInfo[0].address.port);
  await closed(await reality.tcp(runtime.listenersInfo[0].address.port));
  assert.equal(runtime.metrics.inbound.rejected, 1);
  assert.equal(runtime.metrics.errors.ERR_LIMIT, 1);
  const done = closed(first);
  await runtime.close();
  await done;
  await waitFor(() => runtime.metrics.inbound.active === 0);
  assert.equal(runtime.metrics.inbound.cancelled, 1);
  assert.equal(runtime.metrics.inbound.failed, 0);
  assert.equal(runtime.metrics.inbound.active + runtime.metrics.inbound.pending, 0);
});
for (const type of ['tls', 'wss', 'vision', 'xhttp'])
  test(`inbound ${type} early handshake failures are counted and diagnosed once`, async (t) => {
    const bound = vision.bound(0, true);
    if (type !== 'vision') bound.users[0].flow = '';
    if (type === 'wss') bound.networks[0].type = 'ws';
    if (type === 'xhttp') {
      bound.networks[0].type = 'xhttp';
      bound.networks[0].option.httpVersion = '2';
    }
    const runtime = createRuntime({ inbounds: [bound], limits: { handshakeTimeoutMs: 40 } });
    await runtime.start();
    t.after(() => runtime.close());
    const raw = await reality.tcp(runtime.listenersInfo[0].address.port);
    raw.write(Buffer.from('16030300', 'hex'));
    await closed(raw);
    assert.equal(runtime.metrics.inbound.accepted, 1);
    assert.equal(runtime.metrics.inbound.failed, 1);
    await waitFor(() => runtime.metrics.inbound.active === 0);
    assert.equal(runtime.metrics.inbound.active + runtime.metrics.inbound.pending, 0);
    assert.equal(
      Object.values(runtime.metrics.errors).reduce((a, b) => a + b, 0),
      1,
    );
  });
test('inbound WebSocket Upgrade rejection is visible before a logical stream exists', async (t) => {
  const bound = vision.bound(0);
  delete bound.networks[0].option.tls;
  bound.networks[0].type = 'ws';
  bound.networks[0].option.path = '/accepted';
  bound.users[0].flow = '';
  const runtime = createRuntime({ inbounds: [bound] });
  await runtime.start();
  t.after(() => runtime.close());
  const raw = await reality.tcp(runtime.listenersInfo[0].address.port);
  raw.write(
    'GET /wrong HTTP/1.1\r\nHost: synthetic.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
  );
  await closed(raw);
  assert.equal(runtime.metrics.inbound.failed, 1);
  assert.equal(runtime.metrics.errors.ERR_PROTOCOL, 1);
});
test('inbound failure metrics remain exact when diagnostic emission is sampled', () => {
  const metrics = new Metrics(),
    reports = [];
  for (let n = 0; n < 32; n++) {
    const observer = metrics.beginInbound('reality', (error, options) =>
      reports.push({ error, options }),
    );
    observer.finish(
      'failed',
      require('../runtime/errors').failure('ERR_TLS', 'Synthetic failure.', 'inbound'),
    );
    observer.finish('succeeded');
    observer.close();
  }
  assert.equal(metrics.snapshot().inbound.failed, 32);
  assert.equal(reports.filter((r) => r.options.diagnostic).length, 8);
  assert.equal(metrics.snapshot().inbound.diagnosticsSuppressed, 24);
  assert.equal(metrics.snapshot().inbound.active + metrics.snapshot().inbound.pending, 0);
});
test('inbound success metrics belong to their configuration generation while an old stream drains', async (t) => {
  const target = await echo(t),
    config = { inbounds: [vision.bound(0, true)] },
    manager = createRuntimeManager(config);
  await manager.start();
  t.after(() => manager.close());
  const client = createRuntime({
    outbounds: [vision.bound(manager.listenersInfo[0].address.port)],
  });
  await client.start();
  t.after(() => client.close());
  const held = await client.dial(target);
  await write(held, Buffer.from('held'));
  await readBytes(held, 4);
  const cutover = await manager.rotate(config, { drainTimeoutMs: 3000 });
  const fresh = await client.dial(target);
  await write(fresh, Buffer.from('fresh'));
  await readBytes(fresh, 5);
  assert.deepEqual(
    manager.metrics.map((g) => g.metrics.inbound.succeeded),
    [1, 1],
  );
  assert.deepEqual(
    manager.metrics.map((g) => g.metrics.inbound.pending),
    [0, 0],
  );
  held.destroy();
  fresh.destroy();
  await cutover.drained;
  await manager.close();
});
