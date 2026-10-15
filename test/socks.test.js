'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createRuntime } = require('../');
const { encodeAddress } = require('../protocols/socks/stream');
const { echo, readBytes } = require('./helpers');

for (const authenticated of [false, true]) {
  test(`SOCKS5 ${authenticated ? 'password' : 'noauth'} inbound/outbound`, async (t) => {
    const target = await echo(t);
    const users = authenticated ? [{ user: 'synthetic', pass: 'test-only' }] : [];
    const server = createRuntime({
      inbounds: [{ protocol: 'socks', users, networks: [{ port: 0 }] }],
    });
    await server.start();
    const client = createRuntime({
      outbounds: [
        {
          protocol: 'socks',
          users,
          networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
        },
      ],
    });
    t.after(() => Promise.all([server.close(), client.close()]));
    await client.start();
    const stream = await client.dial(target);
    stream.write('authenticated stream');
    assert.equal((await readBytes(stream, 20)).toString(), 'authenticated stream');
  });
}

test('SOCKS5 inbound accepts byte-split negotiation and pipelined application data', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime({ inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }] });
  await runtime.start();
  t.after(() => runtime.close());
  const socket = net.connect(runtime.listenersInfo[0].address.port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  t.after(() => socket.destroy());
  for (const value of [5, 1, 0]) {
    socket.write(Buffer.from([value]));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await readBytes(socket, 2), Buffer.from([5, 0]));
  socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0]),
      encodeAddress(target.host, target.port),
      Buffer.from('first'),
    ]),
  );
  assert.equal((await readBytes(socket, 10))[1], 0);
  assert.equal((await readBytes(socket, 5)).toString(), 'first');
});

test('SOCKS5 rejects wrong credentials with a structured client error', async (t) => {
  const server = createRuntime({
    inbounds: [
      {
        protocol: 'socks',
        users: [{ user: 'synthetic', pass: 'test-only' }],
        networks: [{ port: 0 }],
      },
    ],
  });
  await server.start();
  const client = createRuntime({
    outbounds: [
      {
        protocol: 'socks',
        users: [{ user: 'synthetic', pass: 'wrong' }],
        networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
      },
    ],
  });
  await client.start();
  t.after(() => Promise.all([server.close(), client.close()]));
  await assert.rejects(client.dial({ host: '127.0.0.1', port: 80 }), { code: 'ERR_AUTH' });
});

test('SOCKS4 inbound preserves CONNECT', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime({ inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }] });
  await runtime.start();
  t.after(() => runtime.close());
  const socket = net.connect(runtime.listenersInfo[0].address.port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  t.after(() => socket.destroy());
  const prefix = Buffer.from([4, 1, 0, 0, 127, 0, 0, 1, 0]);
  prefix.writeUInt16BE(target.port, 2);
  socket.write(prefix);
  assert.equal((await readBytes(socket, 8))[1], 90);
  socket.write('socks4');
  assert.equal((await readBytes(socket, 6)).toString(), 'socks4');
});
