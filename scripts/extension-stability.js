'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { createRuntimeManager, createWebSocket } = require('..');
const { echo, listen, readBytes } = require('../test/helpers');
const { id } = require('../test/fixtures/reverse');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, failed) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          failed();
          reject(Error('Extension traffic deadline exceeded.'));
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const minutes = Number(process.env.JS2RAY_STABILITY_MINUTES ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0) throw Error('Invalid duration.');
  const cleanups = [],
    managers = [],
    tcp = [],
    udp = [],
    websockets = [];
  const result = {
    started: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    machine: {
      cpu: os.cpus()[0].model,
      cores: os.availableParallelism(),
      memoryBytes: os.totalmem(),
    },
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    durationMinutes: minutes,
    concurrentSessions: 100,
    topology:
      '40 Mux TCP + 30 UDP (SOCKS/VMess/Mux) + 30 application WS/WSS; both endpoints rotate credentials every 60 seconds',
    rounds: { tcp: 0, udp: 0, websocket: 0 },
    bytes: 0,
    rotations: 0,
    peak: { rss: 0, heap: 0, applicationQueueBytes: 0, muxQueueBytes: 0, generations: 0 },
    samples: [],
    passed: false,
  };
  const files = ['index.js', 'index.mjs'];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.js')) files.push(file);
    }
  };
  for (const directory of [
    'runtime',
    'protocols',
    'reverse',
    'transports',
    'core',
    'config',
    'dns',
    'geodata',
    'routing',
    'adapters',
  ])
    walk(directory);
  result.sources = Object.fromEntries(
    files.map((file) => [
      file,
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]),
  );
  let stopped = false,
    interval;
  try {
    const target = await echo({ after: (fn) => cleanups.push(fn) });
    const datagram = dgram.createSocket('udp4');
    datagram.on('message', (data, peer) => datagram.send(data, peer.port, peer.address));
    datagram.bind(0, '127.0.0.1');
    await once(datagram, 'listening');
    datagram.setRecvBufferSize(2 * 1024 * 1024);
    cleanups.push(() => new Promise((resolve) => datagram.close(resolve)));
    const cert = fs.readFileSync(require.resolve('../test/fixtures/tls/cert.pem'), 'utf8'),
      key = fs.readFileSync(require.resolve('../test/fixtures/tls/key.pem'), 'utf8');
    const origins = [];
    for (const secure of [false, true]) {
      const server = secure ? https.createServer({ cert, key }) : http.createServer();
      const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
      wss.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
      const port = await listen(server);
      origins.push(`${secure ? 'wss' : 'ws'}://127.0.0.1:${port}`);
      cleanups.push(async () => {
        for (const ws of wss.clients) ws.terminate();
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve) => server.close(resolve));
      });
    }
    const limits = { maxConnections: 2048, maxBufferBytes: 8 * 1024 * 1024 };
    const serverConfig = (userId, password) => ({
      limits,
      inbounds: [
        { tag: 'vless', protocol: 'vless', users: [{ id: userId }], networks: [{ port: 0 }] },
        { tag: 'vmess', protocol: 'vmess', users: [{ id: userId }], networks: [{ port: 0 }] },
        {
          tag: 'socks',
          protocol: 'socks',
          udp: true,
          users: [{ user: 'synthetic', pass: password }],
          networks: [{ port: 0 }],
        },
      ],
    });
    const peer = createRuntimeManager(serverConfig(id, 'initial-test-password'));
    managers.push(peer);
    await peer.start();
    const ports = Object.fromEntries(
      peer.listenersInfo.map((entry) => [entry.tag, entry.address.port]),
    );
    const clientConfig = (userId, password) => ({
      limits,
      outbounds: [
        {
          tag: 'mux',
          protocol: 'vless',
          mux: { enabled: true, concurrency: 128 },
          users: [{ id: userId, encryption: 'none' }],
          networks: [{ address: '127.0.0.1', port: ports.vless }],
        },
        {
          tag: 'vmess',
          protocol: 'vmess',
          users: [{ id: userId, security: 'aes-128-gcm' }],
          networks: [{ address: '127.0.0.1', port: ports.vmess }],
        },
        {
          tag: 'socks',
          protocol: 'socks',
          users: [{ user: 'synthetic', pass: password }],
          networks: [{ address: '127.0.0.1', port: ports.socks }],
        },
      ],
    });
    const manager = createRuntimeManager(clientConfig(id, 'initial-test-password'));
    managers.push(manager);
    await manager.start();
    result.configSha256 = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          serverConfig(id, 'initial-test-password'),
          clientConfig(id, 'initial-test-password'),
        ]),
      )
      .digest('hex');
    for (let n = 0; n < 40; n++) tcp.push(await manager.dial(target));
    for (let n = 0; n < 30; n++)
      udp.push(
        await manager.openDatagram({
          host: '127.0.0.1',
          port: datagram.address().port,
          outboundTag: ['mux', 'vmess', 'socks'][n % 3],
        }),
      );
    for (let n = 0; n < 30; n++) {
      const ws = createWebSocket(manager, origins[n % 2], {
        targetTls: { ca: cert, serverName: 'js2ray.test' },
      });
      await once(ws, 'open');
      websockets.push(ws);
    }
    const started = performance.now(),
      deadline = started + minutes * 60000;
    const sample = () => {
      const memory = process.memoryUsage(),
        generations = managers.reduce((sum, item) => sum + item.stats.generations, 0);
      const applicationQueueBytes =
        tcp.reduce((sum, stream) => sum + stream.readableLength + stream.writableLength, 0) +
        udp.reduce((sum, session) => sum + session.bytes, 0) +
        websockets.reduce((sum, ws) => sum + ws.bufferedAmount, 0);
      const muxQueueBytes = managers
        .flatMap((item) => item.metrics)
        .reduce((sum, item) => sum + item.metrics.mux.queuedBytes, 0);
      for (const [key, value] of Object.entries({
        rss: memory.rss,
        heap: memory.heapUsed,
        applicationQueueBytes,
        muxQueueBytes,
        generations,
      }))
        result.peak[key] = Math.max(result.peak[key], value);
      if (
        !result.samples.length ||
        performance.now() - started - result.samples.at(-1).elapsedMs >= 59000
      ) {
        const record = {
          elapsedMs: Math.round(performance.now() - started),
          rss: memory.rss,
          heap: memory.heapUsed,
          applicationQueueBytes,
          muxQueueBytes,
          generations,
          rotations: result.rotations,
        };
        result.samples.push(record);
        process.stdout.write(JSON.stringify(record) + '\n');
      }
    };
    interval = setInterval(sample, 1000);
    sample();
    const work = async (kind, index, operation) => {
      const payload = Buffer.alloc(kind === 'udp' ? 512 : 4096, index);
      let round = 0;
      while (!stopped && performance.now() < deadline) {
        payload.writeUInt32BE(round++);
        const received = await operation(payload);
        if (!received.equals(payload)) throw Error('Extension payload mismatch.');
        result.rounds[kind]++;
        result.bytes += payload.length;
        await sleep(index % 10 === 0 ? 200 : 100);
      }
    };
    const jobs = [
      ...tcp.map((stream, index) =>
        work('tcp', index, async (data) => {
          stream.write(data);
          return within(readBytes(stream, data.length), () => stream.destroy());
        }),
      ),
      ...udp.map((session, index) =>
        work('udp', index, async (data) => {
          await session.send(data);
          return (await within(session.next(), () => session.destroy())).value.data;
        }),
      ),
      ...websockets.map((ws, index) =>
        work('websocket', index, async (data) => {
          const received = once(ws, 'message');
          ws.send(data);
          return (await within(received, () => ws.terminate()))[0];
        }),
      ),
      (async () => {
        let next = started + 60000;
        while (!stopped && performance.now() < deadline) {
          await sleep(1000);
          if (performance.now() < next || performance.now() >= deadline) continue;
          const userId = crypto.randomUUID(),
            password = crypto.randomBytes(16).toString('hex');
          const budgets = { drainTimeoutMs: Math.ceil(minutes * 60000 + 20000) };
          const serverRotation = await peer.rotate(serverConfig(userId, password), budgets);
          const clientRotation = await manager.rotate(clientConfig(userId, password), {
            ...budgets,
            ready: async (candidate, signal) => {
              const probe = await candidate.dial({ ...target, signal });
              try {
                probe.write('probe');
                if ((await readBytes(probe, 5)).toString() !== 'probe')
                  throw Error('Readiness payload mismatch.');
              } finally {
                probe.destroy();
              }
            },
          });
          serverRotation.drained.catch(() => {});
          clientRotation.drained.catch(() => {});
          result.rotations++;
          next += 60000;
        }
      })(),
    ];
    await Promise.all(jobs).catch((error) => {
      stopped = true;
      for (const stream of tcp) stream.destroy();
      for (const session of udp) session.destroy();
      for (const ws of websockets) ws.terminate();
      throw error;
    });
    result.elapsedMs = Math.round(performance.now() - started);
    result.passed = result.elapsedMs >= minutes * 60000;
    sample();
  } catch (error) {
    result.error = { code: error.code, message: error.message };
    throw error;
  } finally {
    stopped = true;
    clearInterval(interval);
    for (const stream of tcp) stream.destroy();
    for (const session of udp) session.destroy();
    for (const ws of websockets) ws.terminate();
    await Promise.all(managers.map((manager) => manager.close()));
    for (const cleanup of cleanups.reverse()) await cleanup();
    result.closed = managers.map((manager) => manager.stats);
    result.finished = new Date().toISOString();
    result.passed &&= result.closed.every(
      (stats) =>
        stats.generations === 0 &&
        stats.connections === 0 &&
        stats.pendingDials === 0 &&
        stats.listeners === 0,
    );
    if (!result.passed) process.exitCode = 1;
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(
      'test-results/extension-stability.json',
      JSON.stringify(result, null, 2) + '\n',
    );
    process.stdout.write(
      JSON.stringify({
        passed: result.passed,
        elapsedMs: result.elapsedMs,
        rotations: result.rotations,
        peak: result.peak,
      }) + '\n',
    );
  }
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? 'ERR_STABILITY'}: ${error.message}\n`);
  process.exitCode = 1;
});
