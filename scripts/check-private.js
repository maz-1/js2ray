'use strict';
// Local-only audit. Values are kept in memory and never printed or persisted.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const filename = process.argv[2];
if (!filename) throw Error('Pass the private config path.');
const input = JSON.parse(fs.readFileSync(filename, 'utf8'));
const secrets = [],
  ports = [];
function add(field, value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '/' ||
    value === 'localhost' ||
    (require('node:net').isIP(value) && /^(127\.|0\.|::1$)/.test(value))
  )
    return;
  const variants = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  if (/^[\da-f-]{36}$/i.test(value)) {
    variants.add(value.replaceAll('-', ''));
    variants.add(value.toUpperCase());
  }
  secrets.push({ field, variants: [...variants] });
}
function prefixes(value, prefix = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const field = prefix + '.' + key;
    if (/prefix/i.test(key)) add(field, item);
    prefixes(item, field);
  }
}
prefixes(input);
for (const [i, outbound] of (input.outbounds ?? []).entries()) {
  for (const [j, node] of (
    outbound.settings?.vnext ??
    outbound.settings?.servers ??
    []
  ).entries()) {
    const prefix = `outbounds[${i}].server[${j}]`;
    add(prefix + '.address', node.address);
    if (Number.isInteger(node.port)) ports.push({ field: prefix + '.port', value: node.port });
    for (const [u, user] of (node.users ?? []).entries())
      for (const key of ['id', 'email', 'user', 'pass', 'password', 'prefix'])
        add(`${prefix}.users[${u}].${key}`, user[key]);
  }
  const stream = outbound.streamSettings;
  const requestPath = stream?.wsSettings?.path;
  if (typeof requestPath === 'string')
    for (const [part, value] of requestPath.split(/[/?&#=]+/).entries())
      if (value.length >= 6 && !['vless', 'websocket', 'dns-query'].includes(value))
        add(`outbounds[${i}].pathFragment[${part}]`, value);
  for (const [field, value] of Object.entries({
    path: stream?.wsSettings?.path,
    host: stream?.wsSettings?.host,
    headerHost: stream?.wsSettings?.headers?.Host,
    serverName: stream?.tlsSettings?.serverName,
  }))
    add(`outbounds[${i}].${field}`, value);
}
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const matches = [],
  genericPorts = new Map();
function scan(file, text, object) {
  for (const secret of secrets)
    if (secret.variants.some((value) => text.includes(value)))
      matches.push({ file, field: secret.field, ...(object ? { object } : {}) });
  for (const port of ports)
    if (new RegExp(`(^|[^a-zA-Z0-9])${port.value}([^a-zA-Z0-9]|$)`).test(text)) {
      if ([53, 80, 443].includes(port.value))
        genericPorts.set(port.field, (genericPorts.get(port.field) ?? 0) + 1);
      else matches.push({ file, field: port.field, ...(object ? { object } : {}) });
    }
}
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of files)
  if (fs.existsSync(file) && fs.statSync(file).isFile())
    scan(file, fs.readFileSync(file).toString('utf8'));
const base = 'ee6f59e^',
  objects = git(['rev-list', '--objects', `${base}..HEAD`])
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
});
let offset = 0,
  blobs = 0;
while (offset < batch.length) {
  const end = batch.indexOf(10, offset),
    [object, type, length] = batch.toString('utf8', offset, end).split(' ');
  const size = Number(length);
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
      'user IDs and UUID variants',
      'prefix fields',
      'remote server addresses',
      'nonstandard remote ports',
      'email, Host, SNI, paths',
    ],
    matches,
    genericPortFields: [...genericPorts.keys()],
    note: 'Generic DNS/HTTP/HTTPS port numbers are public protocol constants; private endpoint identities and nonstandard ports are not allowlisted.',
  }) + '\n',
);
if (matches.length) process.exitCode = 1;
