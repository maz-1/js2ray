'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
async function install() {
  const lock = require('../test/fixtures/reference-proxies.json').caddy;
  const item = lock.platforms[`${process.platform}-${process.arch}`];
  if (!item) throw Error('No fixed Caddy reference for this platform.');
  const directory = path.resolve(__dirname, '../.test-tools');
  const binaryName = 'caddy' + (process.platform === 'win32' ? '.exe' : '');
  const binary = path.join(directory, binaryName);
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  if (fs.existsSync(binary) && sha(fs.readFileSync(binary)) === item.sha256) return;
  const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error('Caddy reference download failed: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > 128 * 1024 * 1024 ||
    sha(bytes) !== item.archiveSha256 ||
    crypto.createHash('sha512').update(bytes).digest('hex') !== item.archiveSha512
  )
    throw Error('Caddy reference archive checksum mismatch.');
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, 'caddy-' + process.platform + '.' + item.archive);
  const unpacked = path.join(directory, 'caddy-' + process.platform);
  fs.writeFileSync(archive, bytes);
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', unpacked], {
    windowsHide: true,
  });
  const source = path.join(unpacked, binaryName);
  if (sha(fs.readFileSync(source)) !== item.sha256)
    throw Error('Caddy reference binary checksum mismatch.');
  fs.copyFileSync(source, binary);
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o700);
  process.stdout.write('Installed verified Caddy ' + lock.version + '.\n');
}
module.exports = { install };
if (require.main === module)
  install().catch((e) => {
    process.stderr.write(e.message + '\n');
    process.exitCode = 1;
  });
