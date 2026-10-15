'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const { once } = require('node:events');
const { inspect } = require('../routing/sniff');
const { createRuntime } = require('..');
const { echo, readBytes, listen } = require('./helpers');

test('HTTP sniffing waits for complete headers and rejects ambiguous Host', () => {
  const header = Buffer.from('GET / HTTP/1.1\r\nHost: name.test:8080\r\n\r\nbody');
  for (let i = 0; i < header.indexOf('\r\n\r\n') + 4; i++)
    assert.equal(inspect(header.subarray(0, i)), undefined);
  assert.equal(inspect(header), 'name.test');
  assert.equal(
    inspect(Buffer.from('GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n')),
    null,
  );
});
test('sniffed routing preserves first bytes; routeOnly controls actual dial target', async (t) => {
  const destination = await echo(t);
  for (const routeOnly of [true, false]) {
    const lookedUp = [];
    const runtime = createRuntime(
      {
        inbounds: [
          {
            protocol: 'tcp',
            tag: 'entry',
            networks: [{ port: 0 }],
            target: { host: 'original.test', port: destination.port },
            sniffing: { enabled: true, routeOnly },
          },
        ],
        outbounds: [
          { protocol: 'blackhole', tag: 'block' },
          { protocol: 'freedom', tag: 'direct' },
        ],
        routing: { rules: [{ domain: ['full:sniffed.test'], outboundTag: 'direct' }] },
      },
      {
        lookup(name, options, callback) {
          lookedUp.push(name);
          callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
        },
      },
    );
    await runtime.start();
    t.after(() => runtime.close());
    const socket = net.connect(runtime.listenersInfo[0].address.port, '127.0.0.1');
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    const header = Buffer.from('GET / HTTP/1.1\r\nHost: sniffed.test\r\n\r\nretained');
    socket.write(header.subarray(0, 8));
    socket.write(header.subarray(8));
    assert.deepEqual(await readBytes(socket, header.length), header);
    assert.equal(lookedUp[0], routeOnly ? 'original.test' : 'sniffed.test');
    await runtime.close();
  }
});
test('TLS ClientHello SNI sniffing handles fragmentation without consuming the handshake', async (t) => {
  const cert = fs.readFileSync(require.resolve('./fixtures/tls/cert.pem')),
    key = fs.readFileSync(require.resolve('./fixtures/tls/key.pem'));
  const target = tls.createServer({ cert, key }, (socket) => {
    socket.on('error', () => {});
    socket.end('secure');
  });
  const port = await listen(target);
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const runtime = createRuntime({
    inbounds: [
      {
        protocol: 'tcp',
        networks: [{ port: 0 }],
        target: { host: '127.0.0.1', port },
        sniffing: { enabled: true, routeOnly: true },
      },
    ],
    outbounds: [
      { protocol: 'blackhole', tag: 'block' },
      { protocol: 'freedom', tag: 'direct' },
    ],
    routing: { rules: [{ domain: ['full:js2ray.test'], outboundTag: 'direct' }] },
  });
  await runtime.start();
  t.after(() => runtime.close());
  const socket = tls.connect({
    host: '127.0.0.1',
    port: runtime.listenersInfo[0].address.port,
    servername: 'js2ray.test',
    ca: cert,
  });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect');
  assert.equal((await readBytes(socket, 6)).toString(), 'secure');
});
