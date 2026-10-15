'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { createRuntime } = require('..');
const { portalConfig, bridgeConfig, waitFor } = require('./fixtures/reverse');
test('reverse UDP: independent packets, concurrent targets, empty/large payloads and carrier shutdown', async (t) => {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, peer) => socket.send(data, peer.port, peer.address));
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  socket.setRecvBufferSize(2 * 1024 * 1024);
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  const portal = createRuntime(portalConfig(0));
  await portal.start();
  const bridge = createRuntime(
    bridgeConfig(portal.listenersInfo[0].address.port, {
      host: '127.0.0.1',
      port: socket.address().port,
    }),
  );
  await bridge.start();
  t.after(() => Promise.all([bridge.close(), portal.close()]));
  await waitFor(() => portal.stats.reverse[0].active > 0);
  const sessions = await Promise.all(
    Array.from({ length: 12 }, () =>
      portal.openDatagram({ host: 'service.test', port: 80, outboundTag: 'portal' }),
    ),
  );
  await Promise.all(
    sessions.map(async (session, index) => {
      for (const data of [Buffer.alloc(0), Buffer.from([index, 255]), Buffer.alloc(60000, index)]) {
        await session.send(data);
        assert.deepEqual((await session.next()).value.data, data);
      }
    }),
  );
  await bridge.close();
  await waitFor(() => sessions.every((s) => s.destroyed));
  await portal.close();
  assert.equal(portal.stats.connections, 0);
  assert.equal(portal.metrics.mux.queuedBytes, 0);
});
