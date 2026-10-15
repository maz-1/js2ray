'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../');
const { echo, readBytes } = require('./helpers');
const user = { id: 'd342d11e-d424-4583-b36e-524ab1f0afa4', security: 'none', alterId: 0 };

for (const security of ['none', 'aes-128-gcm', 'chacha20-poly1305', 'auto']) {
  test(
    `VMess ${security}: direct stream, multiple network selection and instance isolation`,
    { timeout: 10000 },
    async (t) => {
      const target = await echo(t);
      const server = createRuntime({
        inbounds: [
          {
            tag: 'same',
            protocol: 'vmess',
            users: [{ ...user, security }],
            networks: [{ port: 0 }],
          },
        ],
      });
      await server.start();
      const network = {
        type: 'tcp',
        address: '127.0.0.1',
        port: server.listenersInfo[0].address.port,
      };
      const client = createRuntime({
        outbounds: [
          {
            tag: 'same',
            protocol: 'vmess',
            users: [{ ...user, security }],
            networks: [network, { ...network }],
          },
        ],
      });
      t.after(() => Promise.all([server.close(), client.close()]));
      await client.start();
      assert.notEqual(
        server.protocols.vmess.api.getUsers('same'),
        client.protocols.vmess.api.getUsers('same'),
      );
      const stream = await client.dial(target);
      const data = Buffer.from('VMess binary test\0\xff'.repeat(1000));
      stream.write(data);
      assert.deepEqual(await readBytes(stream, data.length), data);
      stream.end('tail');
      const tail = [];
      for await (const chunk of stream) tail.push(chunk);
      assert.equal(Buffer.concat(tail).toString(), 'tail');
    },
  );
}
