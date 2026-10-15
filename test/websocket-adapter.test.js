'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { createRuntime, createWebSocket, Js2rayError } = require('..');
const { listen } = require('./helpers');
const { id } = require('./fixtures/reverse');
const cert = fs.readFileSync(require.resolve('./fixtures/tls/cert.pem'));
const key = fs.readFileSync(require.resolve('./fixtures/tls/key.pem'));
async function origin(t, secure) {
  const server = secure ? https.createServer({ cert, key }) : http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/stall') return;
    if (request.headers.authorization !== 'Bearer synthetic') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const port = await listen(server);
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return `${secure ? 'wss' : 'ws'}://127.0.0.1:${port}/chat`;
}
for (const protocol of ['freedom', 'vmess', 'vless-mux']) {
  test(`${protocol}: application WS/WSS Upgrade, protocol, text/binary, heartbeat and close`, async (t) => {
    let outbounds;
    if (protocol !== 'freedom') {
      const wire = protocol === 'vless-mux' ? 'vless' : 'vmess';
      const peer = createRuntime({
        inbounds: [{ protocol: wire, users: [{ id }], networks: [{ port: 0 }] }],
      });
      await peer.start();
      t.after(() => peer.close());
      outbounds = [
        {
          protocol: wire,
          users: [{ id, ...(wire === 'vless' ? { encryption: 'none' } : {}) }],
          networks: [{ address: '127.0.0.1', port: peer.listenersInfo[0].address.port }],
          ...(wire === 'vless' ? { mux: { enabled: true } } : {}),
        },
      ];
    }
    const runtime = createRuntime({ outbounds });
    await runtime.start();
    t.after(() => runtime.close());
    for (const secure of [false, true]) {
      const url = await origin(t, secure);
      const ws = createWebSocket(runtime, url, {
        protocols: ['chat'],
        headers: { Authorization: 'Bearer synthetic' },
        targetTls: { ca: cert, serverName: 'js2ray.test' },
      });
      t.after(() => ws.terminate());
      await once(ws, 'open');
      assert.equal(ws.protocol, 'chat');
      for (const payload of ['hello 世界', Buffer.alloc(256 * 1024, 0xab)]) {
        const received = once(ws, 'message');
        ws.send(payload);
        const [data, binary] = await received;
        assert.deepEqual(data, Buffer.from(payload));
        assert.equal(binary, Buffer.isBuffer(payload));
      }
      const pong = once(ws, 'pong');
      ws.ping('alive');
      assert.equal((await pong)[0].toString(), 'alive');
      const closed = once(ws, 'close');
      ws.close(1000, 'complete');
      assert.equal((await closed)[0], 1000);
    }
    assert.equal(runtime.listenersInfo.length, 0);
  });
}
test('application WebSocket rejects authentication, bad TLS, invalid URL and send limits; abort/close cleans resources', async (t) => {
  const runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const plain = await origin(t, false),
    secure = await origin(t, true);
  const rejected = createWebSocket(runtime, plain);
  assert.equal(
    (await new Promise((resolve) => rejected.once('error', resolve))).code,
    'ERR_WS_UPGRADE',
  );
  const untrusted = createWebSocket(runtime, secure, {
    headers: { Authorization: 'Bearer synthetic' },
  });
  assert.equal((await new Promise((resolve) => untrusted.once('error', resolve))).code, 'ERR_TLS');
  assert.throws(() => createWebSocket(runtime, 'ws://user:secret@example.com/'), {
    code: 'ERR_TARGET',
  });
  const abort = new AbortController();
  const ws = createWebSocket(runtime, plain, {
    signal: abort.signal,
    maxBufferBytes: 8,
    headers: { Authorization: 'Bearer synthetic' },
  });
  await once(ws, 'open');
  assert.throws(() => ws.send(Buffer.alloc(9)), { code: 'ERR_LIMIT' });
  const error = new Promise((resolve) => ws.once('error', resolve));
  const closed = new Promise((resolve) => ws.once('close', resolve));
  abort.abort();
  assert.ok((await error) instanceof Js2rayError);
  await closed;
  await runtime.close();
  assert.equal(runtime.stats.connections, 0);
});
test('WebSocket pending Upgrade timeout/abort, receive limit and runtime close are bounded', async (t) => {
  const runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const url = await origin(t, false),
    headers = { Authorization: 'Bearer synthetic' };
  const stalled = createWebSocket(runtime, url.replace('/chat', '/stall'), {
    timeoutMs: 40,
    headers,
  });
  assert.equal(
    (await new Promise((resolve) => stalled.once('error', resolve))).code,
    'ERR_TIMEOUT',
  );
  const abort = new AbortController();
  const pending = createWebSocket(runtime, url, { signal: abort.signal, headers });
  const cancelled = new Promise((resolve) => pending.once('error', resolve));
  abort.abort();
  assert.equal((await cancelled).code, 'ERR_CANCELLED');
  const limited = createWebSocket(runtime, url, { headers, maxPayload: 32 });
  await once(limited, 'open');
  const overflow = new Promise((resolve) => limited.once('error', resolve));
  limited.send(Buffer.alloc(64));
  assert.equal((await overflow).code, 'ERR_LIMIT');
  const live = createWebSocket(runtime, url, { headers });
  await once(live, 'open');
  const closed = new Promise((resolve) => live.once('close', resolve));
  await runtime.close();
  await closed;
  assert.equal(runtime.stats.connections, 0);
});
