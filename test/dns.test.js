'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, checkConfig } = require('..');
const { dnsServer, answer } = require('./fixtures/dns-server');
const { query, response } = require('../dns/wire');
const { echo, readBytes } = require('./helpers');

test('DNS wire verifies identity, question, lengths and compressed-name cycles', () => {
  const request = query('example.test', 1, 1234),
    reply = answer(request);
  assert.equal(response(reply, request).records[0].address, '127.0.0.1');
  const badId = Buffer.from(reply);
  badId[0] ^= 1;
  const cycle = Buffer.from(reply);
  cycle[12] = 0xc0;
  cycle[13] = 12;
  for (const bad of [badId, cycle, reply.subarray(0, reply.length - 1), Buffer.alloc(4)])
    assert.throws(() => response(bad, request), { code: 'ERR_DNS' });
});

test('hosts aliases, A/AAAA, cache, routed UDP and truncated TCP fallback', async (t) => {
  const server = await dnsServer(t, { truncate: true });
  const runtime = createRuntime({
    dns: {
      hosts: {
        'alias.test': 'fixed.test',
        'fixed.test': ['192.0.2.1', '2001:db8::1'],
        'cycle.test': 'cycle.test',
      },
      servers: [{ address: server.address, port: server.port }],
    },
  });
  await runtime.start();
  t.after(() => runtime.close());
  assert.equal((await runtime.resolve('alias.test', { family: 6 }))[0].address, '2001:db8::1');
  assert.equal((await runtime.resolve('::1'))[0].family, 6);
  await assert.rejects(runtime.resolve('cycle.test'), { code: 'ERR_DNS' });
  const records = await runtime.resolve('remote.test');
  assert.deepEqual(records.map((record) => record.family).sort(), [4, 6]);
  assert.equal(server.calls.length, 4);
  await runtime.resolve('remote.test');
  assert.equal(server.calls.length, 4);
  assert.equal(runtime.listenersInfo.length, 0);
});

test('server domain selection, expected IP fallback, per-server timeout, cancellation and closure', async (t) => {
  const first = await dnsServer(t, { addresses: ['192.0.2.9'] });
  const fallback = await dnsServer(t);
  const silent = await dnsServer(t, { silent: true });
  const runtime = createRuntime({
    dns: {
      timeoutMs: 50,
      queryStrategy: 'UseIPv4',
      servers: [
        {
          address: first.address,
          port: first.port,
          domains: ['domain:preferred.test'],
          expectIPs: ['10.0.0.0/8'],
        },
        {
          address: silent.address,
          port: silent.port,
          domains: ['full:timeout.test'],
          skipFallback: true,
        },
        { address: fallback.address, port: fallback.port },
      ],
    },
  });
  await runtime.start();
  t.after(() => runtime.close());
  assert.equal((await runtime.resolve('x.preferred.test'))[0].address, '127.0.0.1');
  assert.equal(first.calls.length, 1);
  assert.equal(fallback.calls.length, 1);
  assert.equal((await runtime.resolve('timeout.test'))[0].address, '127.0.0.1');
  const controller = new AbortController(),
    pending = runtime.resolve('timeout.test', { signal: controller.signal, family: 6 });
  controller.abort();
  await assert.rejects(pending, { code: 'ERR_CANCELLED' });
  await runtime.close();
  assert.equal(runtime.stats.connections, 0);
  assert.equal(runtime.stats.pendingDials, 0);
});

test('DoH validates target TLS and supports explicit routed and local bootstrap paths', async (t) => {
  const server = await dnsServer(t);
  for (const scheme of ['https', 'https+local']) {
    const runtime = createRuntime({
      dns: {
        hosts: { 'js2ray.test': '127.0.0.1' },
        servers: [
          {
            address: `${scheme}://js2ray.test:${server.dohPort}/dns-query`,
            tls: { ca: server.cert },
          },
        ],
      },
    });
    await runtime.start();
    t.after(() => runtime.close());
    assert.equal((await runtime.resolve('doh.test', { family: 4 }))[0].address, '127.0.0.1');
    assert.equal(runtime.listenersInfo.length, 0);
    await runtime.close();
  }
  const invalid = createRuntime({
    dns: { servers: [{ address: `https://127.0.0.1:${server.dohPort}/dns-query` }] },
  });
  await invalid.start();
  t.after(() => invalid.close());
  await assert.rejects(invalid.resolve('bad.test'), { code: 'ERR_DNS' });
});

test('Freedom UseIP uses DNS while AsIs node bootstrap and route matching remain independent', async (t) => {
  const server = await dnsServer(t),
    destination = await echo(t);
  const runtime = createRuntime({
    dns: { servers: [{ address: server.address, port: server.port }] },
    outbounds: [{ protocol: 'freedom', domainStrategy: 'UseIPv4' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', ip: ['127.0.0.0/8'], outboundTag: 'outbound-0' }],
    },
  });
  await runtime.start();
  t.after(() => runtime.close());
  const stream = await runtime.dial({ host: 'destination.test', port: destination.port });
  stream.write('dns');
  assert.equal((await readBytes(stream, 3)).toString(), 'dns');
  assert.equal(server.calls.filter((call) => call.host === 'destination.test').length, 1);
  for (const dns of [
    { servers: ['unbootstrapped.test'] },
    { queryStrategy: 'IgnoreIP' },
    { servers: [{ address: 'https://example.test', tls: { rejectUnauthorized: false } }] },
  ])
    assert.equal(checkConfig({ dns }).ok, false);
});
