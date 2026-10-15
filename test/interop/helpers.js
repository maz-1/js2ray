'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const { listen } = require('../helpers');
const references = require('../fixtures/reference-cores.json');

async function freePort(udp = false) {
  if (udp) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const socket = require('node:dgram').createSocket('udp4');
      const server = net.createServer();
      socket.on('error', () => {});
      server.on('error', () => {});
      const candidate = crypto.randomInt(10000, 49152);
      let success = false;
      try {
        server.listen(candidate, '127.0.0.1');
        await once(server, 'listening');
        socket.bind(candidate, '127.0.0.1');
        await once(socket, 'listening');
        success = true;
      } catch {
        /* Windows can reserve different ranges for TCP and UDP. */
      }
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => {
        try {
          socket.close(resolve);
        } catch {
          resolve();
        }
      });
      if (success) return candidate;
    }
    throw new Error('Cannot reserve a shared TCP/UDP test port.');
  }
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function runCore(t, kind, config, port) {
  const executable =
    process.env[`JS2RAY_${kind.toUpperCase()}_BIN`] ??
    path.resolve(__dirname, `../../.test-tools/${kind}.exe`);
  if (!fs.existsSync(executable))
    throw new Error(
      `Missing required ${kind} reference core. Set JS2RAY_${kind.toUpperCase()}_BIN. Interoperability checks cannot be skipped.`,
    );
  const sha = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (sha !== references[kind].sha256)
    throw new Error(
      `Reference core checksum mismatch: ${kind}. Update the explicit platform lock before testing a new build.`,
    );
  const version = spawnSync(executable, ['version'], { encoding: 'utf8' });
  if (version.error || !version.stdout.includes(references[kind].version))
    throw new Error(`Reference core version check failed: ${kind}.`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-interop-'));
  const filename = path.join(directory, 'config.json');
  fs.writeFileSync(filename, JSON.stringify(config));
  const child = spawn(executable, ['run', '-config', filename], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(kind === 'xray' ? { 'xray.cone.disabled': 'true' } : {}) },
  });
  let log = '';
  let spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (data) => {
    log = (log + data).slice(-8192);
  });
  child.stderr.on('data', (data) => {
    log = (log + data).slice(-8192);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('js2ray-interop-')
    )
      throw new Error('Unexpected test cleanup path.');
    fs.rmSync(directory, { recursive: true, force: true });
    if (process.env.JS2RAY_INTEROP_VERBOSE && log.trim()) t.diagnostic(log.trim());
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Reference core exited: ${log}`);
    const alive = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (alive) return child;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Reference core did not listen: ${log}`);
}
module.exports = { runCore, freePort, references };
