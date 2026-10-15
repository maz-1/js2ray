'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { freePort } = require('../interop/helpers');
const { certFile, keyFile, ca } = require('./xhttp-proxy');
const lock = require('./reference-proxies.json').caddy;
async function caddy(
  t,
  target,
  {
    upPrefix = '/up/',
    downPrefix = '/down/',
    backendPath = '/shared/',
    upVersion = '2',
    downVersion = '2',
  } = {},
) {
  const binary = path.resolve(
    __dirname,
    '../../.test-tools/caddy' + (process.platform === 'win32' ? '.exe' : ''),
  );
  const item = lock.platforms[`${process.platform}-${process.arch}`];
  if (
    !item ||
    !fs.existsSync(binary) ||
    crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== item.sha256
  )
    throw Error('Missing or invalid fixed Caddy reference. Run npm run test:tools.');
  const version = spawnSync(binary, ['version'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status || !version.stdout.includes('v' + lock.version))
    throw Error('Wrong Caddy version.');
  const upPort = await freePort(),
    downPort = await freePort();
  const routes = [upPrefix, downPrefix].map((prefix) => ({
    match: [{ path: [prefix + '*'] }],
    handle: [
      { handler: 'rewrite', strip_path_prefix: prefix.slice(0, -1) },
      { handler: 'rewrite', uri: backendPath.slice(0, -1) + '{http.request.uri}' },
      {
        handler: 'reverse_proxy',
        flush_interval: -1,
        headers: { request: { set: { Connection: ['close'] } } },
        transport: { protocol: 'http', versions: ['1.1'] },
        upstreams: [{ dial: `127.0.0.1:${target.port}` }],
      },
    ],
  }));
  const config = {
    admin: { disabled: true },
    storage: { module: 'file_system', root: '' },
    apps: {
      tls: { certificates: { load_files: [{ certificate: certFile, key: keyFile }] } },
      http: {
        servers: Object.fromEntries(
          [
            [upPort, upVersion],
            [downPort, downVersion],
          ].map(([port, version], index) => [
            'p19-' + index,
            {
              listen: [`127.0.0.1:${port}`],
              protocols: version === '1.1' ? ['h1'] : ['h1', 'h2'],
              enable_full_duplex: true,
              automatic_https: { disable: true },
              tls_connection_policies: [
                { alpn: version === '1.1' ? ['http/1.1'] : ['h2', 'http/1.1'] },
              ],
              routes,
            },
          ]),
        ),
      },
    },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-caddy-'));
  config.storage.root = directory;
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const child = spawn(binary, ['run', '--config', file], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_DATA_HOME: directory,
      XDG_CONFIG_HOME: directory,
      APPDATA: directory,
      LOCALAPPDATA: directory,
    },
  });
  let log = '',
    spawnError;
  child.on('error', (e) => {
    spawnError = e;
  });
  for (const output of [child.stdout, child.stderr])
    output.on('data', (chunk) => {
      log = (log + chunk).slice(-4096);
    });
  t.after(async () => {
    if (process.env.JS2RAY_INTEROP_VERBOSE) process.stdout.write(log + '\n');
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(Error('Caddy cleanup timed out.'));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    // Only this explicitly created temporary directory is removed.
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw Error('Invalid temporary directory.');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  while (true) {
    if (spawnError || child.exitCode !== null)
      throw Error('Caddy startup failed: ' + (spawnError?.message ?? log));
    const ready = await new Promise((resolve) => {
      const socket = net.connect(upPort, '127.0.0.1');
      socket.on('error', () => resolve(false));
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
    });
    if (ready) break;
    if (Date.now() > deadline) throw Error('Caddy startup timeout: ' + log);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const network = (port, prefix, host) => ({
    type: 'xhttp',
    address: '127.0.0.1',
    port,
    option: { host, path: prefix, tls: { ca, serverName: 'js2ray.test' } },
  });
  return {
    child,
    version: lock.version,
    up: { network: network(upPort, upPrefix, 'up.test'), port: upPort },
    down: { network: network(downPort, downPrefix, 'down.test'), port: downPort },
  };
}
module.exports = { caddy };
