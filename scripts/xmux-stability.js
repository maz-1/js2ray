'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRuntimeManager } = require('..');
const { echo, readBytes } = require('../test/helpers');
const { write } = require('../runtime/streams');
const cert = fs.readFileSync('test/fixtures/tls/cert.pem', 'utf8');
const key = fs.readFileSync('test/fixtures/tls/key.pem', 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function bounded(operation, cleanup) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cleanup?.();
          reject(Error('XMUX operation timed out.'));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const minutes = Number(process.env.JS2RAY_STABILITY_MINUTES ?? 30);
  const rotationMs = Number(process.env.JS2RAY_ROTATION_MS ?? 60000);
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    !Number.isSafeInteger(rotationMs) ||
    rotationMs < 1000
  )
    throw Error('Invalid stability duration.');
  const result = {
    phase: 'P18',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    started: new Date().toISOString(),
    durationMinutes: minutes,
    formalAcceptance: minutes >= 30,
    concurrentSessions: 100,
    rotations: 0,
    churn: 0,
    iterations: 0,
    bytes: 0,
    peak: { rss: 0, heap: 0, clients: 0, sockets: 0, queueBytes: 0 },
    latency: { count: 0, totalMs: 0, maxMs: 0 },
    samples: [],
    passed: false,
  };
  result.sourceNormalization = 'UTF-8, CRLF to LF';
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) =>
      /^(?:index\.(?:js|mjs|d\.ts)|(?:cli|adapters|config|runtime|transports|protocols|reverse|dns|routing|geodata|core)\/.*\.js)$/.test(
        file,
      ),
    )
    .sort();
  result.sources = Object.fromEntries(
    files.map((file) => [file, sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))]),
  );
  result.sourceSha256 = sha(
    Object.entries(result.sources)
      .map(([file, digest]) => `${digest} ${file}\n`)
      .join(''),
  );
  result.harnessSha256 = sha(fs.readFileSync(__filename, 'utf8').replace(/\r\n/g, '\n'));
  const cleanups = [],
    managers = [],
    held = [],
    profiles = [],
    counters = new Map();
  const limits = { maxConnections: 256, maxPendingDials: 128, maxBufferBytes: 262144 };
  let stopped = false,
    interval,
    workers = [];
  const configDigest = crypto.createHash('sha256');
  function config(profile, server, credentials) {
    const value = {
      limits,
      [server ? 'inbounds' : 'outbounds']: [
        {
          tag: profile.name,
          protocol: 'vless',
          users: [{ id: credentials.id, encryption: 'none' }],
          networks: [
            {
              type: 'xhttp',
              address: '127.0.0.1',
              port: server ? 0 : profile.port,
              option: {
                path: credentials.path,
                mode: profile.mode,
                httpVersion: profile.httpVersion,
                scMaxEachPostBytes: 32768,
                xmux: {
                  maxConcurrency: '4-6',
                  cMaxReuseTimes: '8-12',
                  hMaxRequestTimes: '24-36',
                  hMaxReusableSecs: '2-4',
                  hKeepAlivePeriod: 1,
                },
                tls: server ? { cert, key } : { ca: cert, serverName: 'js2ray.test' },
              },
            },
          ],
        },
      ],
    };
    configDigest.update(JSON.stringify(value));
    return value;
  }
  async function exchange(stream, body, slow = false) {
    const began = performance.now();
    await bounded(
      (async () => {
        await write(stream, body);
        if (slow) await pause(200);
        assert.deepEqual(await readBytes(stream, body.length), body);
      })(),
      () => stream.destroy(),
    );
    const elapsed = performance.now() - began;
    result.iterations++;
    result.bytes += body.length;
    result.latency.count++;
    result.latency.totalMs += elapsed;
    result.latency.maxMs = Math.max(result.latency.maxMs, elapsed);
  }
  try {
    const target = await echo({ after: (fn) => cleanups.push(fn) });
    for (const httpVersion of ['1.1', '2'])
      for (const mode of ['packet-up', 'stream-up', 'stream-one']) {
        const profile = {
          name: `xhttp-${httpVersion}-${mode}`,
          httpVersion,
          mode,
          count: profiles.length < 4 ? 17 : 16,
          credentials: { id: crypto.randomUUID(), path: '/xmux-0' },
        };
        profile.server = createRuntimeManager(config(profile, true, profile.credentials));
        managers.push(profile.server);
        await profile.server.start();
        profile.port = profile.server.listenersInfo[0].address.port;
        profile.client = createRuntimeManager(config(profile, false, profile.credentials));
        managers.push(profile.client);
        await profile.client.start();
        profiles.push(profile);
        const streams = await Promise.all(
          Array.from({ length: profile.count }, () => profile.client.dial(target)),
        );
        for (const stream of streams) held.push({ stream, profile, slow: held.length % 10 === 0 });
      }
    result.profiles = profiles.map(({ name, count }) => ({ name, count }));
    assert.equal(held.length, 100);
    const started = performance.now(),
      deadline = started + minutes * 60000;
    const sample = () => {
      const memory = process.memoryUsage();
      let clients = 0,
        sockets = 0,
        queueBytes = 0;
      for (const [index, manager] of managers.entries())
        for (const generation of manager.metrics) {
          const metrics = generation.metrics;
          clients += metrics.xhttp.clients;
          sockets += metrics.xhttp.sockets;
          queueBytes +=
            metrics.transport.readableBytes +
            metrics.transport.writableBytes +
            metrics.transport.bufferedBytes;
          counters.set(`${index}:${generation.generation}`, metrics.xhttp);
        }
      for (const pair of held)
        queueBytes += pair.stream.readableLength + pair.stream.writableLength;
      for (const [name, value] of Object.entries({
        rss: memory.rss,
        heap: memory.heapUsed,
        clients,
        sockets,
        queueBytes,
      }))
        result.peak[name] = Math.max(result.peak[name], value);
      assert.ok(memory.rss < 1024 ** 3, 'RSS exceeded 1 GiB.');
      assert.ok(queueBytes < 100 * limits.maxBufferBytes * 8, 'Queues exceeded bound.');
      if (
        !result.samples.length ||
        performance.now() - started - result.samples.at(-1).elapsedMs >= 59000
      ) {
        const record = {
          elapsedMs: Math.round(performance.now() - started),
          rss: memory.rss,
          heap: memory.heapUsed,
          clients,
          sockets,
          queueBytes,
          rotations: result.rotations,
          churn: result.churn,
        };
        result.samples.push(record);
        process.stdout.write(JSON.stringify(record) + '\n');
      }
    };
    let samplingError;
    interval = setInterval(() => {
      try {
        sample();
      } catch (cause) {
        samplingError = cause;
        stopped = true;
        held.forEach((pair) => pair.stream.destroy());
      }
    }, 1000);
    sample();
    workers = held.map(async (pair, index) => {
      const body = Buffer.alloc(4096, index);
      let round = 0;
      while (!stopped && performance.now() < deadline) {
        body.writeUInt32BE(round++);
        await exchange(pair.stream, body, pair.slow);
        await pause(120);
      }
    });
    workers.push(
      (async () => {
        let nextRotation = started + rotationMs;
        while (!stopped && performance.now() < deadline) {
          for (const profile of profiles) {
            if (stopped || performance.now() >= deadline) break;
            const stream = await bounded(profile.client.dial(target));
            try {
              await exchange(stream, crypto.randomBytes(4096));
              result.churn++;
            } finally {
              stream.destroy();
            }
          }
          if (performance.now() >= nextRotation && performance.now() < deadline) {
            for (const profile of profiles) {
              const next = { id: crypto.randomUUID(), path: '/xmux-' + (result.rotations + 1) },
                budget = { drainTimeoutMs: Math.ceil(minutes * 60000 + 30000) };
              (await profile.server.rotate(config(profile, true, next), budget)).drained.catch(
                () => {},
              );
              (
                await profile.client.rotate(config(profile, false, next), {
                  ...budget,
                  ready: async (candidate) => {
                    const stream = await candidate.dial(target);
                    try {
                      await exchange(stream, Buffer.from('readiness'));
                    } finally {
                      stream.destroy();
                    }
                  },
                })
              ).drained.catch(() => {});
              profile.credentials = next;
            }
            result.rotations++;
            nextRotation += rotationMs;
          }
          await pause(1000);
        }
      })(),
    );
    await Promise.all(workers);
    if (samplingError) throw samplingError;
    result.elapsedMs = Math.round(performance.now() - started);
    sample();
    result.poolCounters = Object.fromEntries(
      ['created', 'retired', 'requests', 'pings', 'failures'].map((field) => [
        field,
        [...counters.values()].reduce((n, value) => n + value[field], 0),
      ]),
    );
    assert.ok(result.poolCounters.retired > 0);
    if (minutes >= 1) assert.ok(result.rotations >= Math.floor((minutes * 60000) / rotationMs) - 1);
    result.configSha256 = configDigest.digest('hex');
    result.passed = result.elapsedMs >= minutes * 60000;
  } catch (cause) {
    result.error = { code: cause.code, message: cause.message };
    throw cause;
  } finally {
    stopped = true;
    clearInterval(interval);
    held.forEach((pair) => pair.stream.destroy());
    await Promise.all(managers.map((manager) => manager.close()));
    await Promise.allSettled(workers);
    for (const cleanup of cleanups.reverse()) await cleanup();
    result.closed = managers.map((manager) => manager.stats);
    result.passed &&= result.closed.every(
      (stats) =>
        stats.state === 'closed' &&
        stats.generations === 0 &&
        stats.connections === 0 &&
        stats.pendingDials === 0 &&
        stats.listeners === 0,
    );
    result.finished = new Date().toISOString();
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/xmux-stability.json', JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({
        passed: result.passed,
        formalAcceptance: result.formalAcceptance,
        elapsedMs: result.elapsedMs,
        rotations: result.rotations,
        churn: result.churn,
      }) + '\n',
    );
  }
}
main().catch((cause) => {
  process.stderr.write(`${cause.code ?? 'ERR_STABILITY'}: ${cause.message}\n`);
  process.exitCode = 1;
});
