'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { once } = require('node:events');
const { createRuntime, checkConfig } = require('../');
const { connect, createListener } = require('../transports');
const { echo, listen, readBytes } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const available = isBuiltin('node:quic');
const quic = available ? require('node:quic') : undefined;
const endpointBaseline = quic?.listEndpoints({ active: false }).length;
async function eventually(check, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'condition must become true within bounded cleanup deadline');
}
test.after(async () => {
  if (available)
    await eventually(() => quic.listEndpoints({ active: false }).length === endpointBaseline);
});
test.beforeEach(async () => {
  if (available)
    await eventually(() => quic.listEndpoints({ active: false }).length === endpointBaseline);
});
const network = { type: 'quic', address: '127.0.0.1', port: 0, option: { tls: { cert, key } } };
const clientNetwork = (port) => ({
  ...network,
  port,
  option: { tls: { ca: cert, serverName: 'js2ray.test' } },
});

test('QUIC parsing is runtime independent and rejects unsupported wire settings', () => {
  assert.equal(
    checkConfig({ inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network] }] }).ok,
    true,
  );
  const outbound = (tls) => ({
    outbounds: [
      {
        protocol: 'vless',
        users: [{ id, encryption: 'none' }],
        networks: [{ ...clientNetwork(443), option: { tls } }],
      },
    ],
  });
  assert.equal(
    checkConfig(outbound({ ca: cert, serverName: 'js2ray.test', alpn: ['h2'] })).ok,
    true,
  );
  for (const tls of [undefined, { alpn: ['h3'] }, { alpn: [] }]) {
    const report = checkConfig(outbound(tls));
    assert.equal(report.ok, false);
    const expectedPath = 'outbounds[0].networks[0].option.tls' + (tls ? '.alpn' : '');
    assert.ok(report.diagnostics.some((d) => d.path === expectedPath));
    assert.ok(report.diagnostics.every((d) => !d.path.includes('.users')));
  }
  for (const quicSettings of [
    { security: 'aes-128-gcm' },
    { key: 'secret' },
    { header: { type: 'srtp' } },
  ]) {
    const report = checkConfig({
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [{ address: '127.0.0.1', port: 443, users: [{ id, encryption: 'none' }] }],
          },
          streamSettings: { network: 'quic', security: 'tls', quicSettings },
        },
      ],
    });
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some((d) => d.path.includes('quicSettings')));
  }
  for (const filename of [
    'vless-quic-client.json',
    'vless-quic-server.json',
    'vless-quic-v2ray-client.json',
  ]) {
    const report = checkConfig(
      JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', filename), 'utf8')),
    );
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  }
});

test(
  'QUIC close is bounded with a stalled peer and Runtime pending dial',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const sessions = new Set();
    const endpoint = await quic.listen(
      (session) => {
        sessions.add(session);
        session.closed.catch(() => {});
        session.onstream = (raw) => {
          raw.closed.catch(() => {});
          // Send FIN but never consume the client bytes or return flow-control credit.
          raw.writer.end().catch(() => {});
        };
      },
      {
        alpn: ['h2'],
        sni: {
          '*': { keys: require('node:crypto').createPrivateKey(key), certs: Buffer.from(cert) },
        },
        endpoint: { address: { address: '127.0.0.1', port: 0 } },
        transportParams: {
          initialMaxData: 1024,
          initialMaxStreamDataBidiRemote: 1024,
          initialMaxStreamsBidi: 1,
        },
      },
    );
    endpoint.closed.catch(() => {});
    t.after(() => {
      for (const session of sessions) session.destroy();
      endpoint.destroy();
    });
    const stream = await connect(clientNetwork(endpoint.address.port));
    stream.resume();
    let writeError;
    const written = new Promise((resolve) =>
      stream.end(Buffer.alloc(4 * 1024 * 1024), (error) => {
        writeError = error;
        resolve();
      }),
    );
    await once(stream, 'end');
    const started = Date.now();
    const closed = new Promise((resolve) => stream.once('close', resolve));
    stream.destroy();
    assert.equal(stream.destroyed, true, 'explicit destroy synchronously cancels the Duplex');
    await Promise.all([written, closed]);
    assert.ok(writeError, 'pending write must settle with an error');
    assert.ok(Date.now() - started < 1800);

    const udp = require('node:dgram').createSocket('udp4');
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    t.after(() => udp.close());
    const runtime = createRuntime({
      outbounds: [
        {
          protocol: 'vless',
          users: [{ id, encryption: 'none' }],
          networks: [clientNetwork(udp.address().port)],
        },
      ],
    });
    await runtime.start();
    const dialing = runtime.dial({ host: '127.0.0.1', port: 12345 });
    const rejected = assert.rejects(dialing, { code: 'ERR_CANCELLED' });
    const closing = Date.now();
    await runtime.close({ drainTimeoutMs: 0 });
    await rejected;
    assert.ok(Date.now() - closing < 1800);
    assert.equal(runtime.stats.pendingDials, 0);
    assert.equal(runtime.stats.connections, 0);
    await eventually(() => runtime.metrics.transport.streams === 0);
  },
);

test(
  'QUIC capability guard includes unused outbounds and mixed inbounds',
  { skip: available },
  () => {
    const bad = {
      protocol: 'vless',
      users: [{ id, encryption: 'none' }],
      networks: [clientNetwork(443)],
    };
    for (const config of [
      { outbounds: [{ protocol: 'freedom' }, bad] },
      {
        inbounds: [
          { protocol: 'socks', networks: [{ port: 0 }] },
          { ...bad, networks: [network] },
        ],
      },
    ])
      assert.throws(
        () => createRuntime(config),
        (e) =>
          e.name === 'Js2rayError' &&
          e.code === 'ERR_UNSUPPORTED' &&
          e.phase === 'quic' &&
          /--experimental-quic/.test(e.message),
      );
  },
);

test('QUIC transport reliable bytes and FIN', { skip: !available, timeout: 10000 }, async (t) => {
  const listener = createListener(network, (stream) => stream.pipe(stream), {
    handshakeTimeoutMs: 2000,
  });
  t.after(() => listener.destroy());
  const port = await listen(listener.server);
  const client = await connect(clientNetwork(port), { connectTimeoutMs: 2000 });
  t.after(() => client.destroy());
  const data = Buffer.alloc(256 * 1024, 123);
  const received = (async () => {
    const chunks = [];
    for await (const chunk of client) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  client.end(data);
  assert.deepEqual(await received, data);
});

test(
  'QUIC reuses one inbound session for many reliable streams',
  { skip: !available, timeout: 6000 },
  async (t) => {
    let accepted = 0;
    const active = new Set();
    const listener = createListener(
      network,
      (stream) => {
        accepted++;
        active.add(stream);
        stream.once('close', () => active.delete(stream));
        stream.pipe(stream);
      },
      { maxConnections: 64 },
    );
    t.after(() => listener.destroy());
    const port = await listen(listener.server);
    const endpoint = new quic.QuicEndpoint();
    endpoint.closed.catch(() => {});
    const session = await quic.connect(`127.0.0.1:${port}`, {
      endpoint,
      alpn: 'h2',
      ca: Buffer.from(cert),
      servername: 'js2ray.test',
    });
    session.closed.catch(() => {});
    t.after(() => {
      session.destroy();
      endpoint.destroy();
    });
    await session.opened;
    for (let n = 0; n < 32; n++) {
      const body = Buffer.from(`stream-${n}`);
      const raw = await session.createBidirectionalStream({ body });
      raw.closed.catch(() => {});
      const chunks = [];
      for await (const batch of raw) for (const chunk of batch) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), body);
      await raw.closed;
    }
    assert.equal(accepted, 32);
    await eventually(() => active.size === 0);
  },
);

for (const protocol of ['vless', 'vmess']) {
  test(
    `QUIC ${protocol} proxy concurrent large data and half close`,
    { skip: !available, timeout: 12000 },
    async (t) => {
      const target = await echo(t);
      const server = createRuntime({
        inbounds: [{ protocol, users: [{ id }], networks: [network] }],
      });
      t.after(async () => {
        await server.close();
        assert.equal(server.stats.connections, 0);
        assert.equal(server.stats.pendingDials, 0);
        await eventually(() => server.metrics.transport.streams === 0);
      });
      await server.start();
      const client = createRuntime({
        outbounds: [
          {
            protocol,
            users: [{ id, ...(protocol === 'vless' ? { encryption: 'none' } : {}) }],
            networks: [clientNetwork(server.listenersInfo[0].address.port)],
          },
        ],
      });
      t.after(() => client.close({ drainTimeoutMs: 0 }));
      await client.start();
      await Promise.all(
        Array.from({ length: 3 }, async (_, n) => {
          const stream = await client.dial(target);
          t.after(() => stream.destroy());
          const body = Buffer.alloc(2 * 1024 * 1024, n + 71);
          const started = Date.now();
          const received = (async () => {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
          })();
          for (let offset = 0; offset < body.length; offset += 32768) {
            if (!stream.write(body.subarray(offset, offset + 32768))) await once(stream, 'drain');
          }
          stream.end();
          assert.deepEqual(await received, body);
          assert.ok(
            Date.now() - started < 2000,
            'complete payload and FIN must arrive before default negotiation/idle timeouts',
          );
        }),
      );
    },
  );
}

test(
  'QUIC validates trust and certificate name by default',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const listener = createListener(network, (stream) => stream.pipe(stream));
    t.after(() => listener.destroy());
    const port = await listen(listener.server);
    for (const tls of [{ serverName: 'js2ray.test' }, { ca: cert, serverName: 'wrong.test' }]) {
      await assert.rejects(
        connect({ ...clientNetwork(port), option: { tls } }, { connectTimeoutMs: 1000 }),
        (error) =>
          error.code === 'ERR_TLS' &&
          error.phase === 'quic' &&
          /cert|TLS|QUIC/i.test(error.cause?.message),
      );
    }
    const trusted = await connect(clientNetwork(port));
    trusted.destroy();
  },
);

test(
  'QUIC timeout, cancellation, reset and localhost listener',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const baseline = quic.listEndpoints({ active: false }).length;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(connect(clientNetwork(9), { signal: controller.signal }), {
      code: 'ERR_CANCELLED',
      phase: 'quic',
    });
    // An owned local UDP sink reliably drops handshakes without relying on external routing.
    const udp = require('node:dgram').createSocket('udp4');
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    t.after(() => udp.close());
    await assert.rejects(connect(clientNetwork(udp.address().port), { connectTimeoutMs: 50 }), {
      code: 'ERR_TIMEOUT',
    });
    const pendingController = new AbortController();
    const pending = connect(clientNetwork(udp.address().port), {
      signal: pendingController.signal,
    });
    setTimeout(() => pendingController.abort(), 30);
    await assert.rejects(pending, { code: 'ERR_CANCELLED' });
    await eventually(() => quic.listEndpoints({ active: false }).length === baseline);
    let lookups = 0;
    const listener = createListener(
      { ...network, address: 'localhost' },
      (stream) => {
        stream.once('data', () => stream.destroy(new Error('synthetic reset')));
      },
      {
        lookup: (name, options, callback) => {
          lookups++;
          assert.equal(name, 'localhost');
          callback(null, '127.0.0.1', 4);
        },
      },
    );
    t.after(() => listener.destroy());
    listener.server.listen({ host: 'localhost', port: 0 });
    await once(listener.server, 'listening');
    assert.equal(lookups, 1);
    const stream = await connect(clientNetwork(listener.server.address().port));
    const error = once(stream, 'error');
    stream.write('reset');
    assert.equal((await error)[0].code, 'ERR_TRANSPORT');
  },
);

test(
  'QUIC shared listener rejects unsupported limit changes and preserves old configuration',
  { skip: !available },
  async (t) => {
    const options = { maxBufferBytes: 65536, maxConnections: 3 };
    const listener = createListener(network, (stream) => stream.pipe(stream), options);
    t.after(() => listener.destroy());
    const port = await listen(listener.server);
    assert.throws(() => listener.prepareUpdate(network, { ...options, maxConnections: 4 }), {
      code: 'ERR_ROTATION',
    });
    assert.throws(
      () => listener.prepareUpdate({ ...network, option: { tls: { cert, key: 'bad' } } }, options),
      { code: 'ERR_TLS' },
    );
    const update = listener.prepareUpdate(network, options);
    update.commit();
    update.rollback();
    const stream = await connect(clientNetwork(port));
    t.after(() => stream.destroy());
    stream.write('old');
    assert.equal((await readBytes(stream, 3)).toString(), 'old');
  },
);

test(
  'QUIC RuntimeManager rotation retains stream and switches credentials',
  { skip: !available, timeout: 8000 },
  async (t) => {
    const { createRuntimeManager } = require('..');
    const nextId = 'ea872601-5fc7-433d-b02a-44376cab86a1';
    const target = await echo(t);
    const config = (userId, limits) => ({
      limits,
      inbounds: [{ tag: 'entry', protocol: 'vless', users: [{ id: userId }], networks: [network] }],
    });
    const manager = createRuntimeManager(config(id));
    t.after(() => manager.close());
    await manager.start();
    const port = manager.listenersInfo[0].address.port;
    const clients = [];
    t.after(() => Promise.all(clients.map((client) => client.close())));
    const dial = async (userId) => {
      const client = createRuntime({
        outbounds: [
          {
            protocol: 'vless',
            users: [{ id: userId, encryption: 'none' }],
            networks: [clientNetwork(port)],
          },
        ],
      });
      clients.push(client);
      await client.start();
      return client.dial(target);
    };
    const held = await dial(id);
    held.write('before');
    assert.equal((await readBytes(held, 6)).toString(), 'before');
    await assert.rejects(manager.rotate(config(nextId, { maxConnections: 7 })), {
      code: 'ERR_ROTATION',
    });
    held.write('usable');
    assert.equal((await readBytes(held, 6)).toString(), 'usable');
    const cutover = await manager.rotate(config(nextId), { drainTimeoutMs: 1000 });
    assert.equal(manager.listenersInfo[0].address.port, port);
    held.write('retained');
    assert.equal((await readBytes(held, 8)).toString(), 'retained');
    const fresh = await dial(nextId);
    fresh.write('new');
    assert.equal((await readBytes(fresh, 3)).toString(), 'new');
    held.destroy();
    fresh.destroy();
    await cutover.drained;
    await Promise.all(clients.map((client) => client.close()));
    await manager.close();
    assert.equal(manager.stats.connections, 0);
    assert.equal(manager.stats.pendingDials, 0);
  },
);
