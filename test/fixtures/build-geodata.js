'use strict';
// Tiny, synthetic standard V2Ray protobuf resources. No production domain/IP database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { iptoBuffer } = require('../../core/utils');
const uint = (value) => {
  const bytes = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
};
const field = (number, value) =>
  typeof value === 'number'
    ? Buffer.concat([uint(number * 8), uint(value)])
    : Buffer.concat([uint(number * 8 + 2), uint(Buffer.byteLength(value)), Buffer.from(value)]);
const entry = (code, values) =>
  field(
    1,
    Buffer.concat([field(1, code.toUpperCase()), ...values.map((value) => field(2, value))]),
  );
const site = (type, value) => Buffer.concat([field(1, type), field(2, value)]);
const files = {
  geoip: Buffer.concat([
    entry('cn', [Buffer.concat([field(1, iptoBuffer('198.18.0.0')), field(2, 15)])]),
    entry('private', [Buffer.concat([field(1, iptoBuffer('127.0.0.0')), field(2, 8)])]),
  ]),
  geosite: Buffer.concat([
    entry('cn', [site(2, 'cn.test')]),
    entry('geolocation-!cn', [site(2, 'remote.test')]),
    entry('category-ads-all', [site(2, 'ads.test')]),
  ]),
};
if (require.main === module) {
  const directory = path.join(__dirname, 'geodata');
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {};
  for (const [kind, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, kind + '.dat'), bytes);
    manifest[kind] = {
      path: `test/fixtures/geodata/${kind}.dat`,
      version: 'synthetic-v1',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
module.exports = { field, entry, site };
