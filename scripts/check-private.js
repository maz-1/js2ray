'use strict';
// Optional local check: print paths only, never values from the private config.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const filename = process.argv[2];
if (!filename) throw Error('Pass the private config path.');
const input = JSON.parse(fs.readFileSync(filename, 'utf8')),
  values = new Set();
for (const outbound of input.outbounds ?? []) {
  for (const node of outbound.settings?.vnext ?? []) {
    if (
      (node.address && !require('node:net').isIP(node.address)) ||
      (node.address && !/^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(node.address))
    )
      values.add(node.address);
    for (const user of node.users ?? [])
      for (const key of ['id', 'email']) if (user[key]) values.add(user[key]);
  }
  const stream = outbound.streamSettings;
  for (const value of [
    stream?.wsSettings?.path,
    stream?.wsSettings?.host,
    stream?.wsSettings?.headers?.Host,
    stream?.tlsSettings?.serverName,
  ])
    if (value && value.length > 3) values.add(value);
}
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean),
  leaks = [];
for (const file of files) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  const text = fs.readFileSync(file).toString('utf8');
  if ([...values].some((value) => typeof value === 'string' && text.includes(value)))
    leaks.push(file);
}
process.stdout.write(
  JSON.stringify({ ok: !leaks.length, filesChecked: files.length, matchedFiles: leaks }) + '\n',
);
if (leaks.length) process.exitCode = 1;
