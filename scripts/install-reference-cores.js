'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const platforms = require('../test/fixtures/reference-platforms.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const platform = `${process.platform}-${process.arch}`,
    entries = platforms[platform];
  if (!entries) throw Error(`No reference lock for ${platform}.`);
  const directory = path.resolve(__dirname, '../.test-tools');
  fs.mkdirSync(directory, { recursive: true });
  for (const [kind, item] of Object.entries(entries)) {
    const filename = path.join(directory, kind + (process.platform === 'win32' ? '.exe' : ''));
    if (fs.existsSync(filename) && sha(fs.readFileSync(filename)) === item.sha256) continue;
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Reference download failed: ${kind} HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 128 * 1024 * 1024 || sha(bytes) !== item.archiveSha256)
      throw Error(`Reference archive checksum mismatch: ${kind}`);
    const archive = path.join(directory, `${kind}-${platform}.zip`),
      unpacked = path.join(directory, `${kind}-${platform}`);
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(unpacked, { recursive: true });
    if (process.platform === 'win32')
      execFileSync('tar.exe', ['-xf', archive, '-C', unpacked], { windowsHide: true });
    else execFileSync('unzip', ['-q', '-o', archive, '-d', unpacked]);
    const binary = path.join(
      unpacked,
      (kind === 'xray-xhttp' ? 'xray' : kind) + (process.platform === 'win32' ? '.exe' : ''),
    );
    if (sha(fs.readFileSync(binary)) !== item.sha256)
      throw Error(`Reference binary checksum mismatch: ${kind}`);
    fs.copyFileSync(binary, filename);
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o700);
    process.stdout.write(`Installed verified ${kind} for ${platform}.\n`);
  }
  await require('./install-reference-proxies').install();
}
main().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
