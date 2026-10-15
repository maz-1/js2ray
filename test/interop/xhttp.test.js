'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { createRuntime } = require('../..');
const { readBytes, echo } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const variants = [
  { name: 'HTTP/1.1', httpVersion: '1.1' },
  { name: 'TLS HTTP/1.1', httpVersion: '1.1', secure: true },
  { name: 'TLS HTTP/2', httpVersion: '2', secure: true },
  { name: 'h2c', httpVersion: '2' },
];
function nativeNetwork(variant, mode, port, server) {
  return {
    type: 'xhttp',
    address: '127.0.0.1',
    port,
    option: {
      host: 'independent.test',
      path: '/official-xhttp?fixed=synthetic',
      mode,
      httpVersion: variant.httpVersion,
      scMaxEachPostBytes: 32768,
      ...(variant.secure
        ? { tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' } }
        : {}),
    },
  };
}
function referenceTransport(variant, mode, server) {
  return {
    network: 'xhttp',
    security: variant.secure ? 'tls' : 'none',
    xhttpSettings: {
      host: 'independent.test',
      path: '/official-xhttp?fixed=synthetic',
      mode,
      scMaxEachPostBytes: 32768,
    },
    ...(variant.secure
      ? {
          tlsSettings: {
            alpn: [variant.httpVersion === '2' ? 'h2' : 'http/1.1'],
            ...(server
              ? { certificates: [{ certificateFile: certFile, keyFile }] }
              : {
                  serverName: 'js2ray.test',
                  disableSystemRoot: true,
                  certificates: [{ usage: 'verify', certificateFile: certFile }],
                }),
          },
        }
      : {}),
  };
}
async function transfer(runtime, destination, index) {
  const stream = await runtime.dial(destination);
  try {
    const body = Buffer.concat([Buffer.from(`independent-peer-${index}\0`), randomBytes(131091)]);
    const reply = readBytes(stream, body.length);
    for (let offset = 0; offset < body.length; offset += 16384)
      await new Promise((resolve, reject) =>
        stream.write(body.subarray(offset, offset + 16384), (cause) =>
          cause ? reject(cause) : resolve(),
        ),
      );
    assert.deepEqual(await reply, body);
  } finally {
    stream.destroy();
  }
}
for (const variant of variants)
  for (const mode of ['packet-up', 'stream-up', 'stream-one']) {
    test(
      `XHTTP js2ray client -> Xray 25.3.6 ${variant.name} ${mode}`,
      { timeout: 12000 },
      async (t) => {
        const destination = await echo(t);
        const port = await freePort();
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
                streamSettings: referenceTransport(variant, mode, true),
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
              networks: [nativeNetwork(variant, mode, port, false)],
            },
          ],
        });
        await runtime.start();
        t.after(() => runtime.close());
        await Promise.all([0, 1, 2].map((index) => transfer(runtime, destination, index)));
        assert.equal(runtime.stats.listeners, 0);
      },
    );
    // The locked Xray dialer selects HTTP/1.1 whenever TLS is absent. Its server
    // accepts h2c; the reverse HTTP/2 direction is therefore verified using TLS.
    if (!variant.secure && variant.httpVersion === '2') continue;
    test(
      `XHTTP Xray 25.3.6 client -> js2ray ${variant.name} ${mode}`,
      { timeout: 12000 },
      async (t) => {
        const destination = await echo(t);
        const server = createRuntime({
          inbounds: [
            {
              protocol: 'vless',
              users: [{ id }],
              networks: [nativeNetwork(variant, mode, 0, true)],
            },
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
                streamSettings: referenceTransport(variant, mode, false),
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
        await Promise.all([0, 1, 2].map((index) => transfer(client, destination, index)));
      },
    );
  }
