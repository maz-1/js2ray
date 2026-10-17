'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const available = require('node:module').isBuiltin('node:quic');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const native = (port, server) => ({
  type: 'quic',
  address: '127.0.0.1',
  port,
  option: { tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' } },
});
const transport = (server) => ({
  network: 'quic',
  security: 'tls',
  quicSettings: { security: 'none', key: '', header: { type: 'none' } },
  tlsSettings: server
    ? { certificates: [{ certificateFile: certFile, keyFile }] }
    : {
        serverName: 'js2ray.test',
        disableSystemRoot: true,
        certificates: [{ usage: 'verify', certificateFile: certFile }],
      },
});
async function exchange(stream) {
  const body = Buffer.alloc(512 * 1024, 79);
  const response = readBytes(stream, body.length);
  for (let offset = 0; offset < body.length; offset += 16384)
    if (!stream.write(body.subarray(offset, offset + 16384))) await once(stream, 'drain');
  assert.deepEqual(await response, body);
  stream.destroy();
}
// Pinned Xray 24.11.5 rejects network:quic at config load (see QUIC.md).
for (const core of ['v2ray']) {
  for (const protocol of ['vless', 'vmess']) {
    test(
      `native QUIC ${protocol}: js2ray client -> ${core} server (none/none)`,
      { skip: !available, timeout: 10000 },
      async (t) => {
        const target = await echo(t),
          port = await freePort(true),
          readyPort = await freePort();
        await runCore(
          t,
          core,
          {
            log: { loglevel: 'warning' },
            inbounds: [
              {
                listen: '127.0.0.1',
                port,
                protocol,
                settings: {
                  clients: [{ id }],
                  ...(protocol === 'vless' ? { decryption: 'none' } : {}),
                },
                streamSettings: transport(true),
              },
              {
                listen: '127.0.0.1',
                port: readyPort,
                protocol: 'socks',
                settings: { auth: 'noauth' },
              },
            ],
            outbounds: [{ protocol: 'freedom' }],
          },
          readyPort,
        );
        const client = createRuntime({
          outbounds: [
            {
              protocol,
              users: [{ id, ...(protocol === 'vless' ? { encryption: 'none' } : {}) }],
              networks: [native(port, false)],
            },
          ],
        });
        t.after(() => client.close());
        await client.start();
        await exchange(await client.dial(target));
      },
    );
    test(
      `native QUIC ${protocol}: ${core} client -> js2ray server (none/none)`,
      { skip: !available, timeout: 10000 },
      async (t) => {
        const target = await echo(t);
        const server = createRuntime({
          inbounds: [{ protocol, users: [{ id }], networks: [native(0, true)] }],
        });
        t.after(() => server.close());
        await server.start();
        const port = await freePort();
        await runCore(
          t,
          core,
          {
            log: { loglevel: 'warning' },
            inbounds: [
              { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
            ],
            outbounds: [
              {
                protocol,
                settings: {
                  vnext: [
                    {
                      address: '127.0.0.1',
                      port: server.listenersInfo[0].address.port,
                      users: [{ id, ...(protocol === 'vless' ? { encryption: 'none' } : {}) }],
                    },
                  ],
                },
                streamSettings: transport(false),
              },
            ],
          },
          port,
        );
        const client = createRuntime({
          outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
        });
        t.after(() => client.close());
        await client.start();
        await exchange(await client.dial(target));
      },
    );
  }
}
