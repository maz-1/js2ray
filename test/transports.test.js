'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { once } = require('node:events');
const { connect, createListener } = require('../transports');
const { listen, readBytes } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');

for (const type of ['tcp', 'tls', 'ws', 'wss']) {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    test(
      `${type} transport: ${host}, separate connection/SNI/Host/path`,
      { timeout: 5000 },
      async (t) => {
        const secure = ['tls', 'wss'].includes(type);
        const network = {
          type: ['ws', 'wss'].includes(type) ? 'ws' : 'tcp',
          address: host,
          port: 0,
          option: {},
        };
        if (secure) network.option.tls = { cert, key };
        if (network.type === 'ws') {
          network.option.path = '/test?token=synthetic';
          network.option.headers = { Host: 'independent.test' };
        }
        const listener = createListener(network, (stream) => stream.pipe(stream), {
          maxConnections: 10,
          maxBufferBytes: 1024 * 1024,
          handshakeTimeoutMs: 1000,
        });
        const port = await listen(listener.server, host === 'localhost' ? '127.0.0.1' : host);
        t.after(
          () =>
            new Promise((resolve) => {
              listener.destroy();
              listener.server.close(resolve);
            }),
        );
        const clientNetwork = {
          ...network,
          port,
          option: {
            ...network.option,
            tls: secure ? { serverName: 'js2ray.test', ca: cert } : undefined,
          },
        };
        const lookup =
          host === 'localhost'
            ? (_name, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }])
            : undefined;
        const stream = await connect(clientNetwork, {
          lookup,
          connectTimeoutMs: 1000,
          handshakeTimeoutMs: 1000,
        });
        t.after(() => stream.destroy());
        stream.write(Buffer.from([0, 1, 255, 2]));
        assert.deepEqual(await readBytes(stream, 4), Buffer.from([0, 1, 255, 2]));
      },
    );
  }
}

test('TLS rejects untrusted certificates and incorrect certificate names', async (t) => {
  const listener = createListener(
    { type: 'tcp', option: { tls: { cert, key } } },
    (stream) => stream.destroy(),
    { handshakeTimeoutMs: 1000 },
  );
  const port = await listen(listener.server);
  t.after(
    () =>
      new Promise((resolve) => {
        listener.destroy();
        listener.server.close(resolve);
      }),
  );
  await assert.rejects(
    connect({
      type: 'tcp',
      address: '127.0.0.1',
      port,
      option: { tls: { serverName: 'js2ray.test' } },
    }),
    { code: 'ERR_TLS' },
  );
  await assert.rejects(
    connect({
      type: 'tcp',
      address: '127.0.0.1',
      port,
      option: { tls: { serverName: 'wrong.test', ca: cert } },
    }),
    { code: 'ERR_TLS' },
  );
});

test('failed WebSocket upgrade rejects before returning a stream', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(403);
    res.end();
  });
  const port = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  await assert.rejects(connect({ type: 'ws', address: '127.0.0.1', port }), {
    code: 'ERR_TRANSPORT',
  });
});

test('TLS handshake timeout and cancellation destroy unfinished connections', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  const network = {
    type: 'tcp',
    address: '127.0.0.1',
    port,
    option: { tls: { serverName: 'js2ray.test', ca: cert } },
  };
  await assert.rejects(connect(network, { handshakeTimeoutMs: 30 }), {
    code: 'ERR_TIMEOUT',
    phase: 'tls',
  });
  const controller = new AbortController();
  const attempt = connect(network, { signal: controller.signal });
  const rejected = assert.rejects(attempt, { code: 'ERR_CANCELLED' });
  setImmediate(() => controller.abort());
  await rejected;
});

test('WebSocket transport rejects text messages', async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => setTimeout(() => ws.send('text'), 20));
  const port = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(resolve);
      }),
  );
  const stream = await connect({ type: 'ws', address: '127.0.0.1', port });
  await new Promise((resolve) => stream.once('close', resolve));
  assert.equal(stream.destroyed, true);
});

module.exports = { cert, key };
test('WebSocket handles ping/pong, enforces message limit and completes bounded close', async (t) => {
  const WebSocket = require('ws');
  let accepted;
  const listener = createListener(
    { type: 'ws', option: { path: '/bound' } },
    (stream) => {
      accepted = stream;
    },
    { maxBufferBytes: 1024, handshakeTimeoutMs: 1000 },
  );
  const port = await listen(listener.server);
  t.after(() => {
    listener.destroy();
    return new Promise((resolve) => listener.server.close(resolve));
  });
  const peer = new WebSocket(`ws://127.0.0.1:${port}/bound`);
  peer.on('error', () => {});
  t.after(() => peer.terminate());
  await once(peer, 'open');
  const pong = once(peer, 'pong');
  peer.ping(Buffer.from('alive'));
  assert.equal((await pong)[0].toString(), 'alive');
  const ended = once(peer, 'close'),
    streamClosed = once(accepted, 'close');
  accepted.resume();
  accepted.end();
  await Promise.all([ended, streamClosed]);
  assert.equal(accepted.destroyed, true);
  const oversized = new WebSocket(`ws://127.0.0.1:${port}/bound`);
  oversized.on('error', () => {});
  t.after(() => oversized.terminate());
  await once(oversized, 'open');
  const closed = once(oversized, 'close');
  oversized.send(Buffer.alloc(1025));
  assert.equal((await closed)[0], 1009);
});
