'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const available = require('node:module').isBuiltin('node:quic');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const network = (port, mode, server) => ({
  type: 'xhttp',
  address: '127.0.0.1',
  port,
  option: {
    httpVersion: '3',
    path: '/interop-h3/',
    host: 'route.test',
    mode,
    tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' },
  },
});
const transport = (mode, server) => ({
  network: 'xhttp',
  security: 'tls',
  xhttpSettings: { path: '/interop-h3/', host: 'route.test', mode },
  tlsSettings: {
    alpn: ['h3'],
    ...(server
      ? { certificates: [{ certificateFile: certFile, keyFile }] }
      : {
          serverName: 'js2ray.test',
          disableSystemRoot: true,
          certificates: [{ usage: 'verify', certificateFile: certFile }],
        }),
  },
});
async function transfer(runtime, target, eof) {
  const stream = await runtime.dial(target);
  const body = Buffer.alloc(512 * 1024, 79);
  const reading = eof
    ? (async () => {
        const chunks = [];
        for await (const data of stream) chunks.push(data);
        return Buffer.concat(chunks);
      })()
    : readBytes(stream, body.length);
  reading.catch(() => {});
  try {
    for (let i = 0; i < body.length; i += 16384) {
      if (!stream.write(body.subarray(i, i + 16384))) await once(stream, 'drain');
    }
    if (eof) stream.end();
    const result = await reading;
    assert.equal(result.length, body.length);
    assert.equal(
      createHash('sha256').update(result).digest('hex'),
      createHash('sha256').update(body).digest('hex'),
    );
  } finally {
    stream.destroy();
    await reading.catch(() => {});
  }
}
for (const mode of ['stream-one', 'stream-up', 'packet-up'])
  for (const direction of ['js-client', 'xray-client']) {
    test(
      `HTTP/3 Xray 25.3.6 ${direction} ${mode} 512KiB ${mode === 'packet-up' ? 'DATA' : 'DATA+FIN'}`,
      { skip: !available, timeout: 10000 },
      async (t) => {
        const target = await echo(t),
          port = await freePort(true),
          readyPort = await freePort();
        let runtime;
        if (direction === 'js-client') {
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
                  streamSettings: transport(mode, true),
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
            { profile: 'xray-xhttp' },
          );
          runtime = createRuntime({
            outbounds: [
              {
                protocol: 'vless',
                users: [{ id, encryption: 'none' }],
                networks: [network(port, mode, false)],
              },
            ],
          });
        } else {
          const server = createRuntime({
            inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network(0, mode, true)] }],
          });
          t.after(() => server.close({ drainTimeoutMs: 0 }));
          await server.start();
          await runCore(
            t,
            'xray',
            {
              log: { loglevel: 'warning' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port: readyPort,
                  protocol: 'socks',
                  settings: { auth: 'noauth' },
                },
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
                  streamSettings: transport(mode, false),
                },
              ],
            },
            readyPort,
            { profile: 'xray-xhttp' },
          );
          runtime = createRuntime({
            outbounds: [
              { protocol: 'socks', networks: [{ address: '127.0.0.1', port: readyPort }] },
            ],
          });
        }
        t.after(() => runtime.close({ drainTimeoutMs: 0 }));
        await runtime.start();
        await transfer(runtime, target, mode !== 'packet-up');
        // A cancelled request must leave the shared HTTP/3 client usable.
        const cancelled = await runtime.dial(target);
        cancelled.destroy();
        await transfer(runtime, target, false);
      },
    );
  }
