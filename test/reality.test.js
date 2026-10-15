'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, checkConfig, redact } = require('..');
const fixture = require('./fixtures/reality');
const { transfer, tlsEcho, flow, udpEcho, datagrams } = require('./fixtures/vision');
const { echo } = require('./helpers');
const { once } = require('node:events');
const tls = require('node:tls');
const { write } = require('../runtime/streams');
const { readBytes, listen } = require('./helpers');
const { cert, id } = require('./fixtures/vision');
for (const version of [undefined, 'TLSv1.2', 'TLSv1.3']) {
  for (const vision of [false, true]) {
    test(`REALITY Runtime ${vision ? 'Vision' : 'empty flow'} ${version ?? 'ordinary TCP'}`, async (t) => {
      const cover = await fixture.cover(t),
        target = version ? await tlsEcho(t, version) : await echo(t);
      const server = createRuntime({ inbounds: [fixture.bound(0, cover, vision ? flow : '')] });
      await server.start();
      t.after(() => server.close());
      const client = createRuntime({
        outbounds: [
          fixture.bound(server.listenersInfo[0].address.port, undefined, vision ? flow : ''),
        ],
      });
      await client.start();
      t.after(() => client.close());
      await transfer(client, target, version);
      for (const runtime of [client, server]) {
        assert.equal(runtime.metrics.visionReadSwitches, vision && version === 'TLSv1.3' ? 1 : 0);
        assert.equal(runtime.metrics.visionWriteSwitches, vision && version === 'TLSv1.3' ? 1 : 0);
      }
      await client.close();
      await server.close();
      assert.equal(client.stats.connections + server.stats.connections, 0);
    });
  }
}
test('REALITY Vision XUDP preserves boundaries', async (t) => {
  const cover = await fixture.cover(t),
    target = await udpEcho(t);
  const server = createRuntime({ inbounds: [fixture.bound(0, cover, flow)] });
  await server.start();
  t.after(() => server.close());
  const client = createRuntime({
    outbounds: [fixture.bound(server.listenersInfo[0].address.port, undefined, flow)],
  });
  await client.start();
  t.after(() => client.close());
  await datagrams(client, target);
});
test('REALITY config validates key/short ID/destination/security and redacts credentials', () => {
  const valid = fixture.bound(443);
  assert.equal(checkConfig({ outbounds: [valid] }).ok, true);
  const encoded = JSON.stringify(redact(valid));
  for (const value of [fixture.publicKey, fixture.shortId])
    assert.equal(encoded.includes(value), false);
  for (const changed of [
    { publicKey: 'bad' },
    { shortId: 'a' },
    { shortId: 'ff'.repeat(9) },
    { serverName: '127.0.0.1' },
    { fingerprint: 'chrome_pq' },
    { show: true },
    { spiderX: '/' },
  ]) {
    const bound = structuredClone(valid);
    Object.assign(bound.networks[0].option.reality, changed);
    assert.equal(checkConfig({ outbounds: [bound] }).ok, false);
  }
  const mixed = structuredClone(valid);
  mixed.networks[0].option.tls = {};
  assert.equal(checkConfig({ outbounds: [mixed] }).ok, false);
  const legacy = {
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [{ address: '127.0.0.1', port: 443, users: [{ id, encryption: 'none', flow }] }],
        },
        streamSettings: {
          network: 'raw',
          security: 'reality',
          realitySettings: { ...fixture.client, fingerprint: 'chrome' },
        },
      },
    ],
  };
  assert.equal(checkConfig(legacy).ok, true);
  legacy.outbounds[0].streamSettings.realitySettings.spiderX = '/';
  assert.equal(checkConfig(legacy).ok, false);
  const inbound = fixture.bound(0, { port: 443 });
  assert.equal(JSON.stringify(redact(inbound)).includes(fixture.privateKey), false);
  for (const changed of [
    { shortIds: ['', '00'] },
    { minClientVer: '5.0.0', maxClientVer: '4.0.0' },
    { dest: 'host:no' },
    { xver: 1 },
    { serverNames: [] },
  ]) {
    const bound = structuredClone(inbound);
    Object.assign(bound.networks[0].option.reality, changed);
    assert.equal(checkConfig({ inbounds: [bound] }).ok, false);
  }
});

test('REALITY cover destinations use bootstrap DNS hosts and support IPv6 loopback', async (t) => {
  for (const host of ['127.0.0.1', '::1']) {
    const cover = await fixture.cover(t, host),
      target = await echo(t);
    const inbound = fixture.bound(0, cover);
    inbound.networks[0].option.reality.dest =
      host === '::1' ? `[::1]:${cover.port}` : `cover.js2ray.test:${cover.port}`;
    const server = createRuntime({
      inbounds: [inbound],
      dns: { hosts: { 'cover.js2ray.test': '127.0.0.1' } },
    });
    await server.start();
    t.after(() => server.close());
    const outbound = fixture.bound(server.listenersInfo[0].address.port);
    outbound.networks[0].option.reality.serverName = 'JS2RAY.TEST.';
    const client = createRuntime({ outbounds: [outbound] });
    await client.start();
    t.after(() => client.close());
    await transfer(client, target);
  }
});

test('REALITY forwards unauthenticated native TLS to the fixed cover and preserves payload plus EOF', async (t) => {
  const cover = await fixture.cover(t);
  const server = createRuntime({ inbounds: [fixture.bound(0, cover)] });
  await server.start();
  t.after(() => server.close());
  const stream = tls.connect({
    host: '127.0.0.1',
    port: server.listenersInfo[0].address.port,
    ca: cert,
    servername: 'js2ray.test',
  });
  stream.on('error', () => {});
  t.after(() => stream.destroy());
  await once(stream, 'secureConnect');
  const payload = require('node:crypto').randomBytes(65539),
    reply = readBytes(stream, payload.length);
  stream.end(payload);
  assert.deepEqual(await reply, payload);
  stream.resume();
  await once(stream, 'end');
  assert.equal(server.metrics.visionSessions, 0);
});

test('REALITY malformed or truncated ClientHello fallback preserves every consumed and unread byte', async (t) => {
  const target = await echo(t);
  const server = createRuntime({ inbounds: [fixture.bound(0, target)] });
  await server.start();
  t.after(() => server.close());
  for (const bytes of [
    Buffer.concat([Buffer.from('not-tls'), require('node:crypto').randomBytes(65539)]),
    Buffer.from('16030300100100000c0303', 'hex'),
  ]) {
    const raw = await fixture.tcp(server.listenersInfo[0].address.port);
    t.after(() => raw.destroy());
    const reply = readBytes(raw, bytes.length);
    for (let n = 0; n < Math.min(7, bytes.length); n++) await write(raw, bytes.subarray(n, n + 1));
    raw.end(bytes.subarray(Math.min(7, bytes.length)));
    assert.deepEqual(await reply, bytes);
  }
});

test('REALITY rejects wrong keys, short IDs, names and versions before sending application data', async (t) => {
  const cover = await fixture.cover(t),
    target = await echo(t);
  let reached = 0;
  target.server.on('connection', () => reached++);
  const inbound = fixture.bound(0, cover);
  inbound.networks[0].option.reality.minClientVer = '4.0.0';
  const server = createRuntime({ inbounds: [inbound] });
  await server.start();
  t.after(() => server.close());
  for (const changed of [
    { shortId: 'ff' },
    { serverName: 'wrong.test' },
    { publicKey: Buffer.alloc(32, 9).toString('base64url') },
    { clientVersion: '3.255.255' },
  ]) {
    const bound = fixture.bound(server.listenersInfo[0].address.port);
    Object.assign(bound.networks[0].option.reality, changed);
    const client = createRuntime({ outbounds: [bound] });
    await client.start();
    t.after(() => client.close());
    await assert.rejects(client.dial(target), (error) =>
      /^ERR_(AUTH|TLS|PROTOCOL)$/.test(error.code),
    );
  }
  assert.equal(reached, 0);
});

test('REALITY handshake timeout, pending and established cancellation, inbound deadline and close clean up sockets', async (t) => {
  const net = require('node:net'),
    sockets = new Set();
  const blackhole = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
  });
  const port = await listen(blackhole);
  t.after(() => {
    for (const raw of sockets) raw.destroy();
    return new Promise((resolve) => blackhole.close(resolve));
  });
  const client = createRuntime({
    outbounds: [fixture.bound(port)],
    limits: { handshakeTimeoutMs: 30 },
  });
  await client.start();
  t.after(() => client.close());
  await assert.rejects(client.dial({ host: '127.0.0.1', port: 80 }), { code: 'ERR_TIMEOUT' });
  const controller = new AbortController();
  const pending = client.dial({ host: '127.0.0.1', port: 80, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ERR_CANCELLED' });
  controller.abort();
  await rejected;
  const server = createRuntime({
    inbounds: [fixture.bound(0, { port })],
    limits: { handshakeTimeoutMs: 30, maxConnections: 1 },
  });
  await server.start();
  t.after(() => server.close());
  const raw = await fixture.tcp(server.listenersInfo[0].address.port);
  raw.once('end', () => raw.destroy());
  raw.resume();
  await once(raw, 'close');
  const cover = await fixture.cover(t),
    target = await echo(t);
  const good = createRuntime({ inbounds: [fixture.bound(0, cover)] });
  await good.start();
  t.after(() => good.close());
  const outbound = createRuntime({
    outbounds: [fixture.bound(good.listenersInfo[0].address.port)],
  });
  await outbound.start();
  t.after(() => outbound.close());
  const abort = new AbortController(),
    stream = await outbound.dial({ ...target, signal: abort.signal });
  const error = once(stream, 'error');
  abort.abort();
  assert.equal((await error)[0].code, 'ERR_CANCELLED');
  await outbound.close();
  await client.close();
  await server.close();
  await good.close();
  assert.equal(
    client.stats.pendingDials + outbound.stats.connections + server.stats.connections,
    0,
  );
});

test('REALITY caps pending inbound connections before cover dialing and closes held handshakes on shutdown', async (t) => {
  const net = require('node:net'),
    sockets = new Set();
  let accepted;
  const entered = new Promise((resolve) => {
    accepted = resolve;
  });
  const target = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    accepted();
  });
  const port = await listen(target);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => target.close(resolve));
  });
  const server = createRuntime({
    inbounds: [fixture.bound(0, { port })],
    limits: { maxConnections: 1 },
  });
  await server.start();
  t.after(() => server.close());
  const first = await fixture.tcp(server.listenersInfo[0].address.port);
  t.after(() => first.destroy());
  await entered;
  const second = await fixture.tcp(server.listenersInfo[0].address.port);
  t.after(() => second.destroy());
  second.once('end', () => second.destroy());
  second.resume();
  await once(second, 'close');
  assert.equal(sockets.size, 1);
  const ended = once(first, 'end');
  first.resume();
  await server.close();
  await ended;
  first.destroy();
  assert.equal(server.stats.listeners + server.stats.connections, 0);
});

test('REALITY same-port key, short ID, UUID and cover rotation preserves a Vision Direct stream and rolls back failures', async (t) => {
  const { createRuntimeManager } = require('..'),
    crypto = require('node:crypto');
  const target = await tlsEcho(t, 'TLSv1.3'),
    cover = await fixture.cover(t),
    nextCover = await fixture.cover(t);
  const manager = createRuntimeManager({ inbounds: [fixture.bound(0, cover, flow)] });
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  async function client(bound) {
    const runtime = createRuntime({ outbounds: [bound] });
    await runtime.start();
    t.after(() => runtime.close());
    return runtime;
  }
  const old = await client(fixture.bound(port, undefined, flow)),
    tunnel = await old.dial(target);
  const held = tls.connect({
    socket: tunnel,
    ca: cert,
    servername: 'js2ray.test',
    minVersion: 'TLSv1.3',
  });
  held.on('error', () => {});
  t.after(() => {
    held.destroy();
    tunnel.destroy();
  });
  await once(held, 'secureConnect');
  await write(held, Buffer.from('before'));
  await readBytes(held, 6);
  const keys = crypto.generateKeyPairSync('x25519'),
    nextId = 'ea872601-5fc7-433d-b02a-44376cab86a1';
  const next = fixture.bound(0, nextCover, flow);
  next.users[0].id = nextId;
  Object.assign(next.networks[0].option.reality, {
    privateKey: keys.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .subarray(-32)
      .toString('base64url'),
    shortIds: ['abcd'],
  });
  const cutover = await manager.rotate({ inbounds: [next] }, { drainTimeoutMs: 10000 });
  assert.equal(manager.listenersInfo[0].address.port, port);
  await write(held, Buffer.from('retained'));
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  await assert.rejects(old.dial(target));
  const newBound = fixture.bound(port, undefined, flow);
  newBound.users[0].id = nextId;
  Object.assign(newBound.networks[0].option.reality, {
    publicKey: keys.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64url'),
    shortId: 'abcd',
  });
  const fresh = await client(newBound);
  await transfer(fresh, target, 'TLSv1.3');
  await assert.rejects(
    manager.rotate(
      { inbounds: [fixture.bound(0, cover, flow)] },
      {
        ready: async () => {
          throw Error('candidate rejected');
        },
      },
    ),
  );
  const invalid = structuredClone(next);
  invalid.networks[0].option.reality.privateKey = 'invalid';
  await assert.rejects(manager.rotate({ inbounds: [invalid] }), { code: 'ERR_CONFIG' });
  await transfer(fresh, target, 'TLSv1.3');
  held.destroy();
  tunnel.destroy();
  await cutover.drained;
  assert.equal(manager.stats.generations, 1);
  assert.notEqual(nextId, id);
});

test(
  'REALITY 100 concurrent Vision TLS 1.3 streams retain both Direct switches and close without queued bytes',
  { timeout: 30000 },
  async (t) => {
    const cover = await fixture.cover(t),
      target = await tlsEcho(t, 'TLSv1.3');
    const server = createRuntime({ inbounds: [fixture.bound(0, cover, flow)] });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [fixture.bound(server.listenersInfo[0].address.port, undefined, flow)],
    });
    await client.start();
    t.after(() => client.close());
    await Promise.all(Array.from({ length: 100 }, () => transfer(client, target, 'TLSv1.3')));
    for (const runtime of [client, server]) {
      assert.equal(runtime.metrics.visionReadSwitches, 100);
      assert.equal(runtime.metrics.visionWriteSwitches, 100);
    }
    await client.close();
    await server.close();
    assert.equal(
      client.stats.connections + server.stats.connections + client.metrics.mux.queuedBytes,
      0,
    );
  },
);
