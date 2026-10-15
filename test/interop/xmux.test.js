'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const xmux = {
  maxConcurrency: '2-2',
  cMaxReuseTimes: '3-3',
  hMaxRequestTimes: '5-5',
  hMaxReusableSecs: '1-1',
  hKeepAlivePeriod: 1,
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function native(port, mode, version, server = false) {
  return {
    type: 'xhttp',
    address: '127.0.0.1',
    port,
    option: {
      path: '/xmux',
      mode,
      httpVersion: version,
      scMaxEachPostBytes: 16384,
      xmux,
      tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' },
    },
  };
}
function reference(mode, version, server = false) {
  return {
    network: 'xhttp',
    security: 'tls',
    tlsSettings: {
      alpn: [version === '2' ? 'h2' : 'http/1.1'],
      ...(server
        ? { certificates: [{ certificateFile: certFile, keyFile }] }
        : {
            serverName: 'js2ray.test',
            disableSystemRoot: true,
            certificates: [{ usage: 'verify', certificateFile: certFile }],
          }),
    },
    xhttpSettings: { path: '/xmux', mode, extra: { scMaxEachPostBytes: 16384, xmux } },
  };
}
async function exchange(stream) {
  const body = randomBytes(24593),
    reading = readBytes(stream, body.length);
  await new Promise((resolve, reject) =>
    stream.write(body, (cause) => (cause ? reject(cause) : resolve())),
  );
  assert.deepEqual(await reading, body);
}
async function exercise(runtime, target, t) {
  const held = await Promise.all([runtime.dial(target), runtime.dial(target)]);
  t.after(() => held.forEach((stream) => stream.destroy()));
  await Promise.all(held.map(exchange));
  // Expired clients must stop taking new HTTP requests without closing the GET
  // or streaming POST that owns an established business connection.
  await pause(1100);
  const next = await runtime.dial(target);
  t.after(() => next.destroy());
  for (let round = 0; round < 3; round++) await Promise.all([...held, next].map(exchange));
  held[0].destroy();
  await exchange(held[1]);
  await exchange(next);
  held[1].destroy();
  next.destroy();
}
for (const version of ['1.1', '2'])
  for (const mode of ['packet-up', 'stream-up', 'stream-one']) {
    test(
      `XMUX js2ray -> Xray 25.3.6 TLS HTTP/${version} ${mode}: shared client retirement`,
      { timeout: 12000 },
      async (t) => {
        const target = await echo(t),
          port = await freePort();
        await runCore(
          t,
          'xray',
          {
            log: { loglevel: 'warning' },
            inbounds: [
              {
                listen: '127.0.0.1',
                port,
                protocol: 'vless',
                settings: { clients: [{ id }], decryption: 'none' },
                streamSettings: reference(mode, version, true),
              },
            ],
            outbounds: [{ protocol: 'freedom' }],
          },
          port,
          { profile: 'xray-xhttp' },
        );
        const runtime = createRuntime({
          outbounds: [
            {
              protocol: 'vless',
              users: [{ id, encryption: 'none' }],
              networks: [native(port, mode, version)],
            },
          ],
        });
        await runtime.start();
        t.after(() => runtime.close());
        await exercise(runtime, target, t);
        assert.ok(runtime.metrics.xhttp.created >= 2);
        assert.ok(runtime.metrics.xhttp.retired >= 1);
        assert.equal(runtime.stats.listeners, 0);
        await runtime.close();
        assert.equal(runtime.metrics.xhttp.clients, 0);
        assert.equal(runtime.metrics.xhttp.sockets, 0);
      },
    );
    test(
      `XMUX Xray 25.3.6 -> js2ray TLS HTTP/${version} ${mode}: shared client retirement`,
      { timeout: 12000 },
      async (t) => {
        const target = await echo(t);
        const server = createRuntime({
          inbounds: [
            { protocol: 'vless', users: [{ id }], networks: [native(0, mode, version, true)] },
          ],
        });
        await server.start();
        t.after(() => server.close());
        const port = await freePort();
        await runCore(
          t,
          'xray',
          {
            log: { loglevel: 'warning' },
            inbounds: [
              { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
            ],
            outbounds: [
              {
                protocol: 'vless',
                settings: {
                  vnext: [
                    {
                      address: '127.0.0.1',
                      port: server.listenersInfo[0].address.port,
                      users: [{ id, encryption: 'none' }],
                    },
                  ],
                },
                streamSettings: reference(mode, version),
              },
            ],
          },
          port,
          { profile: 'xray-xhttp' },
        );
        const client = createRuntime({
          outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
        });
        await client.start();
        t.after(() => client.close());
        await exercise(client, target, t);
        assert.ok(server.metrics.inbound.accepted >= 2);
        await client.close();
      },
    );
  }
