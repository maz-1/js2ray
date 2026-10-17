'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createRuntime, createRuntimeManager, checkConfig, redact } = require('..');
const { echo, readBytes } = require('./helpers');
const { proxy, ca, certFile, keyFile } = require('./fixtures/xhttp-proxy');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function topology(t, mode, upVersion, downVersion, options = {}) {
  const target = await echo(t);
  const server = createRuntime({
    inbounds: [
      {
        protocol: 'vless',
        users: [{ id }],
        networks: [
          {
            type: 'xhttp',
            address: '127.0.0.1',
            port: 0,
            option: {
              path: '/shared/',
              mode: 'auto',
              httpVersion: options.backendVersion ?? '1.1',
            },
          },
        ],
      },
    ],
  });
  await server.start();
  t.after(() => server.close());
  const backend = { port: server.listenersInfo[0].address.port };
  const common = {
    target: backend,
    secure: options.secure ?? true,
    upstreamVersion: options.backendVersion ?? '1.1',
  };
  const up = await proxy(t, {
    ...common,
    version: upVersion,
    prefix: '/upload/',
    method: 'POST',
    host: 'upload.test',
  });
  const down = await proxy(t, {
    ...common,
    version: downVersion,
    prefix: '/download/',
    method: 'GET',
    host: 'download.test',
    fault: options.downFault,
  });
  const network = structuredClone(up.network);
  Object.assign(network.option, {
    mode,
    scMaxEachPostBytes: 16384,
    xmux: options.xmux ?? { maxConcurrency: 8 },
    downloadSettings: structuredClone(down.network),
  });
  network.option.downloadSettings.option.xmux = options.downXmux ?? { maxConcurrency: 8 };
  const config = {
    limits: options.limits,
    outbounds: [{ protocol: 'vless', users: [{ id, encryption: 'none' }], networks: [network] }],
  };
  const client = createRuntime(config);
  await client.start();
  t.after(() => client.close());
  return { target, server, client, config, network, up, down };
}
async function exchange(stream, length = 98321) {
  const data = randomBytes(length),
    reading = readBytes(stream, length);
  for (let n = 0; n < length; n += 8192)
    await new Promise((resolve, reject) =>
      stream.write(data.subarray(n, n + 8192), (e) => (e ? reject(e) : resolve())),
    );
  assert.deepEqual(await reading, data);
}
for (const mode of ['packet-up', 'stream-up', 'auto'])
  for (const [upVersion, downVersion] of [
    ['1.1', '1.1'],
    ['1.1', '2'],
    ['2', '1.1'],
    ['2', '2'],
  ])
    test(`XHTTP split ${mode} HTTP/${upVersion} up + HTTP/${downVersion} down via TLS reverse proxies`, async (t) => {
      const { client, target, up, down } = await topology(t, mode, upVersion, downVersion);
      const streams = await Promise.all([client.dial(target), client.dial(target)]);
      await Promise.all(streams.map((s) => exchange(s)));
      streams[0].destroy();
      await exchange(streams[1], 8193);
      streams[1].destroy();
      assert.ok(up.requests.every((r) => r.method === 'POST' && r.host === 'upload.test'));
      assert.ok(down.requests.every((r) => r.method === 'GET' && r.host === 'download.test'));
      assert.equal(client.stats.listeners, 0);
      assert.equal(client.metrics.xhttp.created, 2);
      await client.close();
      assert.equal(client.metrics.xhttp.clients, 0);
      assert.equal(client.metrics.xhttp.active, 0);
    });
for (const backendVersion of ['1.1', '2'])
  test(`XHTTP split plaintext frontends and HTTP/${backendVersion} upstream conversion`, async (t) => {
    const { client, target, config } = await topology(t, 'stream-up', '2', '1.1', {
      secure: false,
      backendVersion,
    });
    const stream = await client.dial(target);
    await exchange(stream);
    stream.destroy();
    const network = config.outbounds[0].networks[0];
    network.address = 'upload-node.test';
    network.option.downloadSettings.address = 'download-node.test';
    const names = new Set();
    const named = createRuntime(config, {
      lookup: (name, options, callback) => {
        names.add(name);
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      },
    });
    await named.start();
    t.after(() => named.close());
    const resolved = await named.dial(target);
    await exchange(resolved);
    resolved.destroy();
    assert.ok(names.has('upload-node.test'));
    assert.ok(names.has('download-node.test'));
  });
test('XHTTP split native and traditional validation rejects unsupported combinations and keeps TLS paths private', () => {
  const network = {
    type: 'xhttp',
    address: '127.0.0.1',
    port: 1234,
    option: {
      downloadSettings: {
        type: 'xhttp',
        address: 'download.test',
        port: 4321,
        option: { tls: { caFile: 'test/fixtures/tls/cert.pem' }, path: '/private-down' },
      },
    },
  };
  const native = (network) => ({
    outbounds: [{ protocol: 'vless', users: [{ id, encryption: 'none' }], networks: [network] }],
  });
  const checked = checkConfig(native(network));
  assert.equal(checked.ok, true);
  assert.ok(
    checked.config.outbounds[0].networks[0].option.downloadSettings.option.tls.caFile.endsWith(
      'cert.pem',
    ),
  );
  assert.ok(!JSON.stringify(redact(checked.config)).includes('download.test'));
  for (const change of [
    (n) => (n.option.mode = 'stream-one'),
    (n) => (n.option.downloadSettings.type = 'tcp'),
    (n) => (n.option.downloadSettings.port = 0),
    (n) => (n.option.downloadSettings.option.downloadSettings = {}),
    (n) => (n.option.downloadSettings.option.httpVersion = '4'),
    (n) => (n.option.downloadSettings.option.headers = { authorization: 'bad\r\nheader' }),
  ]) {
    const changed = structuredClone(network);
    change(changed);
    assert.equal(checkConfig(native(changed)).ok, false);
  }
  const inbound = { inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network] }] };
  assert.equal(checkConfig(inbound).ok, false);
  const traditional = {
    outbounds: [
      {
        protocol: 'vless',
        settings: {
          vnext: [{ address: '127.0.0.1', port: 1234, users: [{ id, encryption: 'none' }] }],
        },
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: {
            path: '/up',
            extra: {
              downloadSettings: {
                address: 'download.test',
                port: 4321,
                network: 'xhttp',
                security: 'tls',
                tlsSettings: { serverName: 'download.test', alpn: ['h2'] },
                xhttpSettings: { path: '/down' },
              },
            },
          },
        },
      },
    ],
  };
  const result = checkConfig(traditional);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const down = result.config.outbounds[0].networks[0].option.downloadSettings;
  assert.equal(down.option.httpVersion, '2');
  assert.equal(down.address, 'download.test');
  assert.equal(down.option.path, '/down');
});
for (const fault of ['reject', 'redirect', 'headers'])
  test(`XHTTP split downlink ${fault} fails without upload replay or leaked leases`, async (t) => {
    const { client, target, up, down } = await topology(t, 'packet-up', '2', '2', {
      limits: { handshakeTimeoutMs: 1000 },
    });
    // Reuse negotiated HTTP/2 clients: the injected failure tests response
    // headers, independently of TLS scheduling on shared CI machines.
    const warm = await client.dial(target);
    await exchange(warm, 1024);
    const closed = new Promise((resolve) => warm.once('close', resolve));
    warm.destroy();
    await closed;
    const uploads = up.requests.length,
      downloads = down.requests.length;
    down.setFault(fault);
    await assert.rejects(client.dial(target), {
      code: fault === 'headers' ? 'ERR_TIMEOUT' : 'ERR_TRANSPORT',
    });
    assert.equal(up.requests.length, uploads);
    assert.equal(down.requests.length, downloads + 1);
    await client.close();
    assert.equal(client.metrics.xhttp.active, 0);
  });
for (const side of ['up', 'down'])
  test(`XHTTP split ${side} physical failure terminates the affected flow without replay`, async (t) => {
    const value = await topology(t, 'stream-up', '2', '2');
    const stream = await value.client.dial(value.target);
    await exchange(stream, 4096);
    const closed = new Promise((resolve) => stream.once('close', resolve));
    const ended = assert.rejects(readBytes(stream, 1));
    value[side].break();
    await ended;
    await closed;
    assert.equal(stream.destroyed, true);
    await wait(25);
    assert.equal(value.down.requests.length, 1);
    assert.equal(value.up.requests.length, 1);
  });
test('XHTTP split cancellation of a pending downlink leaves established shared leases usable', async (t) => {
  const { client, target, down } = await topology(t, 'packet-up', '2', '2');
  const held = await client.dial(target);
  await exchange(held, 1024);
  down.setFault('headers');
  const controller = new AbortController();
  const pending = client.dial({ ...target, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, { code: 'ERR_CANCELLED' });
  down.setFault(undefined);
  await exchange(held, 32768);
  held.destroy();
  await client.close();
  assert.equal(client.metrics.xhttp.active, 0);
});
for (const side of ['up', 'down'])
  test(`XHTTP split validates the ${side} TLS identity independently`, async (t) => {
    const { config, target } = await topology(t, 'packet-up', '2', '2');
    const network = config.outbounds[0].networks[0];
    const tls = (side === 'up' ? network : network.option.downloadSettings).option.tls;
    for (const field of ['serverName', 'ca']) {
      const previous = tls[field];
      tls[field] =
        field === 'serverName'
          ? 'wrong.test'
          : require('node:fs').readFileSync(
              require('node:path').join(__dirname, 'fixtures/tls/rotated-cert.pem'),
              'utf8',
            );
      const client = createRuntime(config);
      await client.start();
      t.after(() => client.close());
      await assert.rejects(client.dial(target), { code: 'ERR_TLS' });
      await client.close();
      assert.equal(client.metrics.xhttp.active, 0);
      tls[field] = previous;
    }
  });
test('XHTTP split packet-up request retirement replaces only upload clients and keeps GET alive', async (t) => {
  const { client, target, down } = await topology(t, 'packet-up', '2', '2', {
    xmux: { maxConcurrency: 8, hMaxRequestTimes: 1 },
  });
  const stream = await client.dial(target);
  await exchange(stream, 131072);
  assert.ok(client.metrics.xhttp.retired > 2);
  assert.equal(down.requests.length, 1);
  assert.equal(client.metrics.xhttp.active, 2);
  stream.destroy();
});
test('XHTTP split downlink GOAWAY preserves accepted GETs and moves new connections', async (t) => {
  const { client, target, down } = await topology(t, 'stream-up', '2', '2');
  const held = await client.dial(target);
  await exchange(held, 1024);
  for (const session of down.sessions) session.goaway();
  await wait(30);
  const next = await client.dial(target);
  await Promise.all([exchange(held), exchange(next)]);
  assert.ok(client.metrics.xhttp.retired >= 1);
  held.destroy();
  next.destroy();
});
test('XHTTP split buffered streaming upload times out with bounded cancellation and cleanup', async (t) => {
  const { client, target, up } = await topology(t, 'stream-up', '1.1', '2', {
    limits: { handshakeTimeoutMs: 120 },
  });
  up.setFault('buffer');
  await assert.rejects(
    (async () => {
      const stream = await client.dial(target);
      await readBytes(stream, 1);
    })(),
  );
  await client.close();
  assert.equal(client.metrics.xhttp.active, 0);
});
test('XHTTP split rotation isolates downlink endpoints, keeps old flows and rolls back a failed candidate', async (t) => {
  const { config, target, server } = await topology(t, 'packet-up', '2', '2');
  const manager = createRuntimeManager(config);
  await manager.start();
  t.after(() => manager.close());
  const held = await manager.dial(target);
  await exchange(held, 1024);
  const nextDown = await proxy(t, {
    target: { port: server.listenersInfo[0].address.port },
    prefix: '/next/',
    host: 'next.test',
    method: 'GET',
    version: '1.1',
  });
  const next = structuredClone(config);
  next.outbounds[0].networks[0].option.downloadSettings = nextDown.network;
  const bad = structuredClone(next);
  bad.outbounds[0].networks[0].option.downloadSettings.option.tls.serverName = 'wrong.test';
  const ready = async (candidate) => {
    const s = await candidate.dial(target);
    try {
      await exchange(s, 1024);
    } finally {
      s.destroy();
    }
  };
  await assert.rejects(manager.rotate(bad, { ready }));
  await exchange(held, 32768);
  const result = await manager.rotate(next, { ready, drainTimeoutMs: 10000 });
  const current = await manager.dial(target);
  await Promise.all([exchange(held), exchange(current)]);
  assert.ok(nextDown.requests.length >= 2);
  assert.equal(manager.metrics.length, 2);
  held.destroy();
  current.destroy();
  await result.drained;
  await manager.close();
  assert.equal(manager.stats.generations, 0);
});
