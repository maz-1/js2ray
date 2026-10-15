'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, createRuntimeManager, checkConfig } = require('..');
const { echo, readBytes } = require('./helpers');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const tls = require('node:tls');
const { write } = require('../runtime/streams');
const { encodeRequest, readRequest } = require('../protocols/vless');
const {
  id,
  flow,
  cert,
  bound,
  tlsEcho,
  transfer,
  udpEcho,
  datagrams,
} = require('./fixtures/vision');
const { Decoder, state, inspect } = require('../protocols/vless/vision');
const uuid = Buffer.from(id.replaceAll('-', ''), 'hex');

test('Vision config requires raw TLS, validates flow, disallows TCP Mux and selects XUDP', () => {
  const good = bound(443);
  assert.equal(checkConfig({ outbounds: [good] }).ok, true);
  assert.equal(checkConfig({ outbounds: [good] }).config.outbounds[0].packetEncoding, 'xudp');
  for (const invalid of [
    { ...good, mux: { enabled: true } },
    { ...good, packetEncoding: 'none' },
    { ...good, users: [{ id, encryption: 'none', flow: 'xtls-rprx-splice' }] },
    { ...good, networks: [{ address: '127.0.0.1', port: 443 }] },
    { ...good, networks: [{ ...good.networks[0], type: 'ws' }] },
    { ...good, networks: [{ ...good.networks[0], type: 'xhttp' }] },
  ])
    assert.equal(checkConfig({ outbounds: [invalid] }).ok, false);
  assert.equal(
    checkConfig({
      outbounds: [{ ...good, users: [{ id, encryption: 'none', flow: flow + '-udp443' }] }],
    }).ok,
    true,
  );
  assert.equal(
    checkConfig({ inbounds: [{ ...bound(0, true), users: [{ id, flow: flow + '-udp443' }] }] }).ok,
    false,
  );
});

test('Vision decoder fixed vector: every split, UUID, Continue, Direct and trailing bytes', () => {
  const wire = Buffer.concat([
    uuid,
    Buffer.from('0000030002616263000002000200016465006667', 'hex'),
  ]);
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new Decoder(uuid);
    const result = Buffer.concat([
      ...decoder.decode(wire.subarray(0, split)),
      ...decoder.decode(wire.subarray(split)),
    ]);
    assert.equal(result.toString(), 'abcdefg');
    assert.equal(decoder.direct, true);
    decoder.finish();
  }
  const decoder = new Decoder(uuid);
  assert.equal(
    Buffer.concat([...wire].flatMap((byte) => decoder.decode(Buffer.from([byte])))).toString(),
    'abcdefg',
  );
});

test('Vision decoder rejects invalid UUID, command and every truncated frame', () => {
  const wire = Buffer.concat([uuid, Buffer.from([1, 0, 3, 0, 2]), Buffer.from('abc\0\0')]);
  for (let size = 0; size < wire.length; size++) {
    const decoder = new Decoder(uuid);
    decoder.decode(wire.subarray(0, size));
    assert.throws(() => decoder.finish(), { code: 'ERR_PROTOCOL' });
  }
  assert.throws(() => new Decoder(Buffer.alloc(16)).decode(wire), { code: 'ERR_PROTOCOL' });
  assert.throws(
    () => new Decoder(uuid).decode(Buffer.concat([uuid, Buffer.from([3, 0, 0, 0, 0])])),
    { code: 'ERR_PROTOCOL' },
  );
});

test('Vision detects fragmented TLS 1.3 ServerHello and excludes CCM_8/TLS 1.2', () => {
  for (const cipher of [0x1301, 0x1302, 0x1303, 0x1304, 0x1305, 0xc02f]) {
    const body = Buffer.alloc(50);
    body[0] = 2;
    body.writeUIntBE(46, 1, 3);
    body.writeUInt16BE(0x0303, 4);
    body.writeUInt16BE(cipher, 39);
    body.writeUInt16BE(6, 42);
    body.writeUInt16BE(43, 44);
    body.writeUInt16BE(2, 46);
    body.writeUInt16BE(cipher === 0xc02f ? 0x0303 : 0x0304, 48);
    const wire = Buffer.concat([Buffer.from([22, 3, 3, 0, body.length]), body]);
    const shared = state();
    for (const byte of wire) inspect(shared, Buffer.from([byte]), 0);
    assert.equal(shared.direct, cipher >= 0x1301 && cipher <= 0x1304);
    assert.equal(shared.modern, true);
  }
});

for (const version of [undefined, 'TLSv1.2', 'TLSv1.3']) {
  test(`Vision Runtime end-to-end ${version ?? 'ordinary TCP'}, exact data and switch metrics`, async (t) => {
    const target = version ? await tlsEcho(t, version) : await echo(t);
    const server = createRuntime({ inbounds: [bound(0, true)] });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({ outbounds: [bound(server.listenersInfo[0].address.port)] });
    await client.start();
    t.after(() => client.close());
    await transfer(client, target, version);
    assert.equal(client.metrics.visionSessions, 1);
    assert.equal(server.metrics.visionSessions, 1);
    for (const runtime of [client, server]) {
      assert.equal(runtime.metrics.visionReadSwitches, version === 'TLSv1.3' ? 1 : 0);
      assert.equal(runtime.metrics.visionWriteSwitches, version === 'TLSv1.3' ? 1 : 0);
    }
    await client.close();
    await server.close();
    assert.equal(client.stats.connections, 0);
    assert.equal(server.stats.connections, 0);
  });
}

test('Vision VLESS addons negotiate across every split and reject flow mismatch/TLS 1.2/UDP', async () => {
  const wire = encodeRequest({ id, flow }, { host: 'example.test', port: 443 });
  for (let split = 0; split <= wire.length; split++) {
    const socket = Readable.from([wire.subarray(0, split), wire.subarray(split)], {
      objectMode: false,
    });
    socket.getProtocol = () => 'TLSv1.3';
    assert.equal((await readRequest(socket, { users: [{ id, flow }] })).flow, flow);
  }
  for (const [user, version, command, error] of [
    [{ id }, 'TLSv1.3', 1, 'ERR_AUTH'],
    [{ id, flow }, 'TLSv1.2', 1, 'ERR_TLS'],
    [{ id, flow }, 'TLSv1.3', 2, 'ERR_UNSUPPORTED'],
  ]) {
    const socket = Readable.from(
      [encodeRequest({ id, flow }, { host: 'example.test', port: 443 }, command)],
      { objectMode: false },
    );
    socket.getProtocol = () => version;
    await assert.rejects(readRequest(socket, { users: [user] }), { code: error });
  }
  const native = checkConfig({
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [{ address: '127.0.0.1', port: 443, users: [{ id, encryption: 'none', flow }] }],
        },
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: { serverName: 'js2ray.test' },
        },
      },
    ],
  });
  assert.equal(native.ok, true);
  assert.equal(native.config.outbounds[0].users[0].flow, flow);
});

test('Vision XUDP preserves datagrams and blocks UDP/443 by default', async (t) => {
  const target = await udpEcho(t);
  const server = createRuntime({ inbounds: [bound(0, true)] });
  await server.start();
  t.after(() => server.close());
  const client = createRuntime({ outbounds: [bound(server.listenersInfo[0].address.port)] });
  await client.start();
  t.after(() => client.close());
  await datagrams(client, target);
  await assert.rejects(client.openDatagram({ host: '127.0.0.1', port: 443 }), {
    code: 'ERR_BLOCKED',
  });
  assert.equal(client.metrics.visionSessions, 1);
  assert.equal(client.metrics.visionReadSwitches, 0);
});

test('Vision udp443 opt-in uses the base wire flow and transports datagrams', async (t) => {
  const target = await udpEcho(t);
  const server = createRuntime({
    inbounds: [bound(0, true)],
    outbounds: [{ protocol: 'freedom', redirect: `127.0.0.1:${target.port}` }],
  });
  await server.start();
  t.after(() => server.close());
  const outbound = bound(server.listenersInfo[0].address.port);
  outbound.users[0].flow += '-udp443';
  const client = createRuntime({ outbounds: [outbound] });
  await client.start();
  t.after(() => client.close());
  await datagrams(client, { host: '127.0.0.1', port: 443 });
});

test('Vision listener also authenticates ordinary VLESS users without requiring their flow', async (t) => {
  const target = await echo(t);
  const plain = 'ea872601-5fc7-433d-b02a-44376cab86a1';
  const inbound = bound(0, true);
  inbound.users.push({ id: plain });
  const server = createRuntime({ inbounds: [inbound] });
  await server.start();
  t.after(() => server.close());
  const outbound = bound(server.listenersInfo[0].address.port);
  outbound.users = [{ id: plain, encryption: 'none' }];
  const client = createRuntime({ outbounds: [outbound] });
  await client.start();
  t.after(() => client.close());
  await transfer(client, target);
  assert.equal(server.metrics.visionSessions, 0);
});

test('Vision Direct streams survive same-port credential rotation; rejected old credentials and rollback', async (t) => {
  const target = await tlsEcho(t, 'TLSv1.3');
  const nextId = 'ea872601-5fc7-433d-b02a-44376cab86a1';
  const config = (userId) => ({ inbounds: [bound(0, true, userId)] });
  const manager = createRuntimeManager(config(id));
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  const old = createRuntime({ outbounds: [bound(port)] });
  await old.start();
  t.after(() => old.close());
  const tunnel = await old.dial(target);
  const held = tls.connect({
    socket: tunnel,
    ca: cert,
    servername: 'js2ray.test',
    minVersion: 'TLSv1.3',
  });
  held.on('error', () => {});
  t.after(() => held.destroy());
  await once(held, 'secureConnect');
  await write(held, Buffer.from('before'));
  await readBytes(held, 6);
  const cutover = await manager.rotate(config(nextId), { drainTimeoutMs: 3000 });
  assert.equal(manager.listenersInfo[0].address.port, port);
  await write(held, Buffer.from('retained'));
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  const next = createRuntime({ outbounds: [bound(port, false, nextId)] });
  await next.start();
  t.after(() => next.close());
  await transfer(next, target, 'TLSv1.3');
  const rejected = await old.dial(target);
  const error = once(rejected, 'error');
  rejected.write('rejected');
  await error;
  const invalid = config(nextId);
  invalid.inbounds[0].networks[0].option.tls.key = 'invalid';
  await assert.rejects(manager.rotate(invalid), { code: 'ERR_TLS' });
  await transfer(next, target, 'TLSv1.3');
  held.destroy();
  tunnel.destroy();
  await cutover.drained;
  assert.equal(manager.stats.generations, 1);
});

test('Vision strict certificate validation, established cancellation and bounded writes', async (t) => {
  const target = await echo(t);
  const server = createRuntime({ inbounds: [bound(0, true)] });
  await server.start();
  t.after(() => server.close());
  for (const secure of [{ serverName: 'js2ray.test' }, { ca: cert, serverName: 'wrong.test' }]) {
    const outbound = bound(server.listenersInfo[0].address.port);
    outbound.networks[0].option.tls = secure;
    const client = createRuntime({ outbounds: [outbound] });
    await client.start();
    t.after(() => client.close());
    await assert.rejects(client.dial(target), { code: 'ERR_TLS' });
  }
  const client = createRuntime({
    outbounds: [bound(server.listenersInfo[0].address.port)],
    limits: { maxBufferBytes: 32768 },
  });
  await client.start();
  t.after(() => client.close());
  const controller = new AbortController();
  const stream = await client.dial({ ...target, signal: controller.signal });
  const error = once(stream, 'error');
  controller.abort();
  assert.equal((await error)[0].code, 'ERR_CANCELLED');
  const oversized = await client.dial(target);
  await assert.rejects(write(oversized, Buffer.alloc(32769)), { code: 'ERR_LIMIT' });
});

test(
  'Vision 100 concurrent inner TLS 1.3 streams switch both ways and release all sessions',
  { timeout: 12000 },
  async (t) => {
    const target = await tlsEcho(t, 'TLSv1.3');
    const server = createRuntime({
      inbounds: [bound(0, true)],
      limits: { handshakeTimeoutMs: 5000 },
    });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [bound(server.listenersInfo[0].address.port)],
      limits: { handshakeTimeoutMs: 5000 },
    });
    await client.start();
    t.after(() => client.close());
    await Promise.all(Array.from({ length: 100 }, () => transfer(client, target, 'TLSv1.3')));
    assert.equal(client.metrics.visionSessions, 100);
    for (const runtime of [client, server]) {
      assert.equal(runtime.metrics.visionReadSwitches, 100);
      assert.equal(runtime.metrics.visionWriteSwitches, 100);
    }
    await client.close();
    await server.close();
    assert.equal(client.stats.connections + server.stats.connections, 0);
    assert.equal(client.metrics.mux.queuedBytes, 0);
  },
);

test('Vision same-port certificate rotation retains a Direct stream and validates the new certificate', async (t) => {
  const fs = require('node:fs');
  const target = await tlsEcho(t, 'TLSv1.3');
  const nextCert = fs.readFileSync(require.resolve('./fixtures/tls/rotated-cert.pem'), 'utf8');
  const nextKey = fs.readFileSync(require.resolve('./fixtures/tls/rotated-key.pem'), 'utf8');
  const manager = createRuntimeManager({ inbounds: [bound(0, true)] });
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  const client = createRuntime({ outbounds: [bound(port)] });
  await client.start();
  t.after(() => client.close());
  const tunnel = await client.dial(target);
  const held = tls.connect({
    socket: tunnel,
    ca: cert,
    servername: 'js2ray.test',
    minVersion: 'TLSv1.3',
  });
  held.on('error', () => {});
  t.after(() => held.destroy());
  await once(held, 'secureConnect');
  await write(held, Buffer.from('before'));
  await readBytes(held, 6);
  const config = { inbounds: [bound(0, true)] };
  config.inbounds[0].networks[0].option.tls = { cert: nextCert, key: nextKey };
  const result = await manager.rotate(config, { drainTimeoutMs: 3000 });
  await write(held, Buffer.from('retained'));
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  await assert.rejects(client.dial(target), { code: 'ERR_TLS' });
  const outbound = bound(port);
  outbound.networks[0].option.tls = { ca: nextCert, serverName: 'js2ray-rotated.test' };
  const next = createRuntime({ outbounds: [outbound] });
  await next.start();
  t.after(() => next.close());
  await transfer(next, target, 'TLSv1.3');
  held.destroy();
  tunnel.destroy();
  await result.drained;
  assert.equal(manager.listenersInfo[0].address.port, port);
});

test('Vision TLS setup timeout, pending cancellation and inbound handshake deadline close raw sockets', async (t) => {
  const net = require('node:net');
  const { listen } = require('./helpers');
  const sockets = new Set();
  let entered;
  const accepted = new Promise((resolve) => {
    entered = resolve;
  });
  const blackhole = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    entered();
  });
  const port = await listen(blackhole);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => blackhole.close(resolve));
  });
  const client = createRuntime({ outbounds: [bound(port)], limits: { handshakeTimeoutMs: 30 } });
  await client.start();
  t.after(() => client.close());
  await assert.rejects(client.dial({ host: '127.0.0.1', port: 80 }), { code: 'ERR_TIMEOUT' });
  const controller = new AbortController();
  const pending = client.dial({ host: '127.0.0.1', port: 80, signal: controller.signal });
  const cancelled = assert.rejects(pending, { code: 'ERR_CANCELLED' });
  await accepted;
  controller.abort();
  await cancelled;
  const server = createRuntime({ inbounds: [bound(0, true)], limits: { handshakeTimeoutMs: 30 } });
  await server.start();
  t.after(() => server.close());
  const raw = net.connect({ host: '127.0.0.1', port: server.listenersInfo[0].address.port });
  await once(raw, 'connect');
  await once(raw, 'close');
  await client.close();
  await server.close();
  assert.equal(client.stats.pendingDials + client.stats.connections, 0);
});
