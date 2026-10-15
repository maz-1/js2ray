'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const certFile = require.resolve('../fixtures/tls/cert.pem'),
  keyFile = require.resolve('../fixtures/tls/key.pem');
function network(port, type, server) {
  return {
    address: '127.0.0.1',
    port,
    type: type === 'tcp' ? 'tcp' : 'ws',
    option:
      type === 'tcp'
        ? {}
        : {
            path: '/mux',
            tls: server ? { certFile, keyFile } : { caFile: certFile, serverName: 'js2ray.test' },
          },
  };
}
function streamSettings(type, server) {
  return type === 'tcp'
    ? undefined
    : {
        network: 'ws',
        security: 'tls',
        wsSettings: { path: '/mux' },
        tlsSettings: server
          ? { certificates: [{ certificateFile: certFile, keyFile }] }
          : {
              serverName: 'js2ray.test',
              disableSystemRoot: true,
              certificates: [{ usage: 'verify', certificateFile: certFile }],
            },
      };
}
for (const kind of ['v2ray', 'xray'])
  for (const type of ['tcp', 'wss'])
    for (const direction of ['client', 'server']) {
      test(`${kind}: js2ray ${direction} VLESS Mux TCP over ${type} with concurrent isolated sessions`, async (t) => {
        const destination = await echo(t),
          port = await freePort();
        let client;
        if (direction === 'client') {
          await runCore(
            t,
            kind,
            {
              log: { loglevel: 'warning' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port,
                  protocol: 'vless',
                  settings: { clients: [{ id }], decryption: 'none' },
                  streamSettings: streamSettings(type, true),
                },
              ],
              outbounds: [{ protocol: 'freedom' }],
            },
            port,
          );
          client = createRuntime({
            outbounds: [
              {
                protocol: 'vless',
                users: [{ id, encryption: 'none' }],
                networks: [network(port, type, false)],
                mux: { enabled: true, concurrency: 32 },
              },
            ],
          });
        } else {
          const server = createRuntime({
            limits: { maxBufferBytes: 8 * 1024 * 1024 },
            inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network(0, type, true)] }],
          });
          await server.start();
          t.after(() => server.close());
          await runCore(
            t,
            kind,
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
                  mux: { enabled: true, concurrency: 32 },
                  streamSettings: streamSettings(type, false),
                },
              ],
            },
            port,
          );
          client = createRuntime({
            outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
          });
        }
        await client.start();
        t.after(() => client.close());
        await Promise.all(
          Array.from({ length: 24 }, async (_, i) => {
            const stream = await client.dial(destination);
            const payload = Buffer.alloc(65536, i);
            stream.write(payload);
            assert.deepEqual(await readBytes(stream, payload.length), payload);
            stream.destroy();
          }),
        );
        const ending = await client.dial(destination);
        ending.write('end');
        assert.equal((await readBytes(ending, 3)).toString(), 'end');
        const closed = new Promise((resolve) => ending.once('close', resolve));
        ending.end();
        ending.resume();
        await closed;
        await client.close();
        assert.equal(client.stats.connections, 0);
      });
    }
