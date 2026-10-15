'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { connect, createListener } = require('../transports');
const { checkConfig, createRuntime, createRuntimeManager, createHttpAgent } = require('..');
const { listen, readBytes, echo, httpServer } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');
const variants = [
  { name: 'HTTP/1.1', httpVersion: '1.1' },
  { name: 'TLS HTTP/1.1', httpVersion: '1.1', secure: true },
  { name: 'h2c', httpVersion: '2' },
  { name: 'TLS HTTP/2', httpVersion: '2', secure: true },
];
async function fixture(
  t,
  variant = variants[0],
  extra = {},
  accept = (stream) => stream.pipe(stream),
  limits = {},
) {
  const option = {
    path: '/xhttp?fixed=synthetic',
    host: 'independent.test',
    httpVersion: variant.httpVersion,
    ...extra,
  };
  const listener = createListener(
    { type: 'xhttp', option: { ...option, tls: variant.secure ? { cert, key } : undefined } },
    accept,
    { maxConnections: 32, maxBufferBytes: 1048576, handshakeTimeoutMs: 1000, ...limits },
  );
  const port = await listen(listener.server);
  t.after(() => {
    listener.destroy();
    return new Promise((resolve) => listener.server.close(resolve));
  });
  return {
    listener,
    network: {
      type: 'xhttp',
      address: '127.0.0.1',
      port,
      option: {
        ...option,
        tls: variant.secure ? { ca: cert, serverName: 'js2ray.test' } : undefined,
      },
    },
  };
}
for (const variant of variants)
  for (const mode of ['packet-up', 'stream-up', 'stream-one']) {
    test(
      `XHTTP ${variant.name} ${mode}: binary duplex, chunking and close`,
      { timeout: 5000 },
      async (t) => {
        const { listener, network } = await fixture(t, variant, { mode, scMaxEachPostBytes: 8192 });
        const stream = await connect(network, { handshakeTimeoutMs: 1000 });
        t.after(() => stream.destroy());
        const body = randomBytes(196613);
        const read = readBytes(stream, body.length);
        for (let offset = 0; offset < body.length; offset += 16384)
          await new Promise((resolve, reject) =>
            stream.write(body.subarray(offset, offset + 16384), (cause) =>
              cause ? reject(cause) : resolve(),
            ),
          );
        assert.deepEqual(await read, body);
        const closed = once(stream, 'close');
        stream.destroy();
        await closed;
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(listener.stats.sessions, 0);
        assert.equal(listener.stats.queuedBytes, 0);
      },
    );
  }
test('XHTTP native/V2Ray configuration validation and unsupported behavior diagnostics', () => {
  const native = (option) => ({
    outbounds: [
      {
        protocol: 'socks',
        networks: [{ type: 'xhttp', address: '127.0.0.1', port: 10080, option }],
      },
    ],
  });
  assert.equal(checkConfig(native({ mode: 'stream-up', httpVersion: '2' })).ok, true);
  for (const option of [
    { mode: 'unknown' },
    { httpVersion: '3' },
    { host: 'bad\r\nHost: other' },
    { xPaddingBytes: '1000-100' },
    { scMaxBufferedPosts: 0 },
    { headers: { Referer: 'http://override/' } },
    { xmux: {} },
    { downloadSettings: {} },
  ])
    assert.equal(checkConfig(native(option)).ok, false);
  const report = checkConfig({
    outbounds: [
      {
        protocol: 'socks',
        settings: { servers: [{ address: '127.0.0.1', port: 10080 }] },
        streamSettings: {
          network: 'xhttp',
          security: 'tls',
          tlsSettings: { serverName: 'js2ray.test', alpn: ['h2'] },
          xhttpSettings: {
            host: 'independent.test',
            path: '/xhttp',
            mode: 'stream-up',
            extra: { xPaddingBytes: '100-200' },
          },
        },
      },
    ],
  });
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.config.outbounds[0].networks[0].option.httpVersion, '2');
});
for (const variant of variants.filter((entry) => entry.secure)) {
  test(`XHTTP ${variant.name} strict TLS and independent names`, async (t) => {
    const { network } = await fixture(t, variant);
    await assert.rejects(
      connect({ ...network, option: { ...network.option, tls: { serverName: 'js2ray.test' } } }),
      { code: 'ERR_TLS' },
    );
    await assert.rejects(
      connect({
        ...network,
        option: { ...network.option, tls: { ca: cert, serverName: 'wrong.test' } },
      }),
      { code: 'ERR_TLS' },
    );
    await assert.rejects(
      connect({ ...network, option: { ...network.option, host: 'wrong.test' } }),
      { code: 'ERR_TRANSPORT' },
    );
  });
}
test('XHTTP timeout and cancellation release pending HTTP requests', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const network = { type: 'xhttp', address: '127.0.0.1', port };
  await assert.rejects(connect(network, { handshakeTimeoutMs: 30 }), { code: 'ERR_TIMEOUT' });
  const controller = new AbortController();
  const attempt = assert.rejects(connect(network, { signal: controller.signal }), {
    code: 'ERR_CANCELLED',
  });
  setTimeout(() => controller.abort(), 25);
  await attempt;
});
async function raw(network, suffix, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: network.address,
        port: network.port,
        path: '/xhttp/' + suffix,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: 'independent.test',
          referer: 'http://independent.test/?x_padding=' + 'X'.repeat(100),
          ...extra,
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end(body);
  });
}
test('XHTTP packet reassembly handles early/ordered uploads and rejects duplicate sequences', async (t) => {
  const { network, listener } = await fixture(t, variants[0], { mode: 'packet-up' });
  const id = randomUUID();
  let response = await raw(network, id + '/1', Buffer.from('B'));
  response.resume();
  assert.equal(response.statusCode, 200);
  response = await raw(network, id + '/0', Buffer.from('A'));
  response.resume();
  assert.equal(response.statusCode, 200);
  const down = await raw(network, id);
  t.after(() => down.destroy());
  assert.equal((await readBytes(down, 2)).toString(), 'AB');
  response = await raw(network, id + '/0', Buffer.from('duplicate'));
  response.resume();
  assert.equal(response.statusCode, 409);
  assert.equal(listener.stats.sessions, 1);
});
test('XHTTP rejects malformed requests, restricts sessions and expires unpaired uploads', async (t) => {
  const { network, listener } = await fixture(
    t,
    variants[0],
    { mode: 'packet-up', scMaxBufferedPosts: 2 },
    undefined,
    { maxConnections: 2, handshakeTimeoutMs: 80 },
  );
  for (const [suffix, body, headers, status] of [
    ['bad', '', {}, 400],
    [randomUUID() + '/0', '', { referer: 'http://independent.test/' }, 400],
    ['', '', {}, 400],
    [randomUUID() + '/9', '', {}, 429],
  ]) {
    const response = await raw(network, suffix, Buffer.from(body), headers);
    response.resume();
    assert.equal(response.statusCode, status);
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  for (let index = 0; index < 2; index++) {
    const response = await raw(network, randomUUID() + '/0', Buffer.from('pending'));
    response.resume();
    assert.equal(response.statusCode, 200);
  }
  const response = await raw(network, randomUUID() + '/0', Buffer.from('limited'));
  response.resume();
  assert.equal(response.statusCode, 429);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(listener.stats.pending, 0);
  assert.equal(listener.stats.sessions, 0);
  assert.equal(listener.stats.queuedBytes, 0);
});
test('XHTTP is usable through Runtime without a local client listener', async (t) => {
  const destination = await echo(t);
  const id = randomUUID();
  const server = createRuntime({
    inbounds: [
      {
        protocol: 'vless',
        users: [{ id }],
        networks: [{ type: 'xhttp', port: 0, option: { httpVersion: '2', mode: 'stream-up' } }],
      },
    ],
  });
  await server.start();
  t.after(() => server.close());
  const client = createRuntime({
    outbounds: [
      {
        protocol: 'vless',
        users: [{ id, encryption: 'none' }],
        networks: [
          {
            type: 'xhttp',
            address: '127.0.0.1',
            port: server.listenersInfo[0].address.port,
            option: { httpVersion: '2', mode: 'stream-up' },
          },
        ],
      },
    ],
  });
  await client.start();
  t.after(() => client.close());
  const stream = await client.dial(destination);
  stream.write('runtime-xhttp');
  assert.equal((await readBytes(stream, 13)).toString(), 'runtime-xhttp');
  assert.equal(client.stats.listeners, 0);
});

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Resources did not drain in time.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const version of ['auto', '1.1', '2']) {
  test(`XHTTP TLS ALPN and auto mode negotiate ${version}`, async (t) => {
    const { network } = await fixture(t, { httpVersion: 'auto', secure: true });
    const stream = await connect({
      ...network,
      option: { ...network.option, httpVersion: version },
    });
    t.after(() => stream.destroy());
    stream.write('auto-mode');
    assert.equal((await readBytes(stream, 9)).toString(), 'auto-mode');
  });
}
test('XHTTP HTTP/2 stream reset isolates other logical connections on the same session', async (t) => {
  const { network, listener } = await fixture(t, variants[2], { mode: 'stream-one' });
  const session = http2.connect(`http://127.0.0.1:${network.port}`);
  session.on('error', () => {});
  t.after(() => session.destroy());
  const requests = [];
  for (let index = 0; index < 2; index++) {
    const req = session.request({
      ':method': 'POST',
      ':path': '/xhttp/',
      ':authority': 'independent.test',
      referer: 'http://independent.test/?x_padding=' + 'X'.repeat(100),
    });
    req.on('error', () => {});
    requests.push(req);
    await once(req, 'response');
    req.write('separate-' + index);
    assert.equal((await readBytes(req, 10)).toString(), 'separate-' + index);
  }
  requests[0].close(http2.constants.NGHTTP2_CANCEL);
  await eventually(() => listener.stats.sessions === 1);
  requests[1].write('still-alive');
  assert.equal((await readBytes(requests[1], 11)).toString(), 'still-alive');
  session.destroy();
  await eventually(() => listener.stats.sessions === 0 && listener.stats.http2Sessions === 0);
});
for (const variant of [variants[0], variants[2]]) {
  test(`XHTTP ${variant.name} honors a slow readable consumer`, { timeout: 5000 }, async (t) => {
    const { network } = await fixture(
      t,
      variant,
      { mode: 'packet-up', scMaxEachPostBytes: 8192 },
      undefined,
      { maxBufferBytes: 65536 },
    );
    const stream = await connect(network, { maxBufferBytes: 65536, handshakeTimeoutMs: 2000 });
    t.after(() => stream.destroy());
    const body = randomBytes(262144);
    const writing = (async () => {
      for (let offset = 0; offset < body.length; offset += 8192)
        await new Promise((resolve, reject) =>
          stream.write(body.subarray(offset, offset + 8192), (cause) =>
            cause ? reject(cause) : resolve(),
          ),
        );
    })();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(stream.readableLength <= 65536);
    const reading = readBytes(stream, body.length);
    await writing;
    assert.deepEqual(await reading, body);
  });
}
test('XHTTP packet body, sequence gap and incomplete upload limits clean resources', async (t) => {
  const { network, listener } = await fixture(
    t,
    variants[0],
    { scMaxEachPostBytes: 1024 },
    undefined,
    { handshakeTimeoutMs: 80 },
  );
  let response = await raw(network, randomUUID() + '/0', Buffer.alloc(1025));
  response.resume();
  assert.equal(response.statusCode, 413);
  const id = randomUUID();
  const down = await raw(network, id);
  down.on('error', () => {});
  down.resume();
  t.after(() => down.destroy());
  response = await raw(network, id + '/1', Buffer.from('gap'));
  response.resume();
  assert.equal(response.statusCode, 200);
  await eventually(() => listener.stats.sessions === 0);
  const req = http.request({
    host: '127.0.0.1',
    port: network.port,
    method: 'POST',
    path: '/xhttp/' + randomUUID() + '/0',
    headers: {
      host: 'independent.test',
      referer: 'http://independent.test/?x_padding=' + 'X'.repeat(100),
      'content-length': '20',
    },
  });
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.write('unfinished');
  await eventually(() => listener.stats.sessions === 1);
  await eventually(() => listener.stats.sessions === 0);
  assert.equal(listener.stats.queuedBytes, 0);
});

test('XHTTP stream-up EOF before a matching downlink closes the pending session safely', async (t) => {
  const { network, listener } = await fixture(t, variants[0], { mode: 'stream-up' });
  const response = await raw(network, randomUUID(), Buffer.from('early-eof'));
  response.on('error', () => {});
  response.resume();
  assert.equal(response.statusCode, 200);
  await eventually(() => listener.stats.sessions === 0 && listener.stats.requests === 0);
});
test('XHTTP failed statuses and redirects never retry application bytes', async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' });
    res.end();
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(
    connect({ type: 'xhttp', address: '127.0.0.1', port }),
    (cause) => cause.code === 'ERR_TRANSPORT' && cause.context.status === 302,
  );
  assert.equal(requests, 1);
});
test('XHTTP packet acknowledgement timeout and cancellation settle pending writes', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.flushHeaders();
    if (req.method === 'POST') req.resume();
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const network = { type: 'xhttp', address: '127.0.0.1', port };
  const stream = await connect(network, { handshakeTimeoutMs: 60 });
  const timed = new Promise((resolve) => stream.write('waiting', (cause) => resolve(cause)));
  assert.equal((await timed).code, 'ERR_TIMEOUT');
  const controller = new AbortController();
  const cancelled = await connect(network, { signal: controller.signal });
  const writing = new Promise((resolve) => cancelled.write('cancel-me', (cause) => resolve(cause)));
  setTimeout(() => controller.abort(), 20);
  assert.equal((await writing).code, 'ERR_CANCELLED');
});
test('XHTTP send queue rejects writes beyond the configured bound', async (t) => {
  const { network } = await fixture(t);
  const stream = await connect(network, { maxBufferBytes: 1024 });
  const cause = await new Promise((resolve) => stream.write(Buffer.alloc(1025), resolve));
  assert.equal(cause.code, 'ERR_LIMIT');
  assert.equal(stream.destroyed, true);
});
test('XHTTP rejects ALPN and mode mismatches', async (t) => {
  const { network } = await fixture(t, variants[1], { mode: 'packet-up' });
  await assert.rejects(connect({ ...network, option: { ...network.option, httpVersion: '2' } }), {
    code: 'ERR_TLS',
  });
  await assert.rejects(connect({ ...network, option: { ...network.option, mode: 'stream-one' } }), {
    code: 'ERR_TRANSPORT',
  });
});

test(
  'XHTTP 100 concurrent TLS connections cover all modes and release every resource',
  { timeout: 10000 },
  async (t) => {
    const fixtures = await Promise.all([
      fixture(t, variants[1], {}, undefined, { maxConnections: 128 }),
      fixture(t, variants[3], {}, undefined, { maxConnections: 128 }),
    ]);
    const clients = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const { network } = fixtures[index % 2];
        return connect({
          ...network,
          option: { ...network.option, mode: ['packet-up', 'stream-up', 'stream-one'][index % 3] },
        });
      }),
    );
    t.after(() => {
      for (const client of clients) client.destroy();
    });
    assert.equal(
      fixtures.reduce((sum, item) => sum + item.listener.stats.sessions, 0),
      100,
    );
    await Promise.all(
      clients.map(async (client, index) => {
        const body = Buffer.concat([Buffer.from(`client-${index}:`), randomBytes(8192)]);
        for (let round = 0; round < 4; round++) {
          const received = readBytes(client, body.length);
          client.write(body);
          if (index % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 10));
          assert.deepEqual(await received, body);
        }
        client.destroy();
      }),
    );
    await eventually(() =>
      fixtures.every(({ listener }) => Object.values(listener.stats).every((value) => value === 0)),
    );
  },
);

test('XHTTP same-port rotation retains packet sessions and replaces path, UUID and TLS certificate', async (t) => {
  const target = await echo(t);
  const firstId = randomUUID(),
    nextId = randomUUID();
  const nextCert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/rotated-cert.pem'), 'utf8');
  const nextKey = fs.readFileSync(path.join(__dirname, 'fixtures/tls/rotated-key.pem'), 'utf8');
  const config = (id, path, cert, key) => ({
    inbounds: [
      {
        tag: 'xhttp',
        protocol: 'vless',
        users: [{ id }],
        networks: [
          {
            type: 'xhttp',
            port: 0,
            option: { path, mode: 'packet-up', httpVersion: '2', tls: { cert, key } },
          },
        ],
      },
    ],
  });
  const manager = createRuntimeManager(config(firstId, '/before', cert, key));
  await manager.start();
  t.after(() => manager.close());
  const port = manager.listenersInfo[0].address.port;
  async function client(id, path, ca, serverName = 'js2ray.test') {
    const runtime = createRuntime({
      outbounds: [
        {
          protocol: 'vless',
          users: [{ id, encryption: 'none' }],
          networks: [
            {
              type: 'xhttp',
              address: '127.0.0.1',
              port,
              option: {
                path,
                mode: 'packet-up',
                httpVersion: '2',
                tls: { ca, serverName },
              },
            },
          ],
        },
      ],
    });
    await runtime.start();
    t.after(() => runtime.close());
    return runtime;
  }
  const oldClient = await client(firstId, '/before', cert);
  const held = await oldClient.dial(target);
  held.write('before');
  await readBytes(held, 6);
  const cutover = await manager.rotate(config(nextId, '/after', nextCert, nextKey), {
    drainTimeoutMs: 2000,
  });
  assert.equal(manager.listenersInfo[0].address.port, port);
  held.write('retained');
  assert.equal((await readBytes(held, 8)).toString(), 'retained');
  const nextClient = await client(nextId, '/after', nextCert, 'js2ray-rotated.test');
  const fresh = await nextClient.dial(target);
  fresh.write('fresh');
  assert.equal((await readBytes(fresh, 5)).toString(), 'fresh');
  fresh.destroy();
  held.destroy();
  await cutover.drained;
  await assert.rejects(oldClient.dial(target), { code: 'ERR_TLS' });
});
for (const protocol of ['vless', 'vmess']) {
  test(`XHTTP transports ${protocol} and the public HTTP Agent`, async (t) => {
    const target = await httpServer(t);
    const id = randomUUID();
    const users = [
      { id, ...(protocol === 'vless' ? { encryption: 'none' } : { security: 'aes-128-gcm' }) },
    ];
    const server = createRuntime({
      inbounds: [
        {
          protocol,
          users,
          networks: [{ type: 'xhttp', port: 0, option: { mode: 'stream-one', httpVersion: '2' } }],
        },
      ],
    });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [
        {
          protocol,
          users,
          networks: [
            {
              type: 'xhttp',
              address: '127.0.0.1',
              port: server.listenersInfo[0].address.port,
              option: { mode: 'stream-one', httpVersion: '2' },
            },
          ],
        },
      ],
    });
    await client.start();
    t.after(() => client.close());
    const agent = createHttpAgent(client);
    t.after(() => agent.destroy());
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${target.port}/`, { agent }, (res) => {
        const chunks = [];
        res.on('data', (data) => chunks.push(data));
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on('error', reject);
    });
    assert.equal(body, 'hello through runtime');
    assert.equal(client.stats.listeners, 0);
  });
}
