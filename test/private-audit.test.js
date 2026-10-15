'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { collect, scan } = require('../scripts/private-audit');
test('privacy audit covers native/traditional fields and REALITY encoded credentials without disclosing values', () => {
  const id = crypto.randomUUID(),
    secret = crypto.randomBytes(32),
    sid = crypto.randomBytes(8).toString('hex'),
    prefix = 'private-prefix-' + crypto.randomBytes(8).toString('hex');
  const input = {
    dns: {
      clientIp: '192.0.2.123',
      hosts: { 'private-hosts.audit.test': '198.51.100.123' },
      servers: [{ address: 'tcp://private-dns.audit.test:43216' }],
    },
    routing: {
      rules: [
        {
          source: ['198.51.100.123/32'],
          user: ['private-routing-user'],
          attrs: { 'x-policy': 'private-header-regex' },
        },
      ],
    },
    outbounds: [
      {
        users: [{ id, prefix }],
        networks: [
          {
            address: 'private-node.audit.test',
            port: 43219,
            option: {
              reality: {
                publicKey: secret.toString('base64url'),
                shortId: sid,
                serverName: 'private-sni.audit.test',
              },
              headers: { Authorization: 'Bearer private-auth-marker' },
            },
          },
        ],
      },
      {
        settings: {
          vnext: [
            {
              address: 'traditional-node.audit.test',
              port: 43218,
              users: [{ id, password: 'private-password-marker' }],
            },
          ],
        },
        streamSettings: {
          wsSettings: {
            path: '/private-path-marker',
            headers: { host: 'private-host.audit.test' },
          },
        },
      },
    ],
    inbounds: [
      {
        networks: [
          {
            port: 10443,
            option: {
              reality: {
                privateKey: secret.toString('base64url'),
                shortIds: [sid],
                dest: 'cover-private.audit.test:43217',
              },
            },
          },
        ],
      },
    ],
  };
  const material = collect(input);
  for (const value of [
    id,
    id.replaceAll('-', ''),
    id.toUpperCase(),
    prefix,
    'private-node.audit.test',
    '43219',
    '43218',
    'private-sni.audit.test',
    secret.toString('base64url'),
    secret.toString('base64'),
    secret.toString('hex'),
    sid,
    sid.toUpperCase(),
    '43217',
    'cover-private.audit.test',
    'private-password-marker',
    'private-host.audit.test',
    '/private-path-marker',
    encodeURIComponent('/private-path-marker'),
    'Bearer private-auth-marker',
    '192.0.2.123',
    '198.51.100.123/32',
    'private-dns.audit.test',
    '43216',
    'private-header-regex',
    'private-routing-user',
  ]) {
    const result = scan(material, 'synthetic', value);
    assert.ok(result.matches.length, value.length + '-byte synthetic field was missed.');
    assert.equal(JSON.stringify(result).includes(value), false);
  }
  assert.equal(
    scan(material, 'safe', '127.0.0.1 localhost 53 80 443 10443 public material').matches.length,
    0,
  );
  const short = collect({
    outbounds: [{ networks: [{ option: { reality: { shortId: 'ab' } } }] }],
  });
  assert.equal(scan(short, 'safe', 'stable abcdef').matches.length, 0);
  assert.equal(scan(short, 'leak', '"ab"').matches.length, 1);
});
test('privacy audit detects deleted historical REALITY credentials without printing values', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-audit-')),
    repository = path.join(directory, 'repo');
  fs.mkdirSync(repository);
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync('git', args, { cwd: repository, windowsHide: true, stdio: 'pipe' })
      .toString()
      .trim();
  git('init');
  git('config', 'user.email', 'synthetic@example.test');
  git('config', 'user.name', 'Synthetic audit');
  fs.writeFileSync(path.join(repository, 'safe.txt'), 'initial');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const key = crypto.randomBytes(32).toString('base64url'),
    filename = path.join(directory, 'private.json');
  fs.writeFileSync(
    filename,
    JSON.stringify({ inbounds: [{ networks: [{ option: { reality: { privateKey: key } } }] }] }),
  );
  fs.writeFileSync(path.join(repository, 'removed.txt'), key);
  git('add', '.');
  git('commit', '-m', 'synthetic history');
  fs.unlinkSync(path.join(repository, 'removed.txt'));
  git('add', '.');
  git('commit', '-m', 'remove');
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/check-private.js'), filename, base],
    { cwd: repository, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.matches.some((match) => match.object && match.field.endsWith('privateKey')));
  assert.equal(result.stdout.includes(key), false);
});
