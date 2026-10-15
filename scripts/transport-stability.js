'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { createRuntimeManager } = require('..');
const { echo, listen, readBytes } = require('../test/helpers');
const fixture = require('../test/fixtures/vision');
const reality = require('../test/fixtures/reality');
const { write } = require('../runtime/streams');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(operation, cleanup) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          cleanup?.();
          reject(Error('Transport stability operation timed out.'));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const minutes = Number(process.env.JS2RAY_STABILITY_MINUTES ?? 30),
    rotationMs = Number(process.env.JS2RAY_ROTATION_MS ?? 60000);
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    !Number.isSafeInteger(rotationMs) ||
    rotationMs < 1000
  )
    throw Error('Invalid stability duration.');
  const cleanups = [],
    t = { after: (fn) => cleanups.push(fn) },
    managers = [],
    held = [];
  const profiles = [];
  for (const httpVersion of ['1.1', '2'])
    for (const mode of ['packet-up', 'stream-up', 'stream-one'])
      profiles.push({
        name: `xhttp-${httpVersion}-${mode}`,
        kind: 'xhttp',
        httpVersion,
        mode,
        count: 5,
      });
  profiles.push(
    { name: 'vision-tls', kind: 'tls', vision: true, count: 30 },
    { name: 'reality-vision', kind: 'reality', vision: true, count: 30 },
    { name: 'reality-empty', kind: 'reality', count: 10 },
  );
  const result = {
    phase: 'P17',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    started: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    durationMinutes: minutes,
    formalAcceptance: minutes >= 30,
    concurrentSessions: 100,
    profiles: profiles.map(({ name, count }) => ({ name, count })),
    machine: {
      cpu: os.cpus()[0].model,
      cores: os.availableParallelism(),
      memoryBytes: os.totalmem(),
    },
    rotations: 0,
    coverFaults: 0,
    iterations: 0,
    bytes: 0,
    latency: { count: 0, totalMs: 0, maxMs: 0, histogram: Array(8).fill(0) },
    peak: {
      rss: 0,
      heap: 0,
      applicationQueueBytes: 0,
      transportQueueBytes: 0,
      muxQueueBytes: 0,
      pendingInbound: 0,
      generations: 0,
    },
    samples: [],
    passed: false,
  };
  const canonical = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const gitFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) =>
      /^(?:index\.(?:js|mjs|d\.ts)|(?:cli|adapters|config|runtime|transports|protocols|reverse|dns|routing|geodata|core)\/.*\.js)$/.test(
        file,
      ),
    )
    .sort();
  result.sourceNormalization = 'UTF-8, CRLF to LF';
  result.sources = Object.fromEntries(
    gitFiles.map((file) => [
      file,
      crypto.createHash('sha256').update(canonical(file)).digest('hex'),
    ]),
  );
  Object.assign(result, require('./acceptance-evidence').sourceEvidence());
  result.harnessSha256 = crypto
    .createHash('sha256')
    .update(canonical('scripts/transport-stability.js'))
    .digest('hex');
  result.latency.boundsMs = [1, 5, 10, 50, 100, 500, 1000, null];
  const configDigest = crypto.createHash('sha256');
  let interval,
    stopped = false;
  try {
    const target = await echo(t),
      tls13 = await fixture.tlsEcho(t, 'TLSv1.3'),
      tls12 = await fixture.tlsEcho(t, 'TLSv1.2');
    const backend = await reality.cover(t),
      gates = [];
    for (let n = 0; n < 2; n++) {
      const sockets = new Set(),
        gate = { enabled: true };
      const server = net.createServer({ allowHalfOpen: true }, (raw) => {
        sockets.add(raw);
        raw.on('error', () => {});
        raw.once('close', () => sockets.delete(raw));
        if (!gate.enabled) return raw.destroy();
        const remote = net.connect({ host: '127.0.0.1', port: backend.port, allowHalfOpen: true });
        sockets.add(remote);
        remote.on('error', () => raw.destroy());
        remote.once('close', () => {
          sockets.delete(remote);
          raw.destroy();
        });
        raw.once('close', () => remote.destroy());
        raw.pipe(remote).pipe(raw);
      });
      gate.port = await listen(server);
      gates.push(gate);
      t.after(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise((resolve) => server.close(resolve));
      });
    }
    function bound(profile, server, port, credentials) {
      const user = {
        id: credentials.id,
        encryption: 'none',
        ...(profile.vision ? { flow: fixture.flow } : {}),
      };
      let option,
        type = 'tcp';
      if (profile.kind === 'xhttp') {
        type = 'xhttp';
        option = {
          mode: profile.mode,
          httpVersion: profile.httpVersion,
          path: `/stability-${credentials.path}`,
          scMaxEachPostBytes: 8192,
          ...(server
            ? { tls: { cert: fixture.cert, key: fixture.key } }
            : { tls: { ca: fixture.cert, serverName: 'js2ray.test' } }),
        };
      } else if (profile.kind === 'tls')
        option = server
          ? { tls: { cert: fixture.cert, key: fixture.key } }
          : { tls: { ca: fixture.cert, serverName: 'js2ray.test' } };
      else
        option = {
          reality: server
            ? {
                ...reality.server,
                privateKey: credentials.privateKey,
                shortIds: [credentials.shortId],
                dest: `127.0.0.1:${gates[credentials.gate].port}`,
              }
            : { ...reality.client, publicKey: credentials.publicKey, shortId: credentials.shortId },
        };
      return {
        tag: 'entry',
        protocol: 'vless',
        users: [user],
        networks: [{ type, address: '127.0.0.1', port, option }],
      };
    }
    function credentials(round) {
      const pair = crypto.generateKeyPairSync('x25519');
      return {
        id: crypto.randomUUID(),
        path: crypto.randomBytes(8).toString('hex'),
        privateKey: pair.privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .subarray(-32)
          .toString('base64url'),
        publicKey: pair.publicKey
          .export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('base64url'),
        shortId: crypto.randomBytes(8).toString('hex'),
        gate: round % 2,
      };
    }
    const limits = { maxBufferBytes: 262144, handshakeTimeoutMs: 10000, maxConnections: 256 };
    const config = (profile, server, port, credentials) => {
      const value = {
        limits,
        [server ? 'inbounds' : 'outbounds']: [bound(profile, server, port, credentials)],
      };
      configDigest.update(JSON.stringify(value));
      return value;
    };
    async function connection(runtime, profile, version) {
      const destination = version === 'TLSv1.3' ? tls13 : version === 'TLSv1.2' ? tls12 : target;
      const tunnel = await runtime.dial(destination);
      let stream = tunnel;
      if (version) {
        stream = tls.connect({
          socket: tunnel,
          ca: fixture.cert,
          servername: 'js2ray.test',
          minVersion: version,
          maxVersion: version,
          allowHalfOpen: true,
        });
        stream.on('error', () => {});
        try {
          await within(once(stream, 'secureConnect'), () => {
            stream.destroy();
            tunnel.destroy();
          });
        } catch (error) {
          stream.destroy();
          tunnel.destroy();
          throw error;
        }
      }
      return { stream, tunnel };
    }
    async function probe(runtime, profile) {
      const pair = await connection(runtime, profile, profile.vision ? 'TLSv1.3' : undefined);
      try {
        await write(pair.stream, Buffer.from('probe'));
        assert.equal(
          (await within(readBytes(pair.stream, 5), () => pair.stream.destroy())).toString(),
          'probe',
        );
      } finally {
        pair.stream.destroy();
        pair.tunnel.destroy();
      }
    }
    for (const profile of profiles) {
      profile.credentials = credentials(0);
      profile.server = createRuntimeManager(config(profile, true, 0, profile.credentials));
      managers.push(profile.server);
      await profile.server.start();
      profile.port = profile.server.listenersInfo[0].address.port;
      profile.client = createRuntimeManager(
        config(profile, false, profile.port, profile.credentials),
      );
      managers.push(profile.client);
      await profile.client.start();
      for (let index = 0; index < profile.count; index++) {
        const version = profile.vision
          ? index < 20
            ? 'TLSv1.3'
            : index < 25
              ? 'TLSv1.2'
              : undefined
          : undefined;
        const pair = await connection(profile.client, profile, version);
        held.push({ ...pair, profile: profile.name, version, slow: held.length % 10 === 0 });
      }
    }
    assert.equal(held.length, 100);
    result.initialDirect = profiles
      .filter((profile) => profile.vision)
      .map((profile) => ({
        profile: profile.name,
        clientRead: profile.client.metrics.reduce((n, g) => n + g.metrics.visionReadSwitches, 0),
        serverRead: profile.server.metrics.reduce((n, g) => n + g.metrics.visionReadSwitches, 0),
      }));
    // One exact application roundtrip drives both direction switches.
    await Promise.all(
      held.map(async (pair) => {
        await write(pair.stream, Buffer.from('initial'));
        assert.equal((await readBytes(pair.stream, 7)).toString(), 'initial');
      }),
    );
    result.initialDirect = profiles
      .filter((profile) => profile.vision)
      .map((profile) => {
        const measure = (manager) =>
          manager.metrics.reduce(
            (total, g) => ({
              read: total.read + g.metrics.visionReadSwitches,
              write: total.write + g.metrics.visionWriteSwitches,
            }),
            { read: 0, write: 0 },
          );
        const client = measure(profile.client),
          server = measure(profile.server);
        assert.deepEqual(client, { read: 20, write: 20 });
        assert.deepEqual(server, { read: 20, write: 20 });
        return { profile: profile.name, client, server };
      });
    const started = performance.now(),
      deadline = started + minutes * 60000;
    let nextRotation = started + rotationMs;
    const sample = () => {
      const memory = process.memoryUsage();
      let transport = 0,
        mux = 0,
        pending = 0,
        generations = 0;
      for (const manager of managers) {
        generations += manager.stats.generations;
        for (const generation of manager.metrics) {
          const metrics = generation.metrics;
          transport +=
            metrics.transport.readableBytes +
            metrics.transport.writableBytes +
            metrics.transport.bufferedBytes;
          mux += metrics.mux.queuedBytes;
          pending += metrics.inbound.pending;
        }
      }
      const application = held.reduce(
        (n, pair) => n + pair.stream.readableLength + pair.stream.writableLength,
        0,
      );
      for (const [key, value] of Object.entries({
        rss: memory.rss,
        heap: memory.heapUsed,
        applicationQueueBytes: application,
        transportQueueBytes: transport,
        muxQueueBytes: mux,
        pendingInbound: pending,
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
          applicationQueueBytes: application,
          transportQueueBytes: transport,
          pendingInbound: pending,
          generations,
          rotations: result.rotations,
          coverFaults: result.coverFaults,
        };
        result.samples.push(record);
        process.stdout.write(JSON.stringify(record) + '\n');
      }
      assert.ok(
        transport < 100 * limits.maxBufferBytes * 8,
        'Transport queues exceeded the aggregate bound.',
      );
      assert.ok(memory.rss < 1024 * 1024 * 1024, 'RSS exceeded 1 GiB.');
    };
    let samplingError;
    interval = setInterval(() => {
      try {
        sample();
      } catch (error) {
        samplingError = error;
        stopped = true;
        for (const pair of held) pair.stream.destroy();
      }
    }, 1000);
    sample();
    const workers = held.map(async (pair, index) => {
      try {
        const payload = Buffer.alloc(4096, index);
        let round = 0;
        while (!stopped && performance.now() < deadline) {
          payload.writeUInt32BE(round++);
          const began = performance.now();
          await write(pair.stream, payload);
          if (pair.slow) await sleep(200);
          const received = await within(readBytes(pair.stream, payload.length), () =>
            pair.stream.destroy(),
          );
          assert.deepEqual(received, payload);
          const ms = performance.now() - began;
          result.latency.count++;
          result.latency.totalMs += ms;
          result.latency.maxMs = Math.max(result.latency.maxMs, ms);
          const limits = [1, 5, 10, 50, 100, 500, 1000, Infinity];
          result.latency.histogram[limits.findIndex((limit) => ms <= limit)]++;
          result.iterations++;
          result.bytes += payload.length;
          await sleep(120);
        }
      } catch (error) {
        result.failedWorker ??= {
          profile: pair.profile,
          index,
          version: pair.version,
          slow: pair.slow,
          elapsedMs: Math.round(performance.now() - started),
          chain: [error.code, error.cause?.code, error.cause?.cause?.code],
        };
        throw error;
      }
    });
    const rotate = (async () => {
      while (!stopped && performance.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, nextRotation - performance.now())));
        if (performance.now() < nextRotation || performance.now() >= deadline) continue;
        for (const gate of gates) gate.enabled = false;
        try {
          await assert.rejects(
            probe(
              profiles.find((profile) => profile.kind === 'reality').client,
              profiles.find((profile) => profile.kind === 'reality'),
            ),
          );
          result.coverFaults++;
        } finally {
          for (const gate of gates) gate.enabled = true;
        }
        for (const profile of profiles) {
          result.lastOperation = {
            profile: profile.name,
            round: result.rotations + 1,
            stage: 'server rotation',
          };
          const next = credentials(result.rotations + 1),
            budget = { drainTimeoutMs: Math.ceil(minutes * 60000 + 30000) };
          const serverRotation = await profile.server.rotate(
            config(profile, true, 0, next),
            budget,
          );
          serverRotation.drained.catch(() => {});
          result.lastOperation.stage = 'client readiness and rotation';
          const clientRotation = await profile.client.rotate(
            config(profile, false, profile.port, next),
            { ...budget, ready: (candidate) => probe(candidate, profile) },
          );
          clientRotation.drained.catch(() => {});
          profile.credentials = next;
        }
        delete result.lastOperation;
        result.rotations++;
        (result.rotationStates ??= []).push({
          round: result.rotations,
          elapsedMs: Math.round(performance.now() - started),
          profiles: profiles.map((profile) => ({
            name: profile.name,
            server: profile.server.metrics.map((g) => ({
              generation: g.generation,
              retiring: g.retiring,
              inbound: g.metrics.inbound,
            })),
            client: profile.client.stats,
          })),
        });
        nextRotation += rotationMs;
      }
    })();
    await Promise.all([...workers, rotate]).catch((error) => {
      stopped = true;
      for (const pair of held) {
        pair.stream.destroy();
        pair.tunnel.destroy();
      }
      throw error;
    });
    if (samplingError) throw samplingError;
    result.elapsedMs = Math.round(performance.now() - started);
    sample();
    if (minutes >= 1) assert.ok(result.rotations >= Math.floor((minutes * 60000) / rotationMs) - 1);
    assert.equal(result.coverFaults, result.rotations);
    result.configSha256 = configDigest.digest('hex');
    result.finalMetrics = profiles.map((profile) => ({
      name: profile.name,
      client: profile.client.metrics,
      server: profile.server.metrics,
    }));
    for (const profile of result.finalMetrics)
      for (const side of ['client', 'server'])
        for (const generation of profile[side]) {
          assert.equal(generation.metrics.inbound.pending, 0);
          assert.equal(generation.metrics.mux.queuedBytes, 0);
        }
    result.passed = result.elapsedMs >= minutes * 60000;
  } catch (error) {
    result.error = { code: error.code ?? 'ERR_STABILITY', message: error.message };
    throw error;
  } finally {
    stopped = true;
    clearInterval(interval);
    for (const pair of held) {
      pair.stream.destroy();
      pair.tunnel.destroy();
    }
    await Promise.all(managers.map((manager) => manager.close()));
    for (const cleanup of cleanups.reverse()) await cleanup();
    result.closed = managers.map((manager) => manager.stats);
    if (!result.passed) process.exitCode = 1;
    result.finished = new Date().toISOString();
    result.passed &&= result.closed.every(
      (stats) =>
        stats.generations === 0 &&
        stats.connections === 0 &&
        stats.pendingDials === 0 &&
        stats.listeners === 0,
    );
    fs.mkdirSync('test-results', { recursive: true });
    const filename = path.resolve('test-results/transport-stability.json');
    fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({
        passed: result.passed,
        formalAcceptance: result.formalAcceptance,
        elapsedMs: result.elapsedMs,
        rotations: result.rotations,
        coverFaults: result.coverFaults,
        filename,
      }) + '\n',
    );
  }
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? 'ERR_STABILITY'}: ${error.message}\n`);
  process.exitCode = 1;
});
