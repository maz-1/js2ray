'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { createRuntime } = require('../');
const { FramedDatagram } = require('../runtime/datagram');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

for (const protocol of ['freedom', 'vless', 'vmess', 'vless-mux', 'xudp', 'socks']) {
  test(`${protocol} UDP keeps datagram boundaries and target`, { timeout: 5000 }, async (t) => {
    const echo = dgram.createSocket('udp4');
    echo.on('message', (data, peer) => echo.send(data, peer.port, peer.address));
    echo.bind(0, '127.0.0.1');
    await once(echo, 'listening');
    t.after(() => new Promise((resolve) => echo.close(resolve)));
    let server;
    let outbounds;
    if (protocol !== 'freedom') {
      server = createRuntime({
        inbounds: [
          {
            protocol: ['vless-mux', 'xudp'].includes(protocol) ? 'vless' : protocol,
            users: protocol === 'socks' ? [] : [{ id }],
            ...(protocol === 'socks' ? { udp: true } : {}),
            networks: [{ port: 0 }],
          },
        ],
      });
      await server.start();
      outbounds = [
        {
          protocol: ['vless-mux', 'xudp'].includes(protocol) ? 'vless' : protocol,
          ...(protocol === 'vless-mux' ? { mux: { enabled: true } } : {}),
          ...(protocol === 'xudp' ? { packetEncoding: 'xudp' } : {}),
          users:
            protocol === 'socks'
              ? []
              : [
                  {
                    id,
                    ...(protocol !== 'vmess'
                      ? { encryption: 'none' }
                      : { security: 'aes-128-gcm' }),
                  },
                ],
          networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
        },
      ];
    }
    const runtime = createRuntime({ outbounds });
    t.after(() => Promise.all([runtime.close(), server?.close()]));
    await runtime.start();
    const session = await runtime.openDatagram({ host: '127.0.0.1', port: echo.address().port });
    for (const data of [Buffer.alloc(0), Buffer.from([0, 1, 255]), Buffer.alloc(4096, 0xab)]) {
      await session.send(data);
      const message = (await session.next()).value;
      assert.deepEqual(message.data, data);
      assert.equal(message.port, echo.address().port);
    }
    await assert.rejects(session.send(Buffer.alloc(65536)), { code: 'ERR_TARGET' });
    await assert.rejects(session.send(Buffer.alloc(1), { host: 'elsewhere.test', port: 53 }), {
      code: 'ERR_TARGET',
    });
    session.close();
    session.close();
  });
}

test('UDP frame decoder handles byte splits and empty datagrams', async () => {
  const stream = new PassThrough();
  const session = new FramedDatagram(stream, { host: 'example.test', port: 53 }, 1024);
  for (const byte of [0, 3, 1, 2, 3, 0, 0]) stream.write(Buffer.from([byte]));
  assert.deepEqual((await session.next()).value.data, Buffer.from([1, 2, 3]));
  assert.deepEqual((await session.next()).value.data, Buffer.alloc(0));
  session.close();
});

test('UDP receive queue is bounded', () => {
  const stream = new PassThrough();
  const session = new FramedDatagram(stream, { host: 'example.test', port: 53 }, 2);
  stream.write(Buffer.from([0, 3, 1, 2, 3]));
  assert.equal(session.destroyed, true);
  assert.equal(session.error.code, 'ERR_LIMIT');
});
