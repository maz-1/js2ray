'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkConfig, normalizeConfig, redact } = require('../');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const vless = () => ({
  tag: 'proxy',
  protocol: 'vless',
  settings: {
    vnext: [
      { address: '192.0.2.1', port: 443, users: [{ id, encryption: 'none', security: 'auto' }] },
    ],
  },
  streamSettings: {
    network: 'ws',
    security: 'tls',
    tlsSettings: { serverName: 'certificate.test', allowInsecure: false },
    wsSettings: { path: '/test', host: 'host.test', headers: { Host: 'host.test' } },
  },
  mux: { enabled: false, concurrency: -1 },
});

test('traditional VLESS WSS normalizes separately and retains recognized metadata', () => {
  const input = { inbounds: [], outbounds: [vless()] };
  const copy = JSON.stringify(input);
  const report = checkConfig(input);
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  const network = report.config.outbounds[0].networks[0];
  assert.equal(network.address, '192.0.2.1');
  assert.equal(network.option.tls.serverName, 'certificate.test');
  assert.equal(network.option.headers.Host, 'host.test');
  assert.equal(network.option.tls.rejectUnauthorized, true);
  assert.equal(report.metadata.length, 1);
  assert.equal(JSON.stringify(input), copy);
  assert.equal(JSON.stringify(redact(report)).includes(id), false);
  const redacted = JSON.stringify(
    redact({ option: { path: '/private-token', headers: { Authorization: 'synthetic-secret' } } }),
  );
  assert.equal(redacted.includes('synthetic-secret'), false);
  assert.equal(redacted.includes('/private-token'), false);
});

test('conflicting Host values and unknown transport/security/flow never get ignored', () => {
  const outbound = vless();
  outbound.streamSettings.wsSettings.host = 'conflict.test';
  outbound.streamSettings.security = 'reality';
  outbound.settings.vnext[0].users[0].flow = 'xtls-rprx-vision';
  const report = checkConfig({ outbounds: [outbound] });
  for (const suffix of ['host', 'security', 'flow'])
    assert.ok(report.diagnostics.some((item) => item.path.endsWith('.' + suffix)));
});

test('relative certificate and storage files resolve against baseDir without I/O', () => {
  const config = normalizeConfig(
    {
      storage: 'usage.json',
      outbounds: [
        {
          protocol: 'vless',
          users: [{ id, encryption: 'none' }],
          networks: [
            { address: 'example.test', port: 443, option: { tls: { caFile: 'cert.pem' } } },
          ],
        },
      ],
    },
    { baseDir: require('node:path').resolve('examples') },
  );
  assert.equal(config.storage, require('node:path').resolve('examples/usage.json'));
  assert.equal(
    config.outbounds[0].networks[0].option.tls.caFile,
    require('node:path').resolve('examples/cert.pem'),
  );
});

test('invalid shapes always return diagnostics rather than crashing', () => {
  for (const input of [
    null,
    [],
    { storage: 1 },
    { outbounds: null },
    { inbounds: [null] },
    { limits: 'bad' },
    { inbounds: [{ protocol: 'socks', networks: [{ port: 0, option: [] }] }] },
  ]) {
    assert.doesNotThrow(() => checkConfig(input));
    assert.equal(checkConfig(input).ok, false);
  }
});

test('the full reference requirements remain a failing fixture until their behavior exists', () => {
  const report = checkConfig(require('./fixtures/reference-config.pending.json'));
  assert.equal(report.ok, false);
  for (const field of ['reverse', 'dns', 'routing', 'routing.rules[1].outboundTag'])
    assert.ok(report.diagnostics.some((item) => item.path === field));
});

test('normalization is reusable as runtime input', () => {
  const normalized = normalizeConfig({});
  assert.equal(checkConfig(normalized).ok, true);
});
