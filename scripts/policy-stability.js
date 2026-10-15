'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { createRuntimeManager } = require('..');
const { echo, readBytes } = require('../test/helpers');
const { dnsServer } = require('../test/fixtures/dns-server');
const { sourceEvidence, digest, verify } = require('./acceptance-evidence');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function within(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Policy stability operation timed out.')), 15000);
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
    held = [],
    workers = [],
    profiles = [];
  const result = {
    phase: 'P20',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    started: new Date().toISOString(),
    durationMinutes: minutes,
    formalAcceptance: minutes >= 30,
    concurrentSessions: 100,
    concurrentDatagrams: 4,
    profiles: [],
    latency: { count: 0, totalMs: 0, maxMs: 0 },
    rotations: 0,
    faults: 0,
    dnsChecks: 0,
    udpChecks: 0,
    iterations: 0,
    bytes: 0,
    churn: 0,
    peak: { rss: 0, heap: 0, pendingDns: 0, cacheEntries: 0, queuedBytes: 0 },
    samples: [],
    passed: false,
    ...sourceEvidence(),
    harnessSha256: digest(__filename),
  };
  const configHash = crypto.createHash('sha256');
  let stopped = false,
    interval,
    samplingError;
  function config(profile, server, id) {
    const dns = {
      tag: 'dns-up',
      queryStrategy: 'UseIPv4',
      cacheSize: 128,
      maxConcurrent: 256,
      timeoutMs: 250,
      clientIp: '192.0.2.199',
      servers: [
        {
          address: `tcp://127.0.0.1:${profile.silent.port}`,
          domains: ['full:fault.policy.synthetic'],
          skipFallback: true,
          timeoutMs: 20,
        },
        { address: profile.upstream.address, port: profile.upstream.port },
      ],
    };
    const value = {
      compatibility: profile.compatibility,
      limits: { maxConnections: 512, maxPendingDials: 256, maxBufferBytes: 262144 },
      dns,
      [server ? 'inbounds' : 'outbounds']: [
        {
          tag: 'entry',
          protocol: profile.protocol,
          users: [
            {
              id,
              email: 'tenant@synthetic',
              ...(profile.protocol === 'vless'
                ? { encryption: 'none' }
                : { security: 'aes-128-gcm' }),
            },
          ],
          networks: [
            {
              type: profile.type,
              address: '127.0.0.1',
              port: server ? 0 : profile.port,
              ...(profile.type === 'tcp'
                ? {}
                : {
                    option: {
                      path: '/policy',
                      ...(profile.type === 'xhttp' ? { httpVersion: '2', mode: 'stream-up' } : {}),
                    },
                  }),
            },
          ],
          ...(server
            ? { sniffing: { enabled: true, routeOnly: true } }
            : profile.mux
              ? { mux: { enabled: true, concurrency: 64 } }
              : {}),
        },
      ],
      ...(server
        ? {
            outbounds: [
              { tag: 'deny', protocol: 'blackhole' },
              { tag: 'allow', protocol: 'freedom', domainStrategy: 'UseIPv4' },
            ],
            routing: {
              domainMatcher: 'hybrid',
              rules: [
                { inboundTag: ['dns-up'], outboundTag: 'allow' },
                {
                  network: 'udp',
                  source: ['127.0.0.0/8'],
                  user: ['tenant@synthetic'],
                  outboundTag: 'allow',
                },
                {
                  domain: ['regexp:^[a-z0-9-]+\\.policy\\.synthetic$'],
                  source: ['127.0.0.0/8'],
                  sourcePort: '1-65535',
                  user: ['tenant@synthetic'],
                  protocol: ['http'],
                  ...(profile.compatibility === 'xray-25.3.6'
                    ? { attrs: { 'x-policy': '^yes$' } }
                    : {}),
                  outboundTag: 'allow',
                },
              ],
            },
          }
        : {}),
    };
    configHash.update(JSON.stringify(value));
    return value;
  }
  async function exchange(stream, payload) {
    const began = performance.now();
    const reply = readBytes(stream, payload.length);
    stream.write(payload);
    assert.deepEqual(await within(reply), payload);
    result.iterations++;
    const elapsed = performance.now() - began;
    result.latency.count++;
    result.latency.totalMs += elapsed;
    result.latency.maxMs = Math.max(result.latency.maxMs, elapsed);
    result.bytes += payload.length;
  }
  async function connect(profile) {
    const stream = await within(
      profile.client.dial({ host: 'echo.policy.synthetic', port: profile.target.port }),
    );
    try {
      await exchange(
        stream,
        Buffer.from('GET / HTTP/1.1\r\nHost: echo.policy.synthetic\r\nX-Policy: yes\r\n\r\n'),
      );
      return stream;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }
  function sample() {
    const memory = process.memoryUsage();
    let pendingDns = 0,
      cacheEntries = 0,
      queuedBytes = 0;
    for (const manager of managers)
      for (const generation of manager.metrics) {
        const m = generation.metrics;
        pendingDns += m.dns.pending;
        cacheEntries += m.dns.cacheEntries;
        queuedBytes += m.transport.bufferedBytes + m.mux.queuedBytes;
        assert.ok(m.dns.pending <= 256);
        assert.ok(m.dns.cacheEntries <= 128);
      }
    for (const [key, value] of Object.entries({
      rss: memory.rss,
      heap: memory.heapUsed,
      pendingDns,
      cacheEntries,
      queuedBytes,
    }))
      result.peak[key] = Math.max(result.peak[key], value);
    assert.ok(memory.rss < 1536 * 1024 * 1024);
    assert.ok(queuedBytes < 64 * 1024 * 1024);
    result.samples.push({
      elapsedMs: Math.round(performance.now() - started),
      rss: memory.rss,
      heap: memory.heapUsed,
      pendingDns,
      cacheEntries,
      queuedBytes,
    });
  }
  let started;
  try {
    const udpEcho = dgram.createSocket('udp4');
    udpEcho.on('message', (bytes, peer) => udpEcho.send(bytes, peer.port, peer.address));
    udpEcho.bind(0, '127.0.0.1');
    await once(udpEcho, 'listening');
    cleanups.push(() => new Promise((r) => udpEcho.close(r)));
    for (const [protocol, type, mux, compatibility] of [
      ['vmess', 'tcp', false, 'v2ray-5.14.1'],
      ['vless', 'tcp', true, 'xray-25.3.6'],
      ['vless', 'ws', false, 'v2ray-5.14.1'],
      ['vless', 'xhttp', false, 'xray-25.3.6'],
    ]) {
      const profile = {
        protocol,
        type,
        mux,
        compatibility,
        id: crypto.randomUUID(),
        upstream: await dnsServer(t),
        silent: await dnsServer(t, { silent: true }),
        target: await echo(t),
      };
      profiles.push(profile);
      result.profiles.push({ protocol, type, mux, compatibility, count: 25 });
      profile.server = createRuntimeManager(config(profile, true, profile.id), {
        maxRetiringGenerations: 32,
      });
      managers.push(profile.server);
      await profile.server.start();
      profile.port = profile.server.listenersInfo[0].address.port;
      profile.client = createRuntimeManager(config(profile, false, profile.id), {
        maxRetiringGenerations: 32,
      });
      managers.push(profile.client);
      await profile.client.start();
      for (let i = 0; i < 25; i++) held.push({ profile, stream: await connect(profile) });
      profile.datagram = await profile.client.openDatagram({
        host: 'echo.policy.synthetic',
        port: udpEcho.address().port,
      });
    }
    assert.equal(held.length, 100);
    started = performance.now();
    const deadline = started + minutes * 60000;
    interval = setInterval(() => {
      try {
        sample();
      } catch (e) {
        samplingError = e;
        stopped = true;
      }
    }, 5000);
    for (const { stream } of held)
      workers.push(
        (async () => {
          const bytes = crypto.randomBytes(1024);
          while (!stopped && performance.now() < deadline) {
            await exchange(stream, bytes);
            await pause(100);
          }
        })(),
      );
    workers.push(
      (async () => {
        let next = started + rotationMs,
          index = 0;
        while (!stopped && performance.now() < deadline) {
          for (const profile of profiles) {
            const packet = crypto.randomBytes(1024);
            await profile.datagram.send(packet);
            assert.deepEqual((await within(profile.datagram.next())).value.data, packet);
            result.udpChecks++;
            const host = `n${index % 32}.policy.synthetic`;
            assert.equal(
              (await within(profile.server.resolve(host, { family: 4 })))[0].address,
              '127.0.0.1',
            );
            result.dnsChecks++;
            profile.upstream.calls.length = 0;
            profile.silent.calls.length = 0;
            const stream = await connect(profile);
            stream.destroy();
            result.churn++;
          }
          index++;
          if (performance.now() >= next) {
            for (const profile of profiles) {
              assert.equal(
                (await within(profile.server.resolve('fault.policy.synthetic', { family: 4 })))[0]
                  .address,
                '127.0.0.1',
              );
              result.faults++;
              const id = crypto.randomUUID();
              (
                await profile.server.rotate(config(profile, true, id), {
                  drainTimeoutMs: minutes * 60000 + 30000,
                })
              ).drained.catch(() => {});
              (
                await profile.client.rotate(config(profile, false, id), {
                  drainTimeoutMs: minutes * 60000 + 30000,
                })
              ).drained.catch(() => {});
              profile.id = id;
              const stream = await connect(profile);
              stream.destroy();
            }
            result.rotations++;
            next += rotationMs;
          }
          await pause(1000);
        }
      })(),
    );
    await Promise.all(workers);
    if (samplingError) throw samplingError;
    result.elapsedMs = Math.round(performance.now() - started);
    sample();
    assert.ok(result.rotations >= Math.floor((minutes * 60000) / rotationMs) - 1);
    assert.equal(result.faults, 4 * result.rotations);
    result.configSha256 = configHash.digest('hex');
    result.passed = result.elapsedMs >= minutes * 60000;
  } catch (error) {
    result.error = { code: error.code, message: error.message };
    throw error;
  } finally {
    stopped = true;
    clearInterval(interval);
    held.forEach(({ stream }) => stream.destroy());
    profiles.forEach((profile) => profile.datagram?.destroy());
    await Promise.all(managers.map((m) => m.close()));
    await Promise.allSettled(workers);
    for (const cleanup of cleanups.reverse()) await cleanup();
    result.closed = managers.map((m) => m.stats);
    result.passed &&= result.closed.every(
      (s) =>
        s.state === 'closed' &&
        s.generations === 0 &&
        s.connections === 0 &&
        s.pendingDials === 0 &&
        s.listeners === 0,
    );
    result.finished = new Date().toISOString();
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/policy-stability.json', JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({
        passed: result.passed,
        formalAcceptance: result.formalAcceptance,
        elapsedMs: result.elapsedMs,
        rotations: result.rotations,
      }) + '\n',
    );
    if (!result.passed) process.exitCode = 1;
  }
  verify(result, { formal: minutes >= 30 });
}
main().catch((error) => {
  process.stderr.write(`${error.code ?? 'ERR_STABILITY'}: ${error.message}\n`);
  process.exitCode = 1;
});
