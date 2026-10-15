'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const audit = require('./private-audit');
const filename = process.argv[2];
if (!filename) throw Error('Pass the private config path.');
const material = audit.collect(JSON.parse(fs.readFileSync(filename, 'utf8')));
const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const matches = [],
  genericPorts = new Set(),
  publicDnsFields = new Set();
function scan(file, text, object) {
  const result = audit.scan(material, file, text, object);
  matches.push(...result.matches);
  for (const field of result.genericPorts) genericPorts.add(field);
  for (const field of result.publicDnsFields) publicDnsFields.add(field);
}
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of files)
  if (fs.existsSync(file) && fs.statSync(file).isFile())
    scan(file, fs.readFileSync(file).toString('utf8'));
const base = process.argv[3] ?? 'ee6f59e^';
const objects = git(['rev-list', '--objects', `${base}..HEAD`])
  .trim()
  .split('\n')
  .filter(Boolean);
const paths = new Map(
  objects.map((line) => {
    const index = line.indexOf(' ');
    return [
      index < 0 ? line : line.slice(0, index),
      index < 0 ? '<object>' : line.slice(index + 1),
    ];
  }),
);
const batch = execFileSync('git', ['cat-file', '--batch'], {
  input: [...paths.keys()].join('\n') + '\n',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
});
let offset = 0,
  blobs = 0;
while (offset < batch.length) {
  const end = batch.indexOf(10, offset),
    [object, type, length] = batch.toString('utf8', offset, end).split(' '),
    size = Number(length);
  if (end < 0 || !Number.isSafeInteger(size)) throw Error('Invalid Git audit data.');
  offset = end + 1;
  if (type === 'blob') {
    blobs++;
    scan(paths.get(object), batch.toString('utf8', offset, offset + size), object);
  }
  offset += size + 1;
}
process.stdout.write(
  JSON.stringify({
    ok: !matches.length,
    filesChecked: files.length,
    historyBlobsChecked: blobs,
    checked: [
      'native and traditional user IDs and UUID variants',
      'prefix fields',
      'remote server addresses and nonstandard ports',
      'REALITY/TLS keys and short IDs including encoded variants',
      'email, Host, SNI, paths and authorization headers',
    ],
    matches,
    genericPortFields: [...genericPorts],
    publicDnsFields: [...publicDnsFields],
    note: 'Only protocol-standard ports, local endpoint identities, and explicitly catalogued public DNS identities are excluded; custom DNS paths, query values and ports remain checked. Matched values are never printed.',
  }) + '\n',
);
if (matches.length) process.exitCode = 1;
