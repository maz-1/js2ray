'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, checkConfig } = require('..');
const { dnsServer } = require('./fixtures/dns-server');
const { query, ecs } = require('../dns/wire');

test('DNS linear and indexed server matching preserve exact, suffix, keyword and RE2 priorities on large lists', async (t) => {
  const broad = await dnsServer(t, { addresses: ['192.0.2.1'] }),
    specific = await dnsServer(t, { addresses: ['192.0.2.2'] });
  const domains = Array.from({ length: 10000 }, (_, i) => `full:n${i}.synthetic`);
  domains.push('domain:zone.synthetic', 'keyword:needle', 'regexp:^regex[0-9]+\\.synthetic$');
  for (const domainMatcher of ['linear', 'mph', 'hybrid']) {
    const runtime = createRuntime({
      dns: {
        domainMatcher,
        queryStrategy: 'UseIPv4',
        servers: [
          { address: broad.address, port: broad.port, domains },
          {
            address: specific.address,
            port: specific.port,
            domains: ['full:exact.zone.synthetic'],
          },
        ],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    for (const [host, expected] of [
      ['n9999.synthetic', '192.0.2.1'],
      ['exact.zone.synthetic', '192.0.2.2'],
      ['hasneedle.synthetic', '192.0.2.1'],
      ['regex42.synthetic', '192.0.2.1'],
    ])
      assert.equal((await runtime.resolve(host))[0].address, expected);
  }
});

test('DNS server tags route TCP while local mode bypasses policy and generation caches remain isolated', async (t) => {
  const server = await dnsServer(t);
  for (const scheme of ['tcp', 'tcp+local']) {
    const runtime = createRuntime({
      dns: {
        queryStrategy: 'UseIPv4',
        servers: [{ address: `${scheme}://127.0.0.1:${server.port}`, tag: 'dns-up' }],
      },
      outbounds: [
        { tag: 'deny', protocol: 'blackhole' },
        { tag: 'allow', protocol: 'freedom' },
      ],
      routing: { rules: [{ inboundTag: ['dns-up'], network: 'tcp', outboundTag: 'allow' }] },
    });
    await runtime.start();
    t.after(() => runtime.close());
    assert.equal((await runtime.resolve('tags.policy.synthetic'))[0].address, '127.0.0.1');
  }
  const { createRuntimeManager } = require('..'),
    configuration = {
      dns: { servers: [{ address: server.address, port: server.port }], queryStrategy: 'UseIPv4' },
    };
  const manager = createRuntimeManager(configuration);
  await manager.start();
  t.after(() => manager.close());
  await manager.resolve('rotation.policy.synthetic');
  const before = server.calls.length;
  const rotation = await manager.rotate(configuration);
  await rotation.drained;
  await manager.resolve('rotation.policy.synthetic');
  assert.equal(server.calls.length, before + 1);
});

test('malformed compatibility shapes and DNS alias conflicts return diagnostics without throwing', () => {
  for (const dns of [
    null,
    [],
    { servers: {} },
    { servers: [null] },
    { clientIP: '192.0.2.1', clientIp: '192.0.2.2' },
    { cacheStrategy: 'enabled', disableCache: true },
  ]) {
    assert.equal(
      checkConfig({ dns, routing: { rules: [{ inboundTag: ['missing'], outboundTag: 'direct' }] } })
        .ok,
      false,
    );
  }
});

test('DNS common aliases, per-server controls and unsupported QUIC/script modes are diagnosed', () => {
  const report = checkConfig({
    compatibility: 'xray-25.3.6',
    dns: {
      clientIP: '192.0.2.199',
      disableFallbackIfMatch: true,
      servers: [
        {
          address: 'tcp://127.0.0.1:53',
          queryStrategy: 'UseIPv4',
          expectedIPs: ['127.0.0.0/8'],
          disableCache: true,
          timeoutMs: 100,
          tag: 'dns-tcp',
        },
      ],
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.config.dns.clientIp, '192.0.2.199');
  assert.deepEqual(report.config.dns.servers[0].expectIPs, ['127.0.0.0/8']);
  assert.equal(checkConfig(report.config).ok, true);
  for (const dns of [
    { script: 'unsafe.lua' },
    { servers: ['quic+local://127.0.0.1'] },
    { servers: ['fakedns'] },
    { servers: [{ address: 'tcp://127.0.0.1', port: 53 }] },
    { clientIp: 'bad' },
    { servers: [{ address: '127.0.0.1', queryStrategy: 'UseSystem' }] },
  ])
    assert.equal(checkConfig({ dns }).ok, false);
});

test('EDNS ECS encodes only the fixed IPv4 /24 or IPv6 /96 subnet with correct wire bounds', () => {
  assert.deepEqual(ecs(query('synthetic.example', 1, 7, '192.0.2.199')), {
    family: 4,
    prefix: 24,
    address: '192.0.2.0',
  });
  assert.deepEqual(ecs(query('synthetic.example', 28, 8, '2001:db8:1:2:3:4:5:6')), {
    family: 6,
    prefix: 96,
    address: '2001:db8:1:2:3:4:0:0',
  });
  assert.equal(ecs(query('synthetic.example', 1, 9)), undefined);
});

test('DNS direct TCP and local modes carry ECS overrides, respect cancellation and create no listeners', async (t) => {
  const server = await dnsServer(t);
  for (const scheme of ['tcp', 'tcp+local']) {
    const runtime = createRuntime({
      dns: {
        clientIp: '192.0.2.199',
        servers: [
          {
            address: `${scheme}://127.0.0.1:${server.port}`,
            clientIp: '2001:db8:1:2:3:4:5:6',
            queryStrategy: 'UseIPv4',
          },
        ],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    assert.equal((await runtime.resolve('tcp.synthetic.example'))[0].address, '127.0.0.1');
    assert.equal(server.calls.at(-1).transport, 'tcp');
    assert.equal(server.calls.at(-1).ecs.family, 6);
    assert.equal(runtime.stats.listeners, 0);
    await runtime.close();
  }
});

test('DNS profile fallback differs explicitly when every server is excluded', async (t) => {
  const server = await dnsServer(t);
  for (const compatibility of ['native', 'v2ray-5.14.1', 'xray-25.3.6']) {
    const runtime = createRuntime({
      compatibility,
      dns: {
        disableFallback: true,
        servers: [{ address: server.address, port: server.port, skipFallback: true }],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    if (compatibility === 'xray-25.3.6')
      assert.equal(
        (await runtime.resolve('fallback.synthetic.example', { family: 4 }))[0].address,
        '127.0.0.1',
      );
    else
      await assert.rejects(runtime.resolve('fallback.synthetic.example', { family: 4 }), {
        code: 'ERR_DNS',
      });
  }
  assert.equal(server.calls.length, 1);
});

test('V2Ray per-server query strategy replaces its default while Xray restricts the global family', async (t) => {
  const server = await dnsServer(t);
  for (const compatibility of ['v2ray-5.14.1', 'xray-25.3.6']) {
    const runtime = createRuntime({
      compatibility,
      dns: {
        queryStrategy: 'UseIPv4',
        servers: [{ address: server.address, port: server.port, queryStrategy: 'UseIPv6' }],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    if (compatibility === 'v2ray-5.14.1')
      assert.equal((await runtime.resolve('family.synthetic.example'))[0].family, 6);
    else await assert.rejects(runtime.resolve('family.synthetic.example'), { code: 'ERR_DNS' });
  }
  assert.deepEqual(
    server.calls.map((c) => c.type),
    [28],
  );
});

test('per-server cache disablement and ECS/family isolation preserve returned record copies', async (t) => {
  const server = await dnsServer(t);
  for (const disableCache of [false, true]) {
    const runtime = createRuntime({
      dns: {
        servers: [
          { address: server.address, port: server.port, disableCache, clientIp: '192.0.2.44' },
        ],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    const before = server.calls.length;
    const first = await runtime.resolve('cache.synthetic.example', { family: 4 });
    first[0].address = '192.0.2.99';
    assert.equal(
      (await runtime.resolve('cache.synthetic.example', { family: 4 }))[0].address,
      '127.0.0.1',
    );
    assert.equal(server.calls.length - before, disableCache ? 2 : 1);
    assert.equal((await runtime.resolve('cache.synthetic.example', { family: 6 }))[0].family, 6);
  }
});
