'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

for (const core of ['xray', 'v2ray']) {
  for (const security of ['none', 'aes-128-gcm', 'chacha20-poly1305']) {
    test(`VMess ${security}: js2ray client -> ${core}`, { timeout: 10000 }, async (t) => {
      const target = await echo(t);
      const port = await freePort();
      await runCore(
        t,
        core,
        {
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vmess',
              settings: { clients: [{ id, alterId: 0 }] },
            },
          ],
          outbounds: [{ protocol: 'freedom' }],
        },
        port,
      );
      const runtime = createRuntime({
        outbounds: [
          {
            protocol: 'vmess',
            users: [{ id, security }],
            networks: [{ address: '127.0.0.1', port }],
          },
        ],
      });
      t.after(() => runtime.close());
      await runtime.start();
      const stream = await runtime.dial(target);
      stream.write('vmess official');
      assert.equal((await readBytes(stream, 14)).toString(), 'vmess official');
    });
    test(`VMess ${security}: ${core} client -> js2ray`, { timeout: 10000 }, async (t) => {
      const target = await echo(t);
      const server = createRuntime({
        inbounds: [{ protocol: 'vmess', users: [{ id, security }], networks: [{ port: 0 }] }],
      });
      await server.start();
      t.after(() => server.close());
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
              protocol: 'vmess',
              settings: {
                vnext: [
                  {
                    address: '127.0.0.1',
                    port: server.listenersInfo[0].address.port,
                    users: [{ id, alterId: 0, security }],
                  },
                ],
              },
            },
          ],
        },
        port,
      );
      const runtime = createRuntime({
        outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
      });
      await runtime.start();
      t.after(() => runtime.close());
      const stream = await runtime.dial(target);
      stream.write('vmess official');
      assert.equal((await readBytes(stream, 14)).toString(), 'vmess official');
    });
  }
}
