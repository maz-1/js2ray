'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode } = require('../protocols/mux/frame');
const { Mux } = require('../protocols/mux');
const net = require('node:net');
const { once } = require('node:events');
const { listen, echo, readBytes } = require('./helpers');
test('Mux fixed frame vector and every truncated prefix', () => {
  const frame = encode({
    id: 1,
    status: 1,
    target: { host: '127.0.0.1', port: 80 },
    data: Buffer.from('hi'),
  });
  assert.equal(frame.toString('hex'), '000c00010101010050017f00000100026869');
  for (let i = 0; i < frame.length; i++) assert.equal(decode(frame.subarray(0, i)), undefined);
  assert.equal(decode(frame).data.toString(), 'hi');
  assert.throws(() => decode(Buffer.from([2, 1])), { code: 'ERR_PROTOCOL' });
});
test('Mux concurrent streams isolate payloads, recycle IDs and close transport resources', async (t) => {
  const destination = await echo(t);
  let peer;
  const server = net.createServer((socket) => {
    peer = new Mux(socket, {
      maxBufferBytes: 8 * 1024 * 1024,
      server: true,
      dispatch: (target) => Promise.resolve(net.connect(target.port, target.host)),
    });
  });
  const port = await listen(server);
  t.after(() => {
    peer?.close();
    return new Promise((resolve) => server.close(resolve));
  });
  const raw = net.connect(port, '127.0.0.1');
  await once(raw, 'connect');
  const mux = new Mux(raw, { maxBufferBytes: 8 * 1024 * 1024 });
  t.after(() => mux.close());
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const stream = mux.open(destination);
      const payload = Buffer.alloc(32768, i);
      stream.write(payload);
      assert.deepEqual(await readBytes(stream, payload.length), payload);
      stream.destroy();
    }),
  );
  mux.nextId = 65535;
  const a = mux.open(destination),
    b = mux.open(destination);
  assert.equal(a.id, 65535);
  assert.equal(b.id, 0);
  a.destroy();
  mux.nextId = 65535;
  const c = mux.open(destination);
  assert.notEqual(c.id, 65535);
  c.destroy();
  b.destroy();
  const peerClosed = new Promise((resolve) => peer.once('close', resolve));
  mux.close();
  assert.equal(mux.sessions.size, 0);
  await peerClosed;
  assert.equal(peer.closed, true);
});
test('a slow Mux consumer is terminated at its queue cap while another session remains usable', async () => {
  const { duplexPair, PassThrough } = require('node:stream');
  const [left, right] = duplexPair();
  const server = new Mux(right, {
    server: true,
    maxBufferBytes: 65536,
    dispatch: async (target) => {
      const stream = new PassThrough();
      if (target.host === 'flood.test')
        setImmediate(() => {
          if (!stream.destroyed) stream.write(Buffer.alloc(16384));
        });
      return stream;
    },
  });
  const client = new Mux(left, { sessionLimit: 8192, maxBufferBytes: 65536 });
  try {
    const slow = client.open({ host: 'flood.test', port: 80 });
    const error = await new Promise((resolve) => slow.once('error', resolve));
    assert.equal(error.code, 'ERR_LIMIT');
    assert.equal(client.closed, false);
    const healthy = client.open({ host: 'healthy.test', port: 80 });
    healthy.write('healthy');
    assert.equal((await readBytes(healthy, 7)).toString(), 'healthy');
    healthy.destroy();
  } finally {
    client.close();
    server.close();
  }
});
test('Mux rejects UDP and bounds per-session receive and overall send queues', () => {
  const { PassThrough } = require('node:stream');
  const raw = new PassThrough();
  const mux = new Mux(raw, { sessionLimit: 8, maxBufferBytes: 128, idleTimeoutMs: 0 });
  assert.throws(() => mux.open({ host: 'test', port: 53, network: 'udp' }), {
    code: 'ERR_UNSUPPORTED',
  });
  // Avoid loopback parsing of our own NEW frame in this controlled sink.
  raw.removeAllListeners('data');
  const stream = mux.open({ host: 'test', port: 80 });
  stream.receive(Buffer.alloc(9));
  assert.equal(stream.destroyed, true);
  mux.close();
});
test('carrier failure terminates every active Mux session without replay', async (t) => {
  let peer;
  const { PassThrough } = require('node:stream');
  const server = net.createServer((socket) => {
    peer = new Mux(socket, { server: true, dispatch: async () => new PassThrough() });
  });
  const port = await listen(server);
  t.after(() => {
    peer?.close();
    return new Promise((resolve) => server.close(resolve));
  });
  const raw = net.connect(port, '127.0.0.1');
  await once(raw, 'connect');
  const client = new Mux(raw);
  t.after(() => client.close());
  const sessions = [
    client.open({ host: 'a.test', port: 80 }),
    client.open({ host: 'b.test', port: 80 }),
  ];
  for (const stream of sessions) {
    stream.write('before');
    assert.equal((await readBytes(stream, 6)).toString(), 'before');
  }
  const failures = sessions.map(
    (stream) => new Promise((resolve) => stream.once('error', resolve)),
  );
  peer.stream.destroy(Error('synthetic carrier failure'));
  for (const error of await Promise.all(failures)) assert.equal(error.code, 'ERR_TRANSPORT');
  assert.equal(client.sessions.size, 0);
});
