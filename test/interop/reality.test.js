'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createRuntime } = require('../..');
const fixture = require('../fixtures/reality');
const { id, flow, transfer, tlsEcho, udpEcho, datagrams } = require('../fixtures/vision');
const { echo, listen } = require('../helpers');
const { runCore, freePort } = require('./helpers');
function reference(server, cover) {
  return {
    network: 'tcp',
    security: 'reality',
    realitySettings: server
      ? { ...fixture.server, dest: `127.0.0.1:${cover.port}`, xver: 0 }
      : { ...fixture.client, fingerprint: 'chrome' },
  };
}
async function peer(t, role, cover, vision = false, udp = false) {
  const port = await freePort(role === 'server' && udp);
  let runtime, server;
  if (role === 'client') {
    await runCore(
      t,
      'xray',
      {
        inbounds: [
          {
            listen: '127.0.0.1',
            port,
            protocol: 'vless',
            settings: { decryption: 'none', clients: [{ id, flow: vision ? flow : '' }] },
            streamSettings: reference(true, cover),
          },
        ],
        outbounds: [{ protocol: 'freedom' }],
      },
      port,
      { profile: 'xray-xhttp' },
    );
    runtime = createRuntime({ outbounds: [fixture.bound(port, undefined, vision ? flow : '')] });
  } else {
    server = createRuntime({ inbounds: [fixture.bound(0, cover, vision ? flow : '')] });
    await server.start();
    t.after(() => server.close());
    await runCore(
      t,
      'xray',
      {
        inbounds: [
          { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp } },
        ],
        outbounds: [
          {
            protocol: 'vless',
            settings: {
              vnext: [
                {
                  address: '127.0.0.1',
                  port: server.listenersInfo[0].address.port,
                  users: [{ id, encryption: 'none', flow: vision ? flow : '' }],
                },
              ],
            },
            streamSettings: reference(false),
          },
        ],
      },
      port,
      { profile: 'xray-xhttp' },
    );
    runtime = createRuntime({
      outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    });
  }
  await runtime.start();
  t.after(() => runtime.close());
  return { runtime, measured: server ?? runtime };
}
for (const role of ['client', 'server']) {
  for (const vision of [false, true])
    for (const version of [undefined, 'TLSv1.2', 'TLSv1.3']) {
      test(`REALITY js2ray ${role} / Xray 25.3.6 ${vision ? 'Vision' : 'empty flow'} ${version ?? 'TCP'}`, async (t) => {
        const cover = await fixture.cover(t),
          target = version ? await tlsEcho(t, version) : await echo(t);
        const { runtime, measured } = await peer(t, role, cover, vision);
        await transfer(runtime, target, version);
        assert.equal(measured.metrics.visionReadSwitches, vision && version === 'TLSv1.3' ? 1 : 0);
        assert.equal(measured.metrics.visionWriteSwitches, vision && version === 'TLSv1.3' ? 1 : 0);
      });
    }
  for (const vision of [false, true])
    test(`REALITY ${vision ? 'Vision XUDP' : 'traditional UDP'} ${role} / Xray 25.3.6`, async (t) => {
      const cover = await fixture.cover(t),
        target = await udpEcho(t);
      const { runtime } = await peer(t, role, cover, vision, true);
      await datagrams(runtime, target, 1400);
    });
}
test('REALITY pinned Chrome 120 ClientHello fields match the fixed Xray uTLS template', async (t) => {
  const handshake = require('../../transports/reality/handshake');
  const { Cursor } = require('../../transports/reality/wire');
  let resolve;
  const received = new Promise((done) => {
    resolve = done;
  });
  const sockets = new Set();
  const listener = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
    handshake.readHello(handshake.reader(raw)).then(resolve, (error) => resolve({ error }));
  });
  const port = await listen(listener);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done) => listener.close(done));
  });
  const entry = await freePort();
  await runCore(
    t,
    'xray',
    {
      inbounds: [
        { listen: '127.0.0.1', port: entry, protocol: 'socks', settings: { auth: 'noauth' } },
      ],
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [{ address: '127.0.0.1', port, users: [{ id, encryption: 'none' }] }],
          },
          streamSettings: reference(false),
        },
      ],
    },
    entry,
    { profile: 'xray-xhttp' },
  );
  // The core readiness check does not connect to the capture port.
  const runtime = createRuntime({
    outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port: entry }] }],
  });
  await runtime.start();
  t.after(() => runtime.close());
  const stream = await runtime.dial({ host: '127.0.0.1', port: 80 });
  stream.write('trigger');
  const actual = await received;
  if (actual.error) throw actual.error;
  const own = require('../../transports/reality/wire').hello(
    handshake.clientHello(
      { ...fixture.client, fingerprint: 'chrome120' },
      require('../../transports/reality/crypto').keyPair(),
    ).hello,
  );
  const grease = (n) => (n & 0x0f0f) === 0x0a0a && n >> 8 === (n & 255);
  const words = (data) =>
    Array.from({ length: data.length / 2 }, (_, i) => {
      const n = data.readUInt16BE(i * 2);
      return grease(n) ? 'GREASE' : n;
    });
  assert.deepEqual(words(own.ciphers), words(actual.parsed.ciphers));
  const types = (parsed) =>
    [...parsed.extensions.keys()].filter((type) => !grease(type)).sort((a, b) => a - b);
  assert.deepEqual(types(own), types(actual.parsed));
  for (const type of types(own)) {
    const left = own.extensions.get(type),
      right = actual.parsed.extensions.get(type);
    if (type === 10)
      assert.deepEqual(words(new Cursor(left).vector()), words(new Cursor(right).vector()));
    else if (type === 43)
      assert.deepEqual(words(new Cursor(left).vector(1)), words(new Cursor(right).vector(1)));
    else if (type === 51)
      assert.deepEqual(
        own.shares.map((s) => [grease(s.group) ? 'GREASE' : s.group, s.data.length]),
        actual.parsed.shares.map((s) => [grease(s.group) ? 'GREASE' : s.group, s.data.length]),
      );
    else if (type === 0xfe0d) {
      for (const data of [left, right]) {
        const cursor = new Cursor(data);
        assert.equal(cursor.byte(), 0);
        assert.equal(cursor.word(), 1);
        assert.ok([1, 3].includes(cursor.word()));
        cursor.byte();
        assert.equal(cursor.vector().length, 32);
        assert.ok([144, 176, 208, 240].includes(cursor.vector().length));
        cursor.done();
      }
    } else assert.deepEqual(left, right, 'extension ' + type);
  }
  assert.deepEqual(actual.records.subarray(0, 3), Buffer.from([22, 3, 1]));
  stream.destroy();
});
