'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { duplexPair } = require('node:stream');
const { createRuntime } = require('..');
const { Mux } = require('../protocols/mux');
const { encode, decode } = require('../protocols/mux/frame');
const { encodePacket, decodePacket } = require('../protocols/socks/datagram');
const { id } = require('./fixtures/reverse');
async function echo(t, host) {
  const socket = dgram.createSocket(host === '::1' ? 'udp6' : 'udp4');
  socket.on('message', (data, peer) => socket.send(data, peer.port, peer.address));
  socket.bind(0, host);
  await once(socket, 'listening');
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  return { host, port: socket.address().port };
}
test('UDP codecs cover IPv4/IPv6/domain, malformed SOCKS fragments and every split of XUDP keep metadata', () => {
  for (const host of ['127.0.0.1', '::1', 'echo.test']) {
    const target = {
        host: require('node:net').isIP(host)
          ? require('../core/utils').iptoString(require('../core/utils').iptoBuffer(host))
          : host,
        port: 53,
      },
      data = Buffer.from([0, 255]);
    const packet = encodePacket(data, target);
    assert.deepEqual(decodePacket(packet), { ...target, data });
    for (let n = 0; n < packet.length - data.length; n++)
      assert.equal(decodePacket(packet.subarray(0, n)), undefined);
    packet[2] = 1;
    assert.equal(decodePacket(packet), undefined);
    const frame = encode({ id: 9, status: 2, target: { ...target, network: 'udp' }, data });
    for (let n = 0; n < frame.length; n++) assert.equal(decode(frame.subarray(0, n)), undefined);
    assert.deepEqual(decode(frame).target, { ...target, network: 'udp' });
  }
});
for (const protocol of ['socks', 'vmess', 'mux', 'xudp']) {
  test(`${protocol}: UDP IPv6/domain, large packet, established cancellation and zero resources`, async (t) => {
    const v4 = await echo(t, '127.0.0.1'),
      v6 = await echo(t, '::1');
    const wire = ['mux', 'xudp'].includes(protocol) ? 'vless' : protocol;
    const peer = createRuntime({
      inbounds: [
        {
          protocol: wire,
          users: wire === 'socks' ? [] : [{ id }],
          ...(wire === 'socks' ? { udp: true } : {}),
          networks: [{ port: 0 }],
        },
      ],
      outbounds: [{ protocol: 'freedom', domainStrategy: 'UseIP' }],
      dns: { hosts: { 'echo.test': '127.0.0.1' } },
    });
    await peer.start();
    const runtime = createRuntime({
      outbounds: [
        {
          protocol: wire,
          users:
            wire === 'socks'
              ? []
              : [
                  {
                    id,
                    ...(wire === 'vless'
                      ? { encryption: 'none' }
                      : { security: 'chacha20-poly1305' }),
                  },
                ],
          networks: [{ address: '127.0.0.1', port: peer.listenersInfo[0].address.port }],
          ...(protocol === 'mux' ? { mux: { enabled: true } } : {}),
          ...(protocol === 'xudp' ? { packetEncoding: 'xudp' } : {}),
        },
      ],
    });
    await runtime.start();
    t.after(() => Promise.all([runtime.close(), peer.close()]));
    for (const target of [{ host: 'echo.test', port: v4.port }, v6]) {
      const abort = new AbortController();
      const session = await runtime.openDatagram({ ...target, signal: abort.signal });
      const data = Buffer.alloc(60000, 0xaa);
      await session.send(data);
      assert.deepEqual((await session.next()).value.data, data);
      const rejected = assert.rejects(session.next(), { code: 'ERR_CANCELLED' });
      abort.abort();
      await rejected;
    }
    await runtime.close();
    await peer.close();
    assert.equal(runtime.stats.connections, 0);
    assert.equal(peer.stats.connections, 0);
  });
}
test('XUDP per-packet destinations stay isolated within one Mux session and queue limits remain enforced', async (t) => {
  const a = await echo(t, '127.0.0.1'),
    b = await echo(t, '127.0.0.1');
  const runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const [left, right] = duplexPair();
  const server = new Mux(right, {
    server: true,
    dispatch: (target) => runtime.openDatagram(target),
  });
  const client = new Mux(left);
  t.after(() => {
    client.close();
    server.close();
  });
  const session = client.openDatagram({ ...a, xudp: true });
  session.multiTarget = true;
  for (const target of [a, b, a]) {
    await session.send(Buffer.from(String(target.port)), target);
    const message = (await session.next()).value;
    assert.equal(message.port, target.port);
    assert.equal(message.data.toString(), String(target.port));
  }
  const limited = client.openDatagram(a);
  limited.receive(Buffer.alloc(limited.maxBufferBytes + 1));
  assert.equal(limited.error.code, 'ERR_LIMIT');
  assert.equal(client.closed, false);
});
