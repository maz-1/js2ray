'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { connect, createListener } = require('../transports');
const { XmuxPool } = require('../transports/xhttp/xmux');
const { xmuxSettings } = require('../config/xhttp');
const { checkConfig, createRuntime, createRuntimeManager } = require('..');
const { listen, readBytes, echo } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Resources did not settle.');
    await pause(10);
  }
}
async function exchange(stream, body = randomBytes(8193)) {
  const read = readBytes(stream, body.length);
  await new Promise((resolve, reject) =>
    stream.write(body, (cause) => (cause ? reject(cause) : resolve())),
  );
  assert.deepEqual(await read, body);
}
async function fixture(
  t,
  {
    httpVersion = '2',
    mode = 'stream-one',
    xmux = { maxConnections: 1 },
    secure = false,
    dial = connect,
    accept = (stream) => stream.pipe(stream),
  } = {},
) {
  const limits = { maxConnections: 32, maxBufferBytes: 65536, handshakeTimeoutMs: 1500 };
  const listener = createListener(
    { type: 'xhttp', option: { httpVersion, mode, tls: secure ? { cert, key } : undefined } },
    accept,
    limits,
  );
  const port = await listen(listener.server);
  const network = {
    type: 'xhttp',
    address: '127.0.0.1',
    port,
    option: {
      httpVersion,
      mode,
      xmux,
      scMaxEachPostBytes: 8192,
      tls: secure ? { ca: cert, serverName: 'js2ray.test' } : undefined,
    },
  };
  const pool = new XmuxPool(network, limits, dial);
  t.after(async () => {
    pool.close();
    listener.destroy();
    await new Promise((resolve) => listener.server.close(resolve));
    assert.equal(pool.stats.clients, 0);
    assert.equal(pool.stats.sockets, 0);
  });
  return {
    pool,
    listener,
    network,
    limits,
    dial: (signal) => connect(network, { ...limits, signal, xhttpPool: pool }),
  };
}
test('XMUX packet-up accepts an empty HTTP2 acknowledgement whose EOF precedes the awaiting continuation', async (t) => {
  const f = await fixture(t, { mode: 'packet-up' }),
    hold = await f.pool.acquire();
  const session = hold.entry.session,
    request = session.request.bind(session);
  let completed = 0;
  session.request = (headers, ...args) => {
    const req = request(headers, ...args);
    if (headers[':method'] === 'POST' && headers['content-length'] !== undefined) {
      const once = req.once;
      req.once = function (event, listener) {
        if (event === 'response')
          return once.call(this, event, (headers) => {
            once.call(this, 'end', () => {
              completed++;
              listener(headers);
            });
            this.resume();
          });
        return once.call(this, event, listener);
      };
    }
    return req;
  };
  hold.release();
  const stream = await f.dial();
  t.after(() => stream.destroy());
  await exchange(stream, randomBytes(16385));
  assert.ok(completed >= 3);
});
test('XMUX validates every field, inclusive ranges, mutual exclusion and traditional extra', () => {
  const native = (xmux) => ({
    outbounds: [
      {
        protocol: 'socks',
        networks: [{ type: 'xhttp', address: '127.0.0.1', port: 10080, option: { xmux } }],
      },
    ],
  });
  for (const value of [
    {},
    {
      maxConnections: '1-2',
      cMaxReuseTimes: '2-3',
      hMaxRequestTimes: 0,
      hMaxReusableSecs: '0-1',
      hKeepAlivePeriod: -1,
    },
    { maxConcurrency: '2-4', hMaxRequestTimes: 2147483647, hKeepAlivePeriod: 0 },
  ])
    assert.equal(checkConfig(native(value)).ok, true);
  for (const value of [
    null,
    [],
    false,
    1,
    { unknown: 1 },
    { maxConnections: 1, maxConcurrency: '0-1' },
    { hKeepAlivePeriod: '1-2' },
    { hKeepAlivePeriod: 0.5 },
    { hKeepAlivePeriod: 2147483648 },
  ])
    assert.equal(checkConfig(native(value)).ok, false, JSON.stringify(value));
  for (const field of [
    'maxConcurrency',
    'maxConnections',
    'cMaxReuseTimes',
    'hMaxRequestTimes',
    'hMaxReusableSecs',
  ])
    for (const value of [
      -1,
      0.5,
      true,
      {},
      [],
      '2-1',
      '1-',
      '1.2',
      '2147483648',
      2147483648,
      '0-2147483648',
    ])
      assert.equal(
        checkConfig(native({ [field]: value })).ok,
        false,
        field + ':' + JSON.stringify(value),
      );
  const report = checkConfig({
    outbounds: [
      {
        protocol: 'socks',
        settings: { servers: [{ address: '127.0.0.1', port: 10080 }] },
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: { extra: { xmux: { maxConcurrency: '2-4', hKeepAlivePeriod: -1 } } },
        },
      },
    ],
  });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.deepEqual(report.config.outbounds[0].networks[0].option.xmux, {
    maxConcurrency: '2-4',
    hKeepAlivePeriod: -1,
  });
  assert.deepEqual(xmuxSettings(), xmuxSettings({ maxConcurrency: 0, hKeepAlivePeriod: 0 }));
  assert.deepEqual(xmuxSettings().maxConcurrency, { from: 16, to: 32 });
  assert.deepEqual(xmuxSettings().hMaxRequestTimes, { from: 600, to: 900 });
  assert.deepEqual(xmuxSettings().hMaxReusableSecs, { from: 1800, to: 3000 });
  assert.deepEqual(xmuxSettings({ hKeepAlivePeriod: -1 }).maxConcurrency, { from: 0, to: 0 });
});
for (const secure of [false, true])
  for (const httpVersion of ['1.1', '2'])
    for (const mode of ['packet-up', 'stream-up', 'stream-one']) {
      test(`XMUX ${secure ? 'TLS ' : ''}HTTP/${httpVersion} ${mode} shares clients and isolates stream cancellation`, async (t) => {
        const { dial, pool, listener } = await fixture(t, { secure, httpVersion, mode });
        const streams = await Promise.all([dial(), dial(), dial()]);
        assert.equal(pool.stats.created, 1);
        assert.equal(pool.stats.active, 3);
        if (httpVersion === '2') assert.equal(listener.stats.http2Sessions, 1);
        await Promise.all(streams.map((stream) => exchange(stream)));
        streams[0].destroy();
        await until(() => pool.stats.active === 2);
        await Promise.all(streams.slice(1).map((stream) => exchange(stream)));
        const next = await dial();
        await exchange(next);
        assert.equal(pool.stats.created, 1);
        for (const stream of [...streams, next]) stream.destroy();
        await until(() => pool.stats.active === 0 && listener.stats.sessions === 0);
      });
    }
test('XMUX concurrency reserves in-flight handshakes and never overfills a client', async (t) => {
  const { dial, pool } = await fixture(t, { xmux: { maxConcurrency: 2 } });
  const streams = await Promise.all(Array.from({ length: 7 }, () => dial()));
  assert.equal(pool.stats.created, 4);
  assert.ok([...pool.entries].every((entry) => entry.active <= 2));
  await Promise.all(streams.map((stream) => exchange(stream)));
  for (const stream of streams) stream.destroy();
});
test('XMUX maxConnections fills a bounded client pool before random reuse', async (t) => {
  const { dial, pool } = await fixture(t, { xmux: { maxConnections: '3-3' } });
  const streams = await Promise.all(Array.from({ length: 9 }, () => dial()));
  assert.equal(pool.stats.created, 3);
  assert.equal(pool.stats.clients, 3);
  await Promise.all(streams.map((stream) => exchange(stream)));
  for (const stream of streams) stream.destroy();
});
test('XMUX cMaxReuseTimes retires clients while existing streams keep their bytes', async (t) => {
  const { dial, pool } = await fixture(t, { xmux: { maxConnections: 1, cMaxReuseTimes: '2-2' } });
  const streams = [await dial(), await dial(), await dial()];
  assert.equal(pool.stats.created, 2);
  assert.equal(pool.stats.draining, 1);
  await Promise.all(streams.map((stream) => exchange(stream)));
  for (const stream of streams.slice(0, 2)) stream.destroy();
  await until(() => pool.stats.clients === 1);
  await exchange(streams[2]);
  streams[2].destroy();
});
for (const mode of ['stream-one', 'stream-up', 'packet-up']) {
  test(`XMUX hMaxRequestTimes ${mode} rotates without interrupting downlinks`, async (t) => {
    const { dial, pool } = await fixture(t, {
      mode,
      xmux: { maxConnections: 1, hMaxRequestTimes: 2 },
    });
    const first = await dial();
    await exchange(first, Buffer.from('first'));
    const second = await dial();
    const third = mode === 'stream-one' ? await dial() : undefined;
    for (let i = 0; i < 5; i++) await Promise.all([exchange(first), exchange(second)]);
    assert.ok(pool.stats.created >= 2);
    if (mode === 'packet-up') assert.ok(pool.stats.created >= 6);
    first.destroy();
    second.destroy();
    third?.destroy();
    await until(() => pool.stats.active === 0);
  });
}
for (const mode of ['stream-one', 'packet-up']) {
  test(`XMUX hMaxReusableSecs ${mode} retires on time and preserves active traffic`, async (t) => {
    const { dial, pool } = await fixture(t, {
      mode,
      xmux: { maxConnections: 1, hMaxReusableSecs: 1 },
    });
    const first = await dial();
    await exchange(first);
    await pause(1050);
    const second = await dial();
    assert.ok(pool.stats.created >= 2);
    await Promise.all([exchange(first), exchange(second)]);
    first.destroy();
    second.destroy();
    await until(() => pool.stats.draining === 0);
  });
}
test('XMUX HTTP/2 GOAWAY drains accepted streams and sends new requests to a fresh session', async (t) => {
  const { dial, pool, listener } = await fixture(t, { mode: 'packet-up' });
  const sessions = [];
  listener.server.on('session', (session) => sessions.push(session));
  const first = await dial();
  await exchange(first);
  sessions[0].goaway();
  await until(() => pool.stats.draining === 1);
  await exchange(first);
  const second = await dial();
  await Promise.all([exchange(first), exchange(second)]);
  assert.equal(pool.stats.created, 2);
  first.destroy();
  second.destroy();
  await until(() => pool.stats.draining === 0);
});
test('XMUX observes peer HTTP/2 stream capacity when selecting a client', async (t) => {
  const { dial, pool, listener } = await fixture(t, { mode: 'stream-up' });
  listener.server.updateSettings({ maxConcurrentStreams: 2 });
  const first = await dial();
  await pause(20);
  const others = await Promise.all([dial(), dial()]);
  await Promise.all([first, ...others].map((stream) => exchange(stream)));
  assert.equal(pool.stats.created, 3);
  for (const stream of [first, ...others]) stream.destroy();
});
test('XMUX cancelling one shared pending handshake preserves the other waiter', async (t) => {
  const { dial, pool } = await fixture(t, {
    dial: async (...args) => {
      await pause(60);
      return connect(...args);
    },
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(dial(controller.signal), { code: 'ERR_CANCELLED' });
  const pending = dial();
  controller.abort();
  await cancelled;
  const stream = await pending;
  await exchange(stream);
  assert.equal(pool.stats.created, 1);
  assert.equal(pool.stats.active, 1);
  stream.destroy();
});
test('XMUX cancelling all waiters closes the pending dial and permits a new attempt', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.resume();
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  const network = {
    type: 'xhttp',
    address: '127.0.0.1',
    port,
    option: { httpVersion: '2', xmux: { maxConnections: 1 } },
  };
  const limits = { handshakeTimeoutMs: 1000 };
  const pool = new XmuxPool(network, limits, connect);
  t.after(async () => {
    pool.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const controller = new AbortController();
  const pending = assert.rejects(
    connect(network, { ...limits, xhttpPool: pool, signal: controller.signal }),
    { code: 'ERR_CANCELLED' },
  );

  test('XMUX outgoing writes do not postpone an otherwise read-idle HTTP/2 PING', async (t) => {
    const { dial, pool, listener } = await fixture(t, {
      accept: (stream) => stream.resume(),
      xmux: { maxConnections: 1, hKeepAlivePeriod: 1 },
    });
    let pings = 0;
    listener.server.on('session', (session) => session.on('ping', () => pings++));
    const stream = await dial();
    for (let i = 0; i < 16; i++) {
      await new Promise((resolve, reject) =>
        stream.write(Buffer.alloc(128), (cause) => (cause ? reject(cause) : resolve())),
      );
      await pause(100);
    }
    assert.ok(pings > 0);
    assert.ok(pool.stats.pings > 0);
    stream.destroy();
  });
  await until(() => sockets.size === 1);
  controller.abort();
  await pending;
  await until(() => pool.stats.clients === 0 && sockets.size === 0);
});
for (const period of [1, -1]) {
  test(`XMUX hKeepAlivePeriod=${period} controls idle HTTP/2 PING`, async (t) => {
    const { dial, pool, listener } = await fixture(t, {
      xmux: { maxConnections: 1, hKeepAlivePeriod: period },
    });
    let pings = 0;
    listener.server.on('session', (session) => session.on('ping', () => pings++));
    const stream = await dial();
    await exchange(stream);
    if (period > 0) {
      await until(() => pings > 0 && pool.stats.pings > 0);
      assert.ok(pings >= 1);
      assert.ok(pool.stats.pings >= 1);
    } else {
      await pause(1400);
      assert.equal(pings, 0);
      assert.equal(pool.stats.pings, 0);
    }
    await exchange(stream);
    stream.destroy();
  });
}
test('XMUX Runtime pools isolate instances and generations, expose metrics, and close idle sockets', async (t) => {
  const target = await echo(t),
    id = randomUUID();
  const server = createRuntime({
    inbounds: [
      {
        protocol: 'vless',
        users: [{ id }],
        networks: [{ type: 'xhttp', port: 0, option: { httpVersion: '2', mode: 'stream-one' } }],
      },
    ],
  });
  await server.start();
  t.after(() => server.close());
  const config = {
    outbounds: [
      {
        protocol: 'vless',
        users: [{ id, encryption: 'none' }],
        networks: [
          {
            type: 'xhttp',
            address: '127.0.0.1',
            port: server.listenersInfo[0].address.port,
            option: { httpVersion: '2', mode: 'stream-one', xmux: { maxConnections: 1 } },
          },
        ],
      },
    ],
  };
  const manager = createRuntimeManager(config),
    separate = createRuntime(config);
  await manager.start();
  await separate.start();
  t.after(() => manager.close());
  t.after(() => separate.close());
  const first = await manager.dial(target),
    same = await manager.dial(target),
    other = await separate.dial(target);
  await Promise.all([first, same, other].map((stream) => exchange(stream)));
  assert.equal(manager.metrics[0].metrics.xhttp.created, 1);
  assert.equal(separate.metrics.xhttp.created, 1);
  assert.equal(server.metrics.inbound.accepted, 2);
  const rotation = await manager.rotate(config, { drainTimeoutMs: 2000 });
  const fresh = await manager.dial(target);
  await Promise.all([first, fresh].map((stream) => exchange(stream)));
  assert.equal(server.metrics.inbound.accepted, 3);
  assert.equal(manager.metrics.length, 2);
  first.destroy();
  same.destroy();
  fresh.destroy();
  other.destroy();
  await rotation.drained;
  await manager.close();
  await separate.close();
  assert.equal(separate.metrics.xhttp.clients, 0);
  assert.equal(separate.metrics.xhttp.sockets, 0);
  assert.equal(separate.metrics.xhttp.active, 0);
});

test('XMUX samples inclusive policy ranges at pool and client creation', async (t) => {
  const values = new Set();
  for (let i = 0; i < 128; i++) {
    const pool = new XmuxPool({ option: { xmux: { maxConcurrency: '2-4' } } }, {}, connect);
    assert.ok(pool.concurrency >= 2 && pool.concurrency <= 4);
    values.add(pool.concurrency);
    pool.close();
  }
  assert.equal(values.size, 3);
  const { dial, pool } = await fixture(t, {
    xmux: {
      maxConcurrency: 1,
      cMaxReuseTimes: '2-4',
      hMaxRequestTimes: '10-20',
      hMaxReusableSecs: '20-30',
    },
  });
  const stream = await dial(),
    entry = [...pool.entries][0];
  assert.ok(entry.leftUsage >= 1 && entry.leftUsage <= 3);
  assert.ok(entry.leftRequests >= 9 && entry.leftRequests <= 19);
  assert.ok(entry.expires > Date.now() + 19000 && entry.expires <= Date.now() + 30000);
  await exchange(stream);
  stream.destroy();
});
test('XMUX peer HTTP/2 reset affects one logical stream and never replays its bytes', async (t) => {
  const { dial, pool, listener } = await fixture(t);
  const requests = [];
  listener.server.on('stream', (request) => requests.push(request));
  const first = await dial(),
    second = await dial();
  await Promise.all([exchange(first), exchange(second)]);
  const closed = once(first, 'close');
  // once(close) rejects on the expected stream error; both outcomes mean closed.
  closed.catch(() => {});
  requests[0].close(require('node:http2').constants.NGHTTP2_CANCEL);
  await closed.catch(() => {});
  await exchange(second);
  assert.equal(requests.length, 2);
  assert.equal(pool.stats.created, 1);
  second.destroy();
});
test('XMUX physical HTTP/2 failure closes its streams and a later dial establishes a new client', async (t) => {
  const { dial, pool, listener } = await fixture(t);
  const sessions = [];
  listener.server.on('session', (session) => sessions.push(session));
  const first = await dial(),
    second = await dial();
  await Promise.all([exchange(first), exchange(second)]);
  const reads = [first, second].map((stream) => assert.rejects(readBytes(stream, 1)));
  sessions[0].destroy();
  await Promise.all(reads);
  await until(() => pool.stats.clients === 0);
  const fresh = await dial();
  await exchange(fresh);
  assert.equal(pool.stats.created, 2);
  fresh.destroy();
});
test('XMUX HTTP/2 stream-one GOAWAY preserves both accepted directions', async (t) => {
  const { dial, pool, listener } = await fixture(t);
  let session;
  listener.server.on('session', (value) => (session ??= value));
  const first = await dial();
  await exchange(first);
  session.goaway();
  await until(() => pool.stats.draining === 1);
  const second = await dial();
  await Promise.all([exchange(first), exchange(second)]);
  assert.equal(pool.stats.created, 2);
  first.destroy();
  second.destroy();
});
test('XMUX peer capacity below the mode requirement fails promptly and releases the client', async (t) => {
  const { dial, pool, listener } = await fixture(t, { mode: 'stream-up' });
  listener.server.updateSettings({ maxConcurrentStreams: 1 });
  await assert.rejects(dial(), { code: 'ERR_LIMIT' });
  assert.equal(pool.stats.clients, 0);
});

test('XMUX unref on one logical stream preserves other streams references', async (t) => {
  const { dial, pool } = await fixture(t);
  const first = await dial(),
    second = await dial();
  const entry = [...pool.entries][0];
  assert.equal(entry.refCount, 2);
  first.unref();
  assert.equal(entry.refCount, 1);
  first.unref();
  assert.equal(entry.refCount, 1);
  await exchange(second);
  first.ref();
  assert.equal(entry.refCount, 2);
  first.destroy();
  await until(() => entry.refCount === 1);
  await exchange(second);
  second.destroy();
  await until(() => entry.refCount === 0);
});

for (const secure of [false, true])
  test(`XMUX ${secure ? 'TLS ' : ''}HTTP/2 keepalive measures read idle time instead of elapsed lifetime`, async (t) => {
    const { dial, pool, listener } = await fixture(t, {
      secure,
      xmux: { maxConnections: 1, hKeepAlivePeriod: 1 },
    });
    let pings = 0;
    listener.server.on('session', (session) => session.on('ping', () => pings++));
    const stream = await dial();
    const socket = [...[...pool.entries][0].sockets][0],
      initialRead = socket.bytesRead;
    for (let i = 0; i < 16; i++) {
      await exchange(stream);
      await pause(100);
    }
    assert.ok(socket.bytesRead > initialRead);
    assert.equal(pings, 0, 'Active reads must postpone the idle PING.');
    await until(() => pings > 0 && pool.stats.pings > 0);
    assert.ok(pings > 0);
    assert.ok(pool.stats.pings > 0);
    stream.destroy();
  });
