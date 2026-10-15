'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { duplexPair } = require('node:stream');
const { Router } = require('../routing');
const { createRuntime } = require('..');
const rules = [
  { ip: ['2001:db8::/32', '198.18.0.0/15'], outboundTag: 'ip' },
  { domain: ['full:domain.test'], outboundTag: 'domain' },
];
test('all three routing strategies distinguish domain-first and ordered IP matching, including all A/AAAA addresses', async () => {
  for (const [domainStrategy, expected, calls] of [
    ['AsIs', 'domain', 0],
    ['IPIfNonMatch', 'domain', 0],
    ['IPOnDemand', 'ip', 1],
  ]) {
    const router = new Router({ domainStrategy, rules });
    let queried = 0;
    assert.equal(
      await router.selectAsync({ host: 'domain.test' }, async () => {
        queried++;
        return [{ address: '192.0.2.1' }, { address: '2001:db8::1' }];
      }),
      expected,
    );
    assert.equal(queried, calls);
  }
  const router = new Router({ domainStrategy: 'IPIfNonMatch', rules });
  assert.equal(
    await router.selectAsync({ host: 'other.test' }, async () => [
      { address: '192.0.2.1' },
      { address: '198.18.1.2' },
    ]),
    'ip',
  );
  assert.equal(
    await router.selectAsync({ host: '2001:db8::1' }, () =>
      assert.fail('literal must not resolve'),
    ),
    'ip',
  );
});
test('DNS linked routing keeps the forwarded domain and explicit outbound skips resolution', async (t) => {
  const seen = [],
    peers = [];
  const runtime = createRuntime(
    {
      dns: { hosts: { 'domain.test': ['192.0.2.1', '198.18.1.2'] } },
      routing: {
        domainStrategy: 'IPOnDemand',
        rules: [{ ip: ['198.18.0.0/15'], outboundTag: 'selected' }],
      },
      outbounds: [
        { protocol: 'blackhole', tag: 'default' },
        {
          protocol: 'service',
          tag: 'selected',
          service: 'sink',
          allow: { host: 'domain.test', port: 80 },
        },
      ],
    },
    {
      services: {
        sink: (target) => {
          seen.push(target);
          const [left, right] = duplexPair();
          peers.push(right);
          return left;
        },
      },
    },
  );
  await runtime.start();
  t.after(async () => {
    peers.forEach((p) => p.destroy());
    await runtime.close();
  });
  const stream = await runtime.dial({ host: 'domain.test', port: 80 });
  assert.equal(seen[0].host, 'domain.test');
  stream.destroy();
  const queries = runtime.metrics.dns.queries;
  const explicit = await runtime.dial({ host: 'domain.test', port: 80, outboundTag: 'selected' });
  explicit.destroy();
  assert.equal(runtime.metrics.dns.queries, queries);
});
test('route DNS honors cancellation and never recursively uses routed DNS for its own bootstrap', async (t) => {
  let calls = 0;
  const runtime = createRuntime(
    {
      routing: {
        domainStrategy: 'IPOnDemand',
        rules: [{ ip: ['127.0.0.0/8'], outboundTag: 'direct' }],
      },
    },
    {
      lookup() {
        calls++;
      },
    },
  );
  await runtime.start();
  t.after(() => runtime.close());
  const abort = new AbortController();
  const pending = runtime.dial({ host: 'pending.test', port: 80, signal: abort.signal });
  const rejected = assert.rejects(pending, { code: 'ERR_CANCELLED' });
  abort.abort();
  await rejected;
  assert.ok(calls <= 2);
  assert.equal(runtime.metrics.dns.pending, 0);
});
