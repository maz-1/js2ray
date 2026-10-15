'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeoData, protobuf } = require('../geodata');
const { Router } = require('../routing');
const { checkConfig } = require('..');
const manifest = require('./fixtures/geodata/manifest.json');
test('standard GeoIP and GeoSite resources preserve inversion and literal category names', () => {
  const data = new GeoData(manifest);
  assert.equal(data.ip('cn')('198.18.2.1'), true);
  assert.equal(data.ip('!cn')('198.18.2.1'), false);
  assert.equal(data.ip('!cn')('192.0.2.1'), true);
  assert.equal(data.site('geolocation-!cn')('sub.remote.test'), true);
  assert.equal(data.site('geolocation-!cn')('cn.test'), false);
  const router = new Router(
    {
      rules: [
        { domain: ['geosite:category-ads-all'], outboundTag: 'block' },
        { domain: ['geosite:cn'], outboundTag: 'direct' },
        { ip: ['geoip:!cn'], outboundTag: 'proxy' },
      ],
    },
    data,
  );
  assert.equal(router.select({ host: 'ads.test' }), 'block');
  assert.equal(router.select({ host: 'sub.cn.test' }), 'direct');
  assert.equal(router.select({ host: '192.0.2.1' }), 'proxy');
});
test('resources fail closed on missing category, file, hash, version, format and size', () => {
  for (const resource of [
    { ...manifest.geoip, path: 'missing.dat' },
    { ...manifest.geoip, sha256: '0'.repeat(64) },
    { ...manifest.geoip, version: '' },
    { ...manifest.geoip, maxBytes: 1 },
  ])
    assert.equal(checkConfig({ geodata: { geoip: resource } }).ok, false);
  assert.equal(
    checkConfig({
      geodata: manifest,
      routing: { rules: [{ domain: ['geosite:missing'], outboundTag: 'direct' }] },
    }).ok,
    false,
  );
  for (const bytes of [
    Buffer.from([10, 255]),
    Buffer.from([0]),
    Buffer.from([15]),
    Buffer.alloc(10, 255),
  ])
    assert.throws(() => protobuf(bytes));
});
