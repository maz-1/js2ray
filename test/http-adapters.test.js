'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const { once } = require('node:events');
const undici = require('undici');
const {
  createRuntime,
  createHttpAgent,
  createHttpsAgent,
  createUndiciConnector,
  createUndiciDispatcher,
} = require('..');
const { listen } = require('./helpers');
const { id } = require('./fixtures/reverse');
const cert = fs.readFileSync(require.resolve('./fixtures/tls/cert.pem'), 'utf8'),
  key = fs.readFileSync(require.resolve('./fixtures/tls/key.pem'), 'utf8');
async function origins(t) {
  const body = Buffer.alloc(2 * 1024 * 1024, 42);
  let connections = 0;
  const handler = (req, res) => {
    if (req.url === '/wait') return;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://localhost:${plain.address().port}/data` });
      res.end();
    } else res.end(body);
  };
  const plain = http.createServer(handler),
    secure = https.createServer({ cert, key }, handler);
  plain.on('connection', () => connections++);
  await listen(plain);
  await listen(secure);
  t.after(async () => {
    for (const server of [plain, secure]) server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => plain.close(resolve)),
      new Promise((resolve) => secure.close(resolve)),
    ]);
  });
  return {
    plain: `http://127.0.0.1:${plain.address().port}`,
    secure: `https://127.0.0.1:${secure.address().port}`,
    body,
    connections: () => connections,
  };
}
function get(url, options) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () =>
        resolve({
          status: res.statusCode,
          location: res.headers.location,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.once('error', reject);
  });
}
for (const protocol of ['freedom', 'vless-mux', 'vmess']) {
  test(`${protocol}: public Node agents and optional Undici dispatcher use actual virtual streams`, async (t) => {
    const origin = await origins(t);
    let outbounds;
    if (protocol !== 'freedom') {
      const peerProtocol = protocol === 'vless-mux' ? 'vless' : 'vmess';
      const peer = createRuntime({
        inbounds: [{ protocol: peerProtocol, users: [{ id }], networks: [{ port: 0 }] }],
      });
      await peer.start();
      t.after(() => peer.close());
      outbounds = [
        {
          protocol: peerProtocol,
          users: peerProtocol === 'vless' ? [{ id, encryption: 'none' }] : [{ id }],
          networks: [{ address: '127.0.0.1', port: peer.listenersInfo[0].address.port }],
          ...(peerProtocol === 'vless' ? { mux: { enabled: true } } : {}),
        },
      ];
    }
    const runtime = createRuntime({ outbounds });
    await runtime.start();
    t.after(() => runtime.close());
    const agent = createHttpAgent(runtime),
      secureAgent = createHttpsAgent(runtime, {
        targetTls: { ca: cert, serverName: 'js2ray.test' },
      });
    t.after(() => {
      agent.destroy();
      secureAgent.destroy();
    });
    assert.deepEqual((await get(origin.plain, { agent })).body, origin.body);
    assert.deepEqual((await get(origin.plain, { agent })).body, origin.body);
    assert.deepEqual((await get(origin.secure, { agent: secureAgent })).body, origin.body);
    const redirect = await get(origin.plain + '/redirect', { agent });
    assert.deepEqual((await get(redirect.location, { agent })).body, origin.body);
    const dispatcher = createUndiciDispatcher(runtime, {
      undici,
      targetTls: { ca: cert, serverName: 'js2ray.test' },
    });
    t.after(() => dispatcher.destroy());
    const response = await undici.fetch(origin.plain + '/redirect', { dispatcher });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), origin.body);
    const secure = await undici.fetch(origin.secure, { dispatcher });
    assert.deepEqual(Buffer.from(await secure.arrayBuffer()), origin.body);
    assert.equal(runtime.listenersInfo.length, 0);
    await dispatcher.close();
    await runtime.close();
    assert.equal(runtime.stats.connections, 0);
  });
}
test('Node pooling isolates targets and adapter scopes; invalid certificate and cancellation reject', async (t) => {
  const origin = await origins(t),
    runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const agent = createHttpAgent(runtime, { maxSockets: 1 }),
    second = createHttpAgent(runtime),
    secure = createHttpsAgent(runtime);
  t.after(() => {
    agent.destroy();
    second.destroy();
    secure.destroy();
  });
  await get(origin.plain, { agent });
  await get(origin.plain, { agent });
  assert.equal(origin.connections(), 1);
  await get(origin.plain, { agent: second });
  assert.equal(origin.connections(), 2);
  await assert.rejects(get(origin.secure, { agent: secure }), { code: 'ERR_TLS' });
  const controller = new AbortController(),
    waiting = get(origin.plain + '/wait', { agent, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const dispatcher = createUndiciDispatcher(runtime, { undici });
  t.after(() => dispatcher.destroy());
  await assert.rejects(undici.fetch(origin.secure, { dispatcher }));
  const waiting2 = undici.fetch(origin.plain + '/wait', {
    dispatcher,
    signal: AbortSignal.timeout(30),
  });
  await assert.rejects(waiting2, { name: 'TimeoutError' });
});
test('connection and target TLS share a deadline; destroy cancels pending dials exactly once', async (t) => {
  const held = new Set(),
    server = net.createServer((socket) => {
      held.add(socket);
      socket.once('close', () => held.delete(socket));
    });
  const port = await listen(server);
  t.after(async () => {
    for (const socket of held) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const agent = createHttpsAgent(runtime, { timeoutMs: 30 });
  t.after(() => agent.destroy());
  await assert.rejects(get(`https://127.0.0.1:${port}`, { agent }), { code: 'ERR_TIMEOUT' });
  const lookupRuntime = createRuntime({}, { lookup() {} });
  await lookupRuntime.start();
  t.after(() => lookupRuntime.close());
  const open = createUndiciConnector(lookupRuntime);
  let calls = 0;
  const result = new Promise((resolve) =>
    open({ hostname: 'pending.test', port: '80', protocol: 'http:' }, (error) => {
      calls++;
      resolve(error);
    }),
  );
  open.destroy();
  assert.equal((await result).code, 'ERR_CANCELLED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const pendingAgent = createHttpAgent(lookupRuntime);
  t.after(() => pendingAgent.destroy());
  const controller = new AbortController();
  const request = get('http://pending.test', { agent: pendingAgent, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookupRuntime.stats.pendingDials, 0);
});
