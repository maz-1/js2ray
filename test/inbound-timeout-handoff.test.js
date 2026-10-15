'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('..');
const { echo, readBytes } = require('./helpers');
const { cert, key, id } = require('./fixtures/vision');
const { write } = require('../runtime/streams');
for (const variant of [
  { name: 'WSS', type: 'ws' },
  { name: 'XHTTP HTTP/1.1 packet-up', type: 'xhttp', httpVersion: '1.1', mode: 'packet-up' },
  { name: 'XHTTP HTTP/1.1 stream-one', type: 'xhttp', httpVersion: '1.1', mode: 'stream-one' },
  { name: 'XHTTP HTTP/2 stream-one', type: 'xhttp', httpVersion: '2', mode: 'stream-one' },
])
  test(`${variant.name} hands the accepted TCP timeout to TLS/HTTP and retains established traffic beyond the handshake budget`, async (t) => {
    const target = await echo(t),
      option = (server) => ({
        ...(variant.type === 'xhttp'
          ? { mode: variant.mode, httpVersion: variant.httpVersion }
          : { path: '/handoff' }),
        tls: server ? { cert, key } : { ca: cert, serverName: 'js2ray.test' },
      });
    const bound = (server, port) => ({
      protocol: 'vless',
      users: [{ id, encryption: 'none' }],
      networks: [{ type: variant.type, address: '127.0.0.1', port, option: option(server) }],
    });
    const server = createRuntime({
      inbounds: [bound(true, 0)],
      limits: { handshakeTimeoutMs: 500 },
    });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [bound(false, server.listenersInfo[0].address.port)],
    });
    await client.start();
    t.after(() => client.close());
    const stream = await client.dial(target);
    t.after(() => stream.destroy());
    for (let n = 0; n < 14; n++) {
      const data = Buffer.alloc(67, n);
      await write(stream, data);
      assert.deepEqual(await readBytes(stream, data.length), data);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(server.metrics.inbound.failed, 0);
    assert.equal(stream.destroyed, false);
  });
