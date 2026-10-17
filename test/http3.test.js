'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { isBuiltin } = require('node:module');
const { createHash } = require('node:crypto');
const { createListener, connect } = require('../transports');
const { XmuxPool } = require('../transports/xhttp/xmux');
const { checkConfig, createRuntime, createRuntimeManager } = require('..');
const { listen, readBytes, echo } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');
const available = isBuiltin('node:quic');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const net = (option) => ({
  type: 'xhttp',
  address: '127.0.0.1',
  port: 443,
  option: { httpVersion: '3', tls: {}, ...option },
});
const config = (network) => ({
  outbounds: [{ protocol: 'vless', users: [{ id, encryption: 'none' }], networks: [network] }],
});
const quic = available ? require('node:quic') : undefined;
const baseline = quic?.listEndpoints({ active: false }).length;
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'bounded resource recovery');
}
test.after(async () => {
  if (available) await eventually(() => quic.listEndpoints({ active: false }).length === baseline);
});
async function fixture(t, mode = 'stream-one', accept = (stream) => stream.pipe(stream)) {
  const option = { httpVersion: '3', mode, path: '/h3/', host: 'route.test', xPaddingBytes: 100 };
  const listener = createListener(net({ ...option, tls: { cert, key } }), accept, {
    handshakeTimeoutMs: 1000,
  });
  const port = await listen(listener.server);
  t.after(() => {
    listener.destroy();
    return new Promise((resolve) => listener.server.close(resolve));
  });
  return {
    listener,
    network: { ...net({ ...option, tls: { ca: cert, serverName: 'js2ray.test' } }), port },
  };
}
test('HTTP/3 schema selection remains pure and strict', () => {
  assert.equal(checkConfig(config(net())).ok, true);
  for (const option of [{ tls: undefined }, { xmux: { hKeepAlivePeriod: 10 } }])
    assert.equal(checkConfig(config(net(option))).ok, false);
  for (const alpn of [['h3'], ['h2', 'http/1.1'], ['h3', 'h2'], ['h3', 'http/1.1']]) {
    const report = checkConfig({
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [{ address: '127.0.0.1', port: 443, users: [{ id, encryption: 'none' }] }],
          },
          streamSettings: { network: 'xhttp', security: 'tls', tlsSettings: { alpn } },
        },
      ],
    });
    assert.equal(
      report.ok,
      !alpn.includes('h3') || alpn.length === 1,
      JSON.stringify(report.diagnostics),
    );
    if (report.ok)
      assert.equal(
        report.config.outbounds[0].networks[0].option.httpVersion,
        alpn[0] === 'h3' ? '3' : 'auto',
      );
  }
});
test(
  'HTTP/3 unavailable runtime guards unused, inbound and split download before resources',
  { skip: available },
  () => {
    for (const value of [
      config(net()),
      {
        inbounds: [{ protocol: 'vless', users: [{ id }], networks: [net({ tls: { cert, key } })] }],
      },
      config(net({ httpVersion: '2', downloadSettings: net() })),
    ]) {
      assert.equal(checkConfig(value).ok, true);
      assert.throws(
        () => createRuntime(value),
        (cause) =>
          cause.code === 'ERR_UNSUPPORTED' &&
          cause.phase === 'http3' &&
          /--experimental-quic/.test(cause.message),
      );
    }
  },
);
for (const mode of ['stream-one', 'stream-up', 'packet-up', 'auto']) {
  test(
    `HTTP/3 ${mode}: real headers, binary DATA and bounded cleanup`,
    { skip: !available, timeout: 6000 },
    async (t) => {
      const { network, listener } = await fixture(t, mode);
      const stream = await connect(network, { handshakeTimeoutMs: 1000 });
      t.after(() => stream.destroy());
      const body = Buffer.alloc(196613, 73);
      const read = readBytes(stream, body.length);
      for (let i = 0; i < body.length; i += 16384)
        await new Promise((yes, no) =>
          stream.write(body.subarray(i, i + 16384), (cause) => (cause ? no(cause) : yes())),
        );
      assert.deepEqual(await read, body);
      assert.equal(listener.stats.http3Sessions, 1);
      stream.destroy();
      await eventually(() => listener.stats.sessions === 0);
    },
  );
}
test(
  'HTTP/3 stream-one FIN half-close returns full body and actual EOF',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { network } = await fixture(t);
    const stream = await connect(network);
    t.after(() => stream.destroy());
    const received = (async () => {
      const chunks = [];
      for await (const data of stream) chunks.push(data);
      return Buffer.concat(chunks);
    })();
    const body = Buffer.alloc(262147, 42);
    stream.end(body);
    assert.deepEqual(await received, body);
  },
);
test(
  'HTTP/3 trusted TLS, wrong CA/name and HTTP rejection status/path',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { network } = await fixture(t);
    for (const tls of [{ serverName: 'js2ray.test' }, { ca: cert, serverName: 'wrong.test' }])
      await assert.rejects(connect({ ...network, option: { ...network.option, tls } }), {
        code: 'ERR_TLS',
      });
    for (const option of [{ host: 'wrong.test' }, { path: '/wrong/' }])
      await assert.rejects(
        connect({ ...network, option: { ...network.option, ...option } }),
        (cause) => cause.code === 'ERR_TRANSPORT' && cause.context.status === 404,
      );
  },
);
test(
  'HTTP/3 XMUX shared session independent cancellation and empty GET EOF',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { network } = await fixture(t);
    const pool = new XmuxPool(network, { handshakeTimeoutMs: 1000 }, () => {
      throw Error('H3 must not TCP dial');
    });
    t.after(() => pool.close());
    const a = await connect(network, { xhttpPool: pool });
    const b = await connect(network, { xhttpPool: pool });
    t.after(() => b.destroy());
    assert.equal(pool.stats.created, 1);
    a.destroy();
    const data = once(b, 'data');
    b.write('sibling');
    assert.equal((await data)[0].toString(), 'sibling');
    assert.equal(pool.entries.values().next().value.version, '3');
    const lease = await pool.acquire();
    const req = lease.entry.request({
      ':method': 'GET',
      ':scheme': 'https',
      ':authority': 'route.test',
      ':path': '/missing',
    });
    const headers = await once(req, 'response');
    assert.equal(headers[0][':status'], 404);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 0);
    lease.release();
  },
);

async function exchange(stream, body, eof = false) {
  const reading = eof
    ? (async () => {
        const chunks = [];
        for await (const data of stream) chunks.push(data);
        return Buffer.concat(chunks);
      })()
    : readBytes(stream, body.length);
  reading.catch(() => {});
  try {
    for (let i = 0; i < body.length; i += 16384)
      await new Promise((yes, no) =>
        stream.write(body.subarray(i, i + 16384), (cause) => (cause ? no(cause) : yes())),
      );
    if (eof) stream.end();
    const received = await reading;
    assert.equal(received.length, body.length, 'complete payload length before EOF');
    assert.equal(
      createHash('sha256').update(received).digest('hex'),
      createHash('sha256').update(body).digest('hex'),
    );
  } catch (cause) {
    stream.destroy();
    await reading.catch(() => {});
    throw cause;
  }
}
for (const protocol of ['vless', 'vmess'])
  for (const mode of ['stream-one', 'stream-up', 'packet-up', 'auto']) {
    test(
      `HTTP/3 Runtime ${protocol} ${mode}: concurrent 2MiB ${mode === 'packet-up' ? 'payload' : 'payload+FIN EOF'}`,
      { skip: !available, timeout: 12000 },
      async (t) => {
        const target = await echo(t);
        const server = createRuntime({
          inbounds: [
            {
              protocol,
              users: [{ id }],
              networks: [{ ...net({ mode, tls: { cert, key } }), port: 0 }],
            },
          ],
        });
        t.after(() => server.close({ drainTimeoutMs: 0 }));
        await server.start();
        const client = createRuntime({
          outbounds: [
            {
              protocol,
              users: [{ id, ...(protocol === 'vless' ? { encryption: 'none' } : {}) }],
              networks: [
                {
                  ...net({ mode, tls: { ca: cert, serverName: 'js2ray.test' } }),
                  port: server.listenersInfo[0].address.port,
                },
              ],
            },
          ],
        });
        t.after(() => client.close({ drainTimeoutMs: 0 }));
        await client.start();
        const streams = await Promise.all([
          client.dial(target),
          client.dial(target),
          client.dial(target),
        ]);
        t.after(() => streams.forEach((stream) => stream.destroy()));
        const results = await Promise.allSettled(
          streams.map((stream, n) =>
            exchange(stream, Buffer.alloc(2 * 1024 * 1024, 40 + n), mode !== 'packet-up'),
          ),
        );
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        for (const stream of streams) stream.destroy();
        assert.equal(client.metrics.xhttp.created, 1);
        await client.close({ drainTimeoutMs: 0 });
        assert.equal(client.metrics.xhttp.clients, 0);
        await eventually(() => server.stats.connections === 0);
      },
    );
  }
test(
  'HTTP/3 complete stream metadata and late response after request FIN',
  { skip: !available, timeout: 6000 },
  async (t) => {
    let metadata;
    const { network } = await fixture(t, 'stream-one', (stream) => {
      metadata = [stream.remoteAddress, stream.remotePort, stream.localAddress, stream.localPort];
      stream.on('data', () => {});
      stream.once('end', () => setTimeout(() => stream.end('after-fin'), 20));
    });
    const stream = await connect(network);
    t.after(() => stream.destroy());
    const reading = (async () => {
      const chunks = [];
      for await (const data of stream) chunks.push(data);
      return Buffer.concat(chunks);
    })();
    stream.end('request');
    assert.equal((await reading).toString(), 'after-fin');
    assert.equal(metadata[0], '127.0.0.1');
    assert.ok(metadata[1] > 0);
    assert.equal(metadata[2], '127.0.0.1');
    assert.equal(metadata[3], network.port);
  },
);
test(
  'HTTP/3 listener closes and restarts with native endpoint baseline recovery',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { listener, network } = await fixture(t);
    const endpointCount = quic.listEndpoints({ active: false }).length;
    const stream = await connect(network);
    await exchange(stream, Buffer.from('before-restart'));
    stream.destroy();
    listener.destroy();
    await new Promise((resolve) => listener.server.close(resolve));
    const port = await listen(listener.server);
    const after = await connect({ ...network, port });
    t.after(() => after.destroy());
    await exchange(after, Buffer.from('after-restart'), true);
    after.destroy();
    await eventually(() => quic.listEndpoints({ active: false }).length === endpointCount);
  },
);
test(
  'HTTP/3 split download uses independent H3/H3 pools on the same listener',
  { skip: !available, timeout: 8000 },
  async (t) => {
    // Two listeners share XHTTP pairing only when they are the same listener;
    // separate transport endpoints here deliberately point to one h3 listener.
    const { network } = await fixture(t, 'auto');
    for (const mode of ['stream-up', 'packet-up', 'auto']) {
      const up = {
        ...network,
        option: { ...network.option, mode, downloadSettings: structuredClone(network) },
      };
      const stream = await connect(up);
      t.after(() => stream.destroy());
      await exchange(stream, Buffer.alloc(98321, 81));
      stream.destroy();
    }
  },
);
test(
  'HTTP/3 RuntimeManager limit rejection and TLS/path/credential rotation',
  { skip: !available, timeout: 8000 },
  async (t) => {
    const target = await echo(t);
    const rotatedCert = fs.readFileSync(
      path.join(__dirname, 'fixtures/tls/rotated-cert.pem'),
      'utf8',
    );
    const rotatedKey = fs.readFileSync(
      path.join(__dirname, 'fixtures/tls/rotated-key.pem'),
      'utf8',
    );
    const nextId = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
    const serverConfig = (route, rotated = false) => ({
      inbounds: [
        {
          protocol: 'vless',
          users: [{ id: rotated ? nextId : id }],
          networks: [
            {
              ...net({
                path: route,
                mode: 'stream-one',
                tls: rotated ? { cert: rotatedCert, key: rotatedKey } : { cert, key },
              }),
              port: 0,
            },
          ],
        },
      ],
    });
    const manager = createRuntimeManager(serverConfig('/before/'));
    t.after(() => manager.close());
    await manager.start();
    const port = manager.listenersInfo[0].address.port;
    const clientFor = async (route, rotated = false, user = rotated ? nextId : id) => {
      const value = config({
        ...net({
          path: route,
          mode: 'stream-one',
          tls: rotated
            ? { ca: rotatedCert, serverName: 'js2ray-rotated.test' }
            : { ca: cert, serverName: 'js2ray.test' },
        }),
        port,
      });
      value.outbounds[0].users[0].id = user;
      const client = createRuntime(value);
      t.after(() => client.close({ drainTimeoutMs: 0 }));
      await client.start();
      return client;
    };
    const before = await clientFor('/before/');
    const held = await before.dial(target);
    t.after(() => held.destroy());
    await exchange(held, Buffer.from('before'));
    await assert.rejects(
      manager.rotate({ ...serverConfig('/rejected/'), limits: { maxConnections: 7 } }),
      { code: 'ERR_ROTATION' },
    );
    await exchange(held, Buffer.from('after-rejected-update'));
    const rotation = await manager.rotate(serverConfig('/after/', true), { drainTimeoutMs: 2000 });
    assert.equal(manager.listenersInfo[0].address.port, port);
    await exchange(held, Buffer.from('retained'));
    const after = await clientFor('/after/', true);
    const fresh = await after.dial(target);
    t.after(() => fresh.destroy());
    await exchange(fresh, Buffer.from('fresh'), true);
    held.destroy();
    await rotation.drained;
    await assert.rejects(
      before.dial(target),
      (cause) => cause.code === 'ERR_TRANSPORT' && cause.context.status === 404,
    );
    await manager.close();
    await after.close({ drainTimeoutMs: 0 });
    await before.close({ drainTimeoutMs: 0 });
  },
);

test(
  'HTTP/3 waits real peer stream credit with one deadline and destroys pending raw',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { createPrivateKey } = require('node:crypto');
    for (const [mode, credit] of [
      ['stream-one', 1],
      ['stream-up', 1],
      ['stream-up', 2],
    ]) {
      const received = [];
      const endpoint = await quic.listen(() => {}, {
        sni: { '*': { keys: createPrivateKey(key), certs: Buffer.from(cert) } },
        transportParams: { initialMaxStreamsBidi: credit },
        onheaders: function (headers) {
          received.push(headers[':method']);
          this.closed.catch(() => {});
          this.sendHeaders({ ':status': '200' });
        },
      });
      const network = {
        ...net({ mode, tls: { ca: cert, serverName: 'js2ray.test' } }),
        port: endpoint.address.port,
      };
      const pool = new XmuxPool(network, { handshakeTimeoutMs: 100 }, () => {
        throw Error('TCP fallback');
      });
      try {
        const stream = await connect(network, { xhttpPool: pool, handshakeTimeoutMs: 100 });
        stream.on('error', () => {});
        if (mode === 'stream-up' && credit === 1) {
          const outcome = await once(stream, 'close').then(
            () => undefined,
            (cause) => cause,
          );
          assert.equal(outcome?.code, 'ERR_TIMEOUT');
          assert.deepEqual(received, ['GET'], 'pending POST must not send or replay headers');
        } else {
          await eventually(() => received.length === (mode === 'stream-one' ? 1 : 2));
          stream.destroy();
        }
      } finally {
        pool.close();
        endpoint.destroy();
        await endpoint.closed.catch(() => {});
      }
    }
  },
);
test(
  'HTTP/3 DNS/handshake cancellation, header deadlines and early rejected slow POST are bounded',
  { skip: !available, timeout: 6000 },
  async (t) => {
    await assert.rejects(
      connect(
        { ...net({ tls: { ca: cert, serverName: 'js2ray.test' } }), address: 'unresolved.test' },
        { lookup: () => {}, connectTimeoutMs: 30 },
      ),
      { code: 'ERR_TIMEOUT' },
    );
    const controller = new AbortController();
    const attempt = assert.rejects(connect({ ...net(), port: 9 }, { signal: controller.signal }), {
      code: 'ERR_CANCELLED',
    });
    controller.abort();
    await attempt;
    const option = { httpVersion: '3', tls: { cert, key }, path: '/h3/', xPaddingBytes: 100 };
    const listener = createListener(net(option), (stream) => stream.pipe(stream), {
      handshakeTimeoutMs: 80,
    });
    const port = await listen(listener.server);
    t.after(() => listener.destroy());
    const endpoint = new quic.QuicEndpoint();
    t.after(() => endpoint.destroy());
    endpoint.closed.catch(() => {});
    const silent = await quic.connect(`127.0.0.1:${port}`, {
      endpoint,
      ca: Buffer.from(cert),
      servername: 'js2ray.test',
    });
    silent.closed.catch(() => {});
    await silent.opened;
    await eventually(() => silent.destroyed);
    const session = await quic.connect(`127.0.0.1:${port}`, {
      endpoint,
      ca: Buffer.from(cert),
      servername: 'js2ray.test',
    });
    session.closed.catch(() => {});
    await session.opened;
    const req = require('../transports/xhttp/h3').request(
      session,
      { ':method': 'POST', ':path': '/missing', ':scheme': 'https', ':authority': 'route.test' },
      { handshakeTimeoutMs: 200 },
    );
    req.on('error', () => {});
    assert.equal((await once(req, 'response'))[0][':status'], 404);
    req.resume();
    await eventually(() => listener.stats.http3Requests === 0);
    session.destroy(undefined, { code: 0x100, type: 'application' });
  },
);
test(
  'HTTP/3 server-only destroy promptly notifies a still-running shared client',
  { skip: !available, timeout: 6000 },
  async (t) => {
    const { listener, network } = await fixture(t);
    const pool = new XmuxPool(network, {}, () => {
      throw Error('TCP fallback');
    });
    t.after(() => pool.close());
    const a = await connect(network, { xhttpPool: pool }),
      b = await connect(network, { xhttpPool: pool });
    await exchange(a, Buffer.from('active-a'));
    await exchange(b, Buffer.from('active-b'));
    const closedA = once(a, 'close').catch(() => {}),
      closedB = once(b, 'close').catch(() => {});
    const started = Date.now();
    listener.destroy();
    await Promise.all([closedA, closedB]);
    assert.ok(Date.now() - started < 500, 'peer must receive actual connection close');
    await eventually(() => pool.stats.clients === 0);
  },
);
test(
  'HTTP/3 split mixed H3/H2 and H2/H3 endpoints forward to one shared XHTTP backend',
  { skip: !available, timeout: 8000 },
  async (t) => {
    const { network } = await fixture(t, 'auto');
    const pool = new XmuxPool(network, {}, () => {
      throw Error('TCP fallback');
    });
    t.after(() => pool.close());
    const lease = await pool.acquire();
    t.after(() => lease.release());
    const h2 = require('node:http2').createServer((req, res) => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !name.startsWith(':')),
      );
      const up = lease.entry.request({
        ':method': req.method,
        ':path': req.url,
        ':scheme': 'https',
        ':authority': 'route.test',
        ...headers,
      });
      up.on('error', () => res.destroy());
      req.on('error', () => up.destroy());
      res.on('error', () => up.destroy());
      up.once('response', (value) => {
        res.writeHead(
          value[':status'],
          Object.fromEntries(Object.entries(value).filter(([name]) => !name.startsWith(':'))),
        );
        up.pipe(res);
      });
      res.once('close', () => {
        if (!res.writableFinished) up.destroy();
      });
      if (req.method !== 'GET') req.pipe(up);
    });
    const sessions = new Set();
    h2.on('session', (session) => {
      sessions.add(session);
      session.on('error', () => {});
      session.once('close', () => sessions.delete(session));
    });
    const port = await listen(h2);
    t.after(() => {
      for (const session of sessions) session.destroy();
      return new Promise((resolve) => h2.close(resolve));
    });
    const bridge = {
      ...network,
      port,
      option: { ...network.option, httpVersion: '2', tls: undefined },
    };
    for (const mode of ['stream-up', 'packet-up', 'auto'])
      for (const [upload, download] of [
        [network, bridge],
        [bridge, network],
      ]) {
        const stream = await connect({
          ...upload,
          option: { ...upload.option, mode, downloadSettings: structuredClone(download) },
        });
        t.after(() => stream.destroy());
        await exchange(stream, Buffer.alloc(98321, 67));
        stream.destroy();
      }
  },
);
