'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
for (const kind of ['v2ray', 'xray'])
  for (const direction of ['client', 'server']) {
    test(`${kind}: js2ray ${direction} VLESS Mux TCP with concurrent isolated sessions`, async (t) => {
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
              networks: [{ address: '127.0.0.1', port }],
              mux: { enabled: true, concurrency: 32 },
            },
          ],
        });
      } else {
        const server = createRuntime({
          limits: { maxBufferBytes: 8 * 1024 * 1024 },
          inbounds: [{ protocol: 'vless', users: [{ id }], networks: [{ port: 0 }] }],
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
      await client.close();
      assert.equal(client.stats.connections, 0);
    });
  }
