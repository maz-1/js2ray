'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../routing');
const { createRuntime, checkConfig } = require('..');
const { echo, readBytes } = require('./helpers');

test('routing follows ordered OR candidates and AND fields without resolving AsIs names', () => {
  const router = new Router({
    domainStrategy: 'AsIs',
    rules: [
      {
        type: 'field',
        inboundTag: ['a', 'b'],
        domain: ['full:exact.test', 'domain:zone.test'],
        network: 'tcp',
        port: '80,443-444',
        outboundTag: 'proxy',
      },
      { type: 'field', ip: ['10.0.0.0/8', '2001:db8::/32'], outboundTag: 'direct' },
    ],
  });
  assert.equal(
    router.select({ host: 'sub.zone.test', port: 443, inboundTag: 'b', network: 'tcp' }),
    'proxy',
  );
  assert.equal(
    router.select({ host: 'sub.zone.test', port: 443, inboundTag: 'c', network: 'tcp' }),
    undefined,
  );
  assert.equal(router.select({ host: '10.1.2.3', port: 80, network: 'tcp' }), 'direct');
  assert.equal(router.select({ host: '2001:db8::5', port: 80, network: 'tcp' }), 'direct');
  assert.equal(router.select({ host: '10.example', port: 80, network: 'tcp' }), undefined);
});

test('Blackhole blocks TCP and UDP 443 while redirect preserves explicit outbound selection', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime({
    outbounds: [
      { tag: 'direct', protocol: 'freedom', redirect: `${target.host}:${target.port}` },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
        { type: 'field', domain: ['domain:blocked.test'], outboundTag: 'block' },
      ],
    },
  });
  await runtime.start();
  t.after(() => runtime.close());
  await assert.rejects(runtime.dial({ host: 'blocked.test', port: 80 }), { code: 'ERR_BLOCKED' });
  await assert.rejects(runtime.openDatagram({ host: 'example.test', port: 443 }), {
    code: 'ERR_BLOCKED',
  });
  const stream = await runtime.dial({ host: 'blocked.test', port: 80, outboundTag: 'direct' });
  stream.write('redirect');
  assert.equal((await readBytes(stream, 8)).toString(), 'redirect');
});

test('unsupported routing conditions, missing tags, and invalid CIDR fail configuration', () => {
  for (const rule of [
    { source: ['10.0.0.0/8'] },
    { ip: ['10.0.0.0/99'] },
    { domain: ['regexp:.*'] },
    { network: 'quic' },
    { port: '443-80' },
  ]) {
    assert.equal(
      checkConfig({ routing: { rules: [{ ...rule, outboundTag: 'direct' }] } }).ok,
      false,
    );
  }
  assert.equal(
    checkConfig({ routing: { rules: [{ domain: ['full:x.test'], outboundTag: 'missing' }] } }).ok,
    false,
  );
});
