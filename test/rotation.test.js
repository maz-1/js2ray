'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRuntime, createRuntimeManager } = require('..');
const { echo, readBytes } = require('./helpers');
const { id } = require('./fixtures/reverse');
const { createHttpAgent, createUndiciDispatcher } = require('..');
const http = require('node:http');
const undici = require('undici');
const { listen } = require('./helpers');
const fs = require('node:fs');
const net = require('node:net');
const nextId = 'ea872601-5fc7-433d-b02a-44376cab86a1';
test('rotation keeps held streams, switches new requests and rolls back invalid/start/readiness failures', async (t) => {
  const target = await echo(t);
  const manager = createRuntimeManager();
  await manager.start();
  t.after(() => manager.close());
  const old = await manager.dial(target);
  const cutover = await manager.rotate(
    { outbounds: [{ protocol: 'blackhole' }] },
    { drainTimeoutMs: 500 },
  );
  assert.equal(cutover.generation, 2);
  await assert.rejects(manager.dial(target), { code: 'ERR_BLOCKED' });
  old.write('held');
  assert.equal((await readBytes(old, 4)).toString(), 'held');
  old.destroy();
  await cutover.drained;
  assert.equal(manager.stats.generations, 1);
  const generation = manager.generation;
  await assert.rejects(manager.rotate({ outbounds: [{ protocol: 'unknown' }] }), {
    code: 'ERR_CONFIG',
  });
  await assert.rejects(
    manager.rotate(
      {},
      {
        ready: async () => {
          throw Error('private node details');
        },
      },
    ),
    { code: 'ERR_TRANSPORT' },
  );
  await assert.rejects(manager.rotate({}, { timeoutMs: 20, ready: () => new Promise(() => {}) }), {
    code: 'ERR_TIMEOUT',
  });
  assert.equal(manager.generation, generation);
  await manager.close();
  assert.equal(manager.stats.generations, 0);
});
test('same inbound port rotates UUIDs atomically while an authenticated old connection drains', async (t) => {
  const target = await echo(t);
  const config = (userId) => ({
    inbounds: [
      { tag: 'entry', protocol: 'vless', users: [{ id: userId }], networks: [{ port: 0 }] },
    ],
  });
  const manager = createRuntimeManager(config(id));
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  const client = async (userId) => {
    const runtime = createRuntime({
      outbounds: [
        {
          protocol: 'vless',
          users: [{ id: userId, encryption: 'none' }],
          networks: [{ address: '127.0.0.1', port }],
        },
      ],
    });
    await runtime.start();
    t.after(() => runtime.close());
    return runtime;
  };
  const before = await client(id),
    after = await client(nextId);
  const held = await before.dial(target);
  held.write('before');
  await readBytes(held, 6);
  const cutover = await manager.rotate(config(nextId), { drainTimeoutMs: 500 });
  assert.equal(manager.listenersInfo[0].address.port, port);
  held.write('retained');
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  const fresh = await after.dial(target);
  fresh.write('new');
  assert.equal((await readBytes(fresh, 3)).toString(), 'new');
  fresh.destroy();
  const rejected = await before.dial(target);
  const error = new Promise((resolve) => rejected.once('error', resolve));
  rejected.write('old');
  assert.equal((await error).code, 'ERR_PROTOCOL');
  held.destroy();
  await cutover.drained;
});
test('rotation drain deadline and close cancel candidates and queued rotations', async (t) => {
  const target = await echo(t),
    manager = createRuntimeManager();
  await manager.start();
  t.after(() => manager.close());
  const held = await manager.dial(target);
  const cutover = await manager.rotate({}, { drainTimeoutMs: 20 });
  await cutover.drained;
  assert.equal(held.destroyed, true);
  let started;
  const preparing = new Promise((resolve) => {
    started = resolve;
  });
  const first = manager.rotate(
    {},
    {
      ready: () => {
        started();
        return new Promise(() => {});
      },
    },
  );
  const rejected = assert.rejects(first, { code: 'ERR_CANCELLED' });
  await preparing;
  const queued = assert.rejects(manager.rotate({}), { code: 'ERR_STATE' });
  await manager.close();
  await Promise.all([rejected, queued]);
  assert.equal(manager.stats.connections, 0);
});
for (const client of ['node', 'undici']) {
  test(`${client}: generation pools isolate new requests and preserve active plus queued old requests`, async (t) => {
    let release, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const servers = [];
    for (const name of ['old', 'new']) {
      const server = http.createServer((request, response) => {
        if (name === 'old' && request.url === '/wait') {
          release = () => response.end(name);
          started();
        } else response.end(name);
      });
      await listen(server);
      servers.push(server);
    }
    t.after(async () => {
      for (const server of servers) server.closeAllConnections();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });
    const config = (index) => ({
      outbounds: [{ protocol: 'freedom', redirect: `127.0.0.1:${servers[index].address().port}` }],
    });
    const manager = createRuntimeManager(config(0));
    await manager.start();
    t.after(() => manager.close());
    const adapter =
      client === 'node'
        ? createHttpAgent(manager, { maxSockets: 1 })
        : createUndiciDispatcher(manager, { undici, connections: 1, pipelining: 1 });
    t.after(() => adapter.destroy());
    const get = (path) =>
      client === 'node'
        ? new Promise((resolve, reject) => {
            http
              .get(`http://logical.test${path}`, { agent: adapter }, (response) => {
                let body = '';
                response.on('data', (chunk) => {
                  body += chunk;
                });
                response.on('error', reject);
                response.on('end', () => resolve(body));
              })
              .on('error', reject);
          })
        : undici
            .request(`http://logical.test${path}`, { dispatcher: adapter })
            .then((response) => response.body.text());
    assert.equal(await get('/first'), 'old');
    const active = get('/wait');
    await entered;
    const queued = get('/queued');
    const cutover = await manager.rotate(config(1), { drainTimeoutMs: 1000 });
    assert.equal(await get('/fresh'), 'new');
    release();
    assert.equal(await active, 'old');
    assert.equal(await queued, 'old');
    await cutover.drained;
    assert.equal(manager.stats.generations, 1);
    assert.equal(await get('/again'), 'new');
  });
}
for (const type of ['tcp', 'ws']) {
  test(`${type}: same-port TLS certificate rotation prevalidates material and keeps established streams`, async (t) => {
    const target = await echo(t);
    const cert = fs.readFileSync(require.resolve('./fixtures/tls/cert.pem'), 'utf8');
    const key = fs.readFileSync(require.resolve('./fixtures/tls/key.pem'), 'utf8');
    const nextCert = fs.readFileSync(require.resolve('./fixtures/tls/rotated-cert.pem'), 'utf8');
    const nextKey = fs.readFileSync(require.resolve('./fixtures/tls/rotated-key.pem'), 'utf8');
    const config = (certificate, privateKey) => ({
      inbounds: [
        {
          tag: 'tls-entry',
          protocol: 'vless',
          users: [{ id }],
          networks: [
            {
              type,
              port: 0,
              option: {
                ...(type === 'ws' ? { path: '/rotate' } : {}),
                tls: { cert: certificate, key: privateKey },
              },
            },
          ],
        },
      ],
    });
    const manager = createRuntimeManager(config(cert, key));
    await manager.start();
    t.after(() => manager.close());
    const port = manager.listenersInfo[0].address.port;
    const client = async (ca, serverName) => {
      const runtime = createRuntime({
        outbounds: [
          {
            protocol: 'vless',
            users: [{ id, encryption: 'none' }],
            networks: [
              {
                type,
                address: '127.0.0.1',
                port,
                option: { ...(type === 'ws' ? { path: '/rotate' } : {}), tls: { ca, serverName } },
              },
            ],
          },
        ],
      });
      await runtime.start();
      t.after(() => runtime.close());
      return runtime;
    };
    const before = await client(cert, 'js2ray.test');
    const held = await before.dial(target);
    held.write('held');
    await readBytes(held, 4);
    await assert.rejects(manager.rotate(config('invalid PEM', nextKey)), { code: 'ERR_TLS' });
    assert.equal(manager.generation, 1);
    const cutover = await manager.rotate(config(nextCert, nextKey), { drainTimeoutMs: 500 });
    held.write('still');
    assert.equal((await readBytes(held, 5)).toString(), 'still');
    const after = await client(nextCert, 'js2ray-rotated.test');
    const fresh = await after.dial(target);
    fresh.write('rotated');
    assert.equal((await readBytes(fresh, 7)).toString(), 'rotated');
    fresh.destroy();
    await assert.rejects(before.dial(target), { code: 'ERR_TLS' });
    held.destroy();
    await cutover.drained;
    assert.equal(manager.listenersInfo[0].address.port, port);
  });
}
test('listener startup failure rolls back candidate and queued rotations commit in order', async (t) => {
  const busy = net.createServer(),
    port = await listen(busy);
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  const manager = createRuntimeManager();
  await manager.start();
  t.after(() => manager.close());
  await assert.rejects(
    manager.rotate({
      inbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    }),
    { code: 'ERR_LISTEN' },
  );
  assert.equal(manager.generation, 1);
  assert.equal(manager.stats.generations, 1);
  const order = [];
  manager.on('generation', (generation) => order.push(generation));
  const results = await Promise.all([manager.rotate({}), manager.rotate({})]);
  await Promise.all(results.map((result) => result.drained));
  assert.deepEqual(order, [3, 4]);
  await manager.close();
  await assert.rejects(manager.start(), { code: 'ERR_CLOSED' });
});
test('managed UDP sessions drain by generation and rapid rotations have a resource bound', async (t) => {
  const dgram = require('node:dgram');
  const udp = dgram.createSocket('udp4');
  udp.on('message', (data, peer) => udp.send(data, peer.port, peer.address));
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  t.after(() => new Promise((resolve) => udp.close(resolve)));
  const manager = createRuntimeManager({}, { maxRetiringGenerations: 1 });
  await manager.start();
  t.after(() => manager.close());
  const session = await manager.openDatagram({ host: '127.0.0.1', port: udp.address().port });
  const cutover = await manager.rotate(
    { outbounds: [{ protocol: 'blackhole' }] },
    { drainTimeoutMs: 500 },
  );
  await assert.rejects(manager.openDatagram({ host: '127.0.0.1', port: udp.address().port }), {
    code: 'ERR_BLOCKED',
  });
  await assert.rejects(manager.rotate({}), { code: 'ERR_LIMIT' });
  await session.send(Buffer.from('old datagram'));
  assert.equal((await session.next()).value.data.toString(), 'old datagram');
  session.close();
  await cutover.drained;
  const next = await manager.rotate({});
  await next.drained;
});
test('only the committed generation persists storage; rejected candidates leave files untouched', async (t) => {
  const path = require('node:path'),
    os = require('node:os'),
    crypto = require('node:crypto');
  const file = path.join(os.tmpdir(), `js2ray-rotation-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, '{"marker":"synthetic"}');
  t.after(() => fs.unlinkSync(file));
  const manager = createRuntimeManager({ storage: file });
  await manager.start();
  t.after(() => manager.close());
  await assert.rejects(
    manager.rotate(
      { storage: file },
      {
        ready: () => {
          throw Error('reject candidate');
        },
      },
    ),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '{"marker":"synthetic"}');
  const result = await manager.rotate({ storage: file });
  await result.drained;
  assert.equal(fs.readFileSync(file, 'utf8'), '{"marker":"synthetic"}');
  await manager.close();
});
test('repeated manager lifecycles naturally exit after drain and candidate cancellation', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `(async () => {
    const {createRuntimeManager} = require('./');
    for(let i=0;i<10;i++) {
      const runtime = createRuntimeManager({inbounds:[{protocol:'socks',networks:[{port:0}]}]});
      const start = runtime.start(); await Promise.all([start,runtime.start()]);
      for(let j=0;j<3;j++){ const next = await runtime.rotate({inbounds:[{protocol:'socks',networks:[{port:0}]}]}); await next.drained; }
      await runtime.close();
    }
  })().catch(error => {console.error(error); process.exitCode=1});`,
    ],
    {
      cwd: require('node:path').resolve(__dirname, '..'),
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
test('application WebSocket survives rotation while a new Upgrade follows the new policy', async (t) => {
  const { WebSocketServer } = require('ws'),
    { createWebSocket } = require('..');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const port = await listen(server);
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const manager = createRuntimeManager();
  await manager.start();
  t.after(() => manager.close());
  const ws = createWebSocket(manager, `ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const cutover = await manager.rotate(
    { outbounds: [{ protocol: 'blackhole' }] },
    { drainTimeoutMs: 500 },
  );
  const received = once(ws, 'message');
  ws.send('retained');
  assert.equal((await received)[0].toString(), 'retained');
  const rejected = createWebSocket(manager, `ws://127.0.0.1:${port}`);
  assert.equal(
    (await new Promise((resolve) => rejected.once('error', resolve))).code,
    'ERR_BLOCKED',
  );
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await cutover.drained;
});
test('VMess credential rotation replaces inbound authentication without terminating the old encrypted connection', async (t) => {
  const target = await echo(t);
  const config = (userId) => ({
    inbounds: [
      { protocol: 'vmess', tag: 'vmess', users: [{ id: userId }], networks: [{ port: 0 }] },
    ],
  });
  const manager = createRuntimeManager(config(id));
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  const client = async (userId) => {
    const runtime = createRuntime({
      outbounds: [
        {
          protocol: 'vmess',
          users: [{ id: userId, security: 'aes-128-gcm' }],
          networks: [{ address: '127.0.0.1', port }],
        },
      ],
    });
    await runtime.start();
    t.after(() => runtime.close());
    return runtime;
  };
  const before = await client(id),
    after = await client(nextId);
  const held = await before.dial(target);
  held.write('before');
  await readBytes(held, 6);
  const cutover = await manager.rotate(config(nextId), { drainTimeoutMs: 500 });
  held.write('retained');
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  const fresh = await after.dial(target);
  fresh.write('new');
  assert.equal((await readBytes(fresh, 3)).toString(), 'new');
  fresh.destroy();
  const rejected = await before.dial(target);
  rejected.write('old');
  await assert.rejects(readBytes(rejected, 1));
  rejected.destroy();
  held.destroy();
  await cutover.drained;
});
test('manager startup and rotation cancellation are reentrant and restore the previous generation', async () => {
  const cancelled = createRuntimeManager({
    inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }],
  });
  const starting = cancelled.start();
  const rejected = assert.rejects(starting, { code: 'ERR_CANCELLED' });
  await cancelled.close();
  await rejected;
  assert.equal(cancelled.stats.generations, 0);
  const manager = createRuntimeManager();
  await manager.start();
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(manager.rotate({}, { signal: abort.signal }), { code: 'ERR_CANCELLED' });
    assert.equal(manager.generation, 1);
  } finally {
    await manager.close();
  }
});
test('many independent adapters share lifecycle subscriptions and repeated destroy releases them exactly once', async () => {
  const manager = createRuntimeManager();
  await manager.start();
  try {
    const agents = Array.from({ length: 30 }, () => createHttpAgent(manager));
    assert.equal(manager.listenerCount('state'), 1);
    assert.equal(manager.listenerCount('generation'), 1);
    agents.forEach((agent) => agent.destroy());
    assert.equal(manager.listenerCount('state'), 0);
    assert.equal(manager.listenerCount('generation'), 0);
    const fresh = createHttpAgent(manager);
    agents[0].destroy();
    assert.equal(manager.listenerCount('state'), 1);
    assert.equal(manager.listenerCount('generation'), 1);
    fresh.destroy();
    assert.equal(manager.listenerCount('state'), 0);
    assert.equal(manager.listenerCount('generation'), 0);
  } finally {
    await manager.close();
  }
});
