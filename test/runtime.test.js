'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createRuntime, config, checkConfig } = require('../');
const { echo, httpServer, readBytes, listen } = require('./helpers');

test('construction and empty-inbound runtime do not listen', async () => {
  const original = net.Server.prototype.listen;
  let calls = 0;
  net.Server.prototype.listen = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    const runtime = createRuntime({ inbounds: [] });
    assert.equal(runtime.state, 'created');
    await runtime.start();
    assert.equal(calls, 0);
    assert.deepEqual(runtime.listenersInfo, []);
    await runtime.close();
    assert.equal(calls, 0);
    assert.equal(runtime.state, 'closed');
  } finally {
    net.Server.prototype.listen = original;
  }
});

test('concurrent start and close are idempotent and closed is terminal', async () => {
  const runtime = createRuntime();
  const first = runtime.start();
  await Promise.all([first, runtime.start()]);
  const close = runtime.close();
  assert.equal(runtime.close(), close);
  await close;
  await runtime.close();
  await assert.rejects(runtime.start(), { code: 'ERR_CLOSED' });
  await assert.rejects(runtime.dial({ host: 'localhost', port: 80 }), { code: 'ERR_STATE' });
});

test('lifecycle observers can safely reenter start and close', async () => {
  const runtime = createRuntime();
  let repeatedStart;
  let repeatedClose;
  runtime.on('state', (state) => {
    if (state === 'starting') repeatedStart = runtime.start();
    if (state === 'closing') repeatedClose = runtime.close();
  });
  const started = runtime.start();
  assert.equal(repeatedStart, started);
  await started;
  const closed = runtime.close();
  assert.equal(repeatedClose, closed);
  await closed;
});

test('Freedom returns a binary Duplex, supports half-close and leaves no resources', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime();
  t.after(() => runtime.close());
  await runtime.start();
  const stream = await runtime.dial(target);
  const data = Buffer.from([0, 255, 1, 0, 127]);
  stream.write(data);
  assert.deepEqual(await readBytes(stream, data.length), data);
  stream.end();
  stream.resume();
  await once(stream, 'close');
  await runtime.close();
  assert.deepEqual(runtime.stats, {
    state: 'closed',
    connections: 0,
    pendingDials: 0,
    listeners: 0,
  });
});

test('two runtimes are isolated and one close does not close the other', async (t) => {
  const target = await echo(t);
  const a = createRuntime();
  const b = createRuntime();
  t.after(() => Promise.all([a.close(), b.close()]));
  await Promise.all([a.start(), b.start()]);
  const stream = await b.dial(target);
  await a.close();
  stream.write('still alive');
  assert.equal((await readBytes(stream, 11)).toString(), 'still alive');
});

test('startup failure rolls back prior listeners', async (t) => {
  const busy = net.createServer();
  const busyPort = await listen(busy);
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  const runtime = createRuntime({
    inbounds: [{ protocol: 'socks', networks: [{ port: 0 }, { port: busyPort }] }],
  });
  const states = [];
  let observedClose;
  runtime.on('state', (state) => {
    states.push(state);
    if (state === 'closing') observedClose = runtime.close();
  });
  await assert.rejects(runtime.start(), { code: 'ERR_LISTEN' });
  await observedClose;
  assert.deepEqual(states, ['starting', 'closing', 'closed']);
  assert.equal(runtime.state, 'closed');
  assert.equal(runtime.stats.listeners, 0);
  await runtime.close();
});

test('close racing startup is bounded', async () => {
  const runtime = createRuntime({ inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }] });
  const starting = runtime.start();
  const rejected = assert.rejects(starting, { code: 'ERR_CANCELLED' });
  await runtime.close();
  await rejected;
  assert.equal(runtime.state, 'closed');
});

test('abort cancels DNS and runtime close cancels unfinished dials', async () => {
  const runtime = createRuntime({}, { lookup() {} });
  await runtime.start();
  const abort = new AbortController();
  const pending = runtime.dial({ host: 'never.example', port: 80, signal: abort.signal });
  const rejection = assert.rejects(pending, { code: 'ERR_CANCELLED' });
  abort.abort();
  await rejection;
  const pending2 = runtime.dial({ host: 'never.example', port: 80 });
  const rejection2 = assert.rejects(pending2, { code: 'ERR_CANCELLED' });
  await runtime.close();
  await rejection2;
  assert.equal(runtime.stats.pendingDials, 0);
});

test('timeout, connection limits, bad targets and tags have stable errors', async (t) => {
  const runtime = createRuntime(
    { limits: { connectTimeoutMs: 30, maxPendingDials: 1 } },
    { lookup() {} },
  );
  t.after(() => runtime.close());
  await runtime.start();
  await assert.rejects(runtime.dial({ host: '127.0.0.1', port: 0 }), { code: 'ERR_TARGET' });
  await assert.rejects(runtime.dial({ host: 'localhost', port: 80, outboundTag: 'missing' }), {
    code: 'ERR_ROUTING',
  });
  const first = runtime.dial({ host: 'never.example', port: 80 });
  const rejection = assert.rejects(first, { code: 'ERR_TIMEOUT' });
  await assert.rejects(runtime.dial({ host: 'never.example', port: 80 }), { code: 'ERR_LIMIT' });
  await rejection;
});

test('bounded close destroys a held connection after drain budget', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime();
  await runtime.start();
  const stream = await runtime.dial(target);
  await runtime.close({ drainTimeoutMs: 20 });
  assert.equal(stream.destroyed, true);
  assert.equal(runtime.stats.connections, 0);
});

test('legacy routing and config start/stop use async lifecycle', async (t) => {
  const target = await echo(t);
  let context;
  const runtime = config({
    outbounds: [{ protocol: 'freedom', tag: 'chosen' }],
    routing(...args) {
      context = args;
      return 'chosen';
    },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const stream = await runtime.dial({ ...target, inboundTag: 'test' });
  assert.deepEqual(context, [target.host, target.port, 1, 'test']);
  stream.write('legacy');
  assert.equal((await readBytes(stream, 6)).toString(), 'legacy');
});

test('ordinary and virtual streams satisfy Node HTTP connection contract', async (t) => {
  const target = await httpServer(t);
  const proxy = createRuntime({ inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }] });
  await proxy.start();
  const client = createRuntime({
    outbounds: [
      {
        protocol: 'socks',
        networks: [{ address: '127.0.0.1', port: proxy.listenersInfo[0].address.port }],
      },
    ],
  });
  t.after(() => Promise.all([proxy.close(), client.close()]));
  await client.start();
  const agent = new http.Agent({ keepAlive: true });
  agent.createConnection = (options, callback) => {
    client
      .dial({ host: options.host, port: Number(options.port) })
      .then((socket) => callback(null, socket), callback);
  };
  t.after(() => agent.destroy());
  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: target.port, agent }, (response) => {
        let body = '';
        response.on('data', (data) => {
          body += data;
        });
        response.once('end', () => resolve(body));
      })
      .once('error', reject);
  });
  assert.equal(body, 'hello through runtime');
});

test('repeated isolated creation/close naturally exits', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `(async () => {
    const {createRuntime} = require('./');
    for(let i=0;i<20;i++){ const runtime=createRuntime({inbounds:[{protocol:'socks',networks:[{port:0}]}]}); await runtime.start(); await runtime.close(); }
    console.log('closed');
  })().catch(e => { console.error(e); process.exitCode=1; });`,
    ],
    { cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'closed');
});

test('strict diagnostics and credential redaction do not echo invalid values', () => {
  const report = checkConfig({
    outbounds: [{ protocol: 'vless', users: [{ id: 'secret' }] }],
    api: {},
  });
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((item) => item.path === 'api'));
  assert.equal(JSON.stringify(report.diagnostics).includes('secret'), false);
  assert.throws(() => createRuntime({ outbounds: [{ protocol: 'unknown' }] }), {
    code: 'ERR_CONFIG',
  });
});
