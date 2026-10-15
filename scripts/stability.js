'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRuntime } = require('..');
const { echo, readBytes } = require('../test/helpers');
const { id, portalConfig, bridgeConfig, waitFor } = require('../test/fixtures/reverse');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const minutes = Number(process.env.JS2RAY_STABILITY_MINUTES ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0) throw Error('Invalid duration.');
  const cleanups = [],
    runtimes = [],
    streams = [];
  const t = {
    after(fn) {
      cleanups.push(fn);
    },
  };
  const limits = { maxBufferBytes: 8 * 1024 * 1024, maxConnections: 1024 };
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
    durationMinutes: minutes,
    concurrentSessions: 100,
    topology: '50 VLESS Mux TCP + 50 reverse TCP, 10 slow consumers, 4096 bytes each iteration',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    iterations: 0,
    bytes: 0,
    peak: { rss: 0, heap: 0, queue: 0, connections: 0 },
    samples: [],
    passed: false,
  };
  const sourceFiles = ['index.js', 'index.mjs'];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(path.resolve(__dirname, '..', directory), {
      withFileTypes: true,
    })) {
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.js')) sourceFiles.push(file);
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
    sourceFiles.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.resolve(__dirname, '..', file)))
        .digest('hex'),
    ]),
  );
  let interval;
  try {
    const destination = await echo(t);
    const inbound = createRuntime({
      limits,
      inbounds: [{ protocol: 'vless', users: [{ id }], networks: [{ port: 0 }] }],
    });
    runtimes.push(inbound);
    await inbound.start();
    const direct = createRuntime({
      limits,
      outbounds: [
        {
          protocol: 'vless',
          networks: [{ address: '127.0.0.1', port: inbound.listenersInfo[0].address.port }],
          users: [{ id, encryption: 'none' }],
          mux: { enabled: true, concurrency: 64 },
        },
      ],
    });
    runtimes.push(direct);
    await direct.start();
    const portalSettings = { ...portalConfig(0), limits };
    const portal = createRuntime(portalSettings);
    runtimes.push(portal);
    await portal.start();
    const bridgeSettings = {
      ...bridgeConfig(portal.listenersInfo[0].address.port, destination),
      limits,
    };
    const bridge = createRuntime(bridgeSettings);
    runtimes.push(bridge);
    await bridge.start();
    await waitFor(() => portal.stats.reverse[0].transports > 0);
    result.configSha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify([limits, portalSettings, bridgeSettings]))
      .digest('hex');
    await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const stream = await (i < 50
          ? direct.dial(destination)
          : portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' }));
        streams[i] = stream;
      }),
    );
    const started = performance.now(),
      deadline = started + minutes * 60000;
    let controlFailure;
    const sample = () => {
      const memory = process.memoryUsage();
      let queue = 0;
      for (const stream of streams) queue += stream.readableLength + stream.writableLength;
      const connections = runtimes.reduce((sum, runtime) => sum + runtime.stats.connections, 0);
      const reverseStats = bridge.stats.reverse[0];
      if (performance.now() - started > 10000 && reverseStats.sessions < 50 + reverseStats.active)
        controlFailure = Error('Reverse control session was lost during stability test.');
      result.peak.rss = Math.max(result.peak.rss, memory.rss);
      result.peak.heap = Math.max(result.peak.heap, memory.heapUsed);
      result.peak.queue = Math.max(result.peak.queue, queue);
      result.peak.connections = Math.max(result.peak.connections, connections);
      if (
        !result.samples.length ||
        performance.now() - started - result.samples.at(-1).elapsedMs >= 59000
      ) {
        const record = {
          elapsedMs: Math.round(performance.now() - started),
          rss: memory.rss,
          heap: memory.heapUsed,
          queue,
          connections,
          reverse: bridge.stats.reverse,
        };
        result.samples.push(record);
        process.stdout.write(JSON.stringify(record) + '\n');
      }
    };
    interval = setInterval(sample, 1000);
    sample();
    await Promise.all(
      streams.map(async (stream, i) => {
        const payload = Buffer.alloc(4096, i);
        let round = 0;
        while (performance.now() < deadline) {
          if (controlFailure) throw controlFailure;
          if (fs.existsSync(path.resolve(__dirname, '../test-results/stop-stability')))
            throw Error('Stability run explicitly stopped.');
          payload.writeUInt32BE(round++);
          stream.write(payload);
          if (i % 10 === 0) await sleep(200);
          const received = await new (require('../runtime/reader').StreamReader)(stream, {
            maxBytes: payload.length,
            timeoutMs: 10000,
          }).read(payload.length);
          if (!received.equals(payload)) throw Error('Stability payload mismatch.');
          result.iterations++;
          result.bytes += payload.length;
          await sleep(i % 10 === 0 ? 5 : 100);
        }
      }),
    );
    result.elapsedMs = Math.round(performance.now() - started);
    result.passed = result.elapsedMs >= minutes * 60000;
    sample();
  } catch (error) {
    result.error = { code: error.code, message: error.message };
    throw error;
  } finally {
    clearInterval(interval);
    for (const stream of streams) stream.destroy();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    for (const cleanup of cleanups.reverse()) await cleanup();
    result.closed = runtimes.map((runtime) => runtime.stats);
    result.finished = new Date().toISOString();
    result.passed &&= result.closed.every(
      (stats) =>
        stats.state === 'closed' &&
        stats.connections === 0 &&
        stats.pendingDials === 0 &&
        stats.listeners === 0 &&
        stats.reverse.every((item) => item.transports === 0),
    );
    fs.mkdirSync(path.resolve(__dirname, '../test-results'), { recursive: true });
    const filename = path.resolve(__dirname, '../test-results/stability.json');
    fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({
        passed: result.passed,
        filename,
        elapsedMs: result.elapsedMs,
        peak: result.peak,
      }) + '\n',
    );
  }
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? 'ERR_STABILITY'}: ${error.message}\n`);
  process.exitCode = 1;
});
