'use strict';
// Informational probe only. Missing QUIC is recorded as unavailable, never as
// successful HTTP/3 interoperability or as a skipped protocol acceptance test.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const result = spawnSync(
  process.execPath,
  [
    '--experimental-quic',
    '-e',
    `
  const result = {
    node: process.version, platform: process.platform, arch: process.arch,
    compiledWithQuic: process.config.variables.node_use_quic ?? null,
    ngtcp2: process.versions.ngtcp2 || null,
    nghttp3: process.versions.nghttp3 || null,
    available: false,
  };
  try {
    const quic = require('node:quic');
    result.available = true;
    result.exports = Object.keys(quic).sort();
  } catch (error) { result.errorCode = error.code; }
  process.stdout.write(JSON.stringify(result));
`,
  ],
  { encoding: 'utf8', timeout: 10000, windowsHide: true },
);
if (result.error || result.status !== 0) throw Error('HTTP/3 capability probe failed to execute.');
const record = JSON.parse(result.stdout);
record.probeOnly = true;
fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync('test-results/http3-capability.json', JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify(record) + '\n');
