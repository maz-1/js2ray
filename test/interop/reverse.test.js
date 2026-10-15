'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const { portalConfig, bridgeConfig, waitFor } = require('../fixtures/reverse');
for (const kind of ['v2ray', 'xray']) {
  test(`${kind}: js2ray Bridge -> reference Portal concurrent business`, async (t) => {
    const destination = await echo(t),
      port = await freePort(),
      businessPort = await freePort();
    await runCore(t, kind, portalConfig(port, businessPort), port);
    const bridge = createRuntime(bridgeConfig(port, destination));
    const events = [];
    bridge.on('reverse', (event) => events.push(event));
    await bridge.start();
    t.after(() => bridge.close());
    await waitFor(() => events.some((event) => event.state === 'active'));
    await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const socket = net.connect(businessPort, '127.0.0.1');
        socket.on('error', () => {});
        t.after(() => socket.destroy());
        await once(socket, 'connect');
        const payload = Buffer.alloc(32768, i);
        socket.write(payload);
        assert.deepEqual(await readBytes(socket, payload.length), payload);
        socket.destroy();
      }),
    );
    assert.equal(bridge.listenersInfo.length, 0);
  });
  test(`${kind}: reference Bridge -> js2ray Portal concurrent business`, async (t) => {
    const destination = await echo(t),
      portal = createRuntime(portalConfig(0));
    await portal.start();
    t.after(() => portal.close());
    const config = bridgeConfig(portal.listenersInfo[0].address.port, destination);
    await runCore(t, kind, config);
    await waitFor(() => portal.stats.reverse[0].active > 0);
    await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const stream = await portal.dial({ host: 'service.test', port: 80, outboundTag: 'portal' });
        const payload = Buffer.alloc(32768, i);
        stream.write(payload);
        assert.deepEqual(await readBytes(stream, payload.length), payload);
        stream.destroy();
      }),
    );
  });
}
