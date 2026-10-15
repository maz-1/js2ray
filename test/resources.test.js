'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRuntime } = require('../');
const { echo, readBytes } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

test(
  '100 concurrent VLESS streams remain isolated with paused consumers and clean close',
  { timeout: 10000 },
  async (t) => {
    const target = await echo(t);
    const server = createRuntime({
      inbounds: [{ protocol: 'vless', users: [{ id }], networks: [{ port: 0 }] }],
    });
    await server.start();
    const client = createRuntime({
      outbounds: [
        {
          protocol: 'vless',
          users: [{ id, encryption: 'none' }],
          networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
        },
      ],
    });
    await client.start();
    t.after(() => Promise.all([server.close(), client.close()]));
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const stream = await client.dial(target);
        const data = Buffer.alloc(65536, index);
        stream.write(data);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(stream.readableLength <= 1024 * 1024);
        assert.deepEqual(await readBytes(stream, data.length), data);
        stream.destroy();
      }),
    );
    await Promise.all([server.close(), client.close()]);
    assert.equal(server.stats.connections, 0);
    assert.equal(client.stats.connections, 0);
  },
);

test('a signal remains attached until the returned stream closes', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime();
  await runtime.start();
  t.after(() => runtime.close());
  const controller = new AbortController();
  const stream = await runtime.dial({ ...target, signal: controller.signal });
  const closed = new Promise((resolve) => stream.once('close', resolve));
  let error;
  stream.once('error', (value) => {
    error = value;
  });
  controller.abort();
  await closed;
  assert.equal(error.code, 'ERR_CANCELLED');
});

for (const protocol of ['vmess', 'vless']) {
  test(
    `${protocol} virtual stream forwards timeout events and enforces idle policy`,
    { timeout: 3000 },
    async (t) => {
      const target = await echo(t);
      const users = protocol === 'vmess' ? [{ id, security: 'none' }] : [{ id }];
      const server = createRuntime({ inbounds: [{ protocol, users, networks: [{ port: 0 }] }] });
      await server.start();
      const client = createRuntime({
        limits: { idleTimeoutMs: 30 },
        outbounds: [
          {
            protocol,
            users: protocol === 'vless' ? [{ id, encryption: 'none' }] : users,
            networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
          },
        ],
      });
      t.after(() => Promise.all([server.close(), client.close()]));
      await client.start();
      const stream = await client.dial(target);
      let error;
      stream.once('error', (value) => {
        error = value;
      });
      await new Promise((resolve) => stream.once('close', resolve));
      assert.equal(error.code, 'ERR_TIMEOUT');
    },
  );
}

test('optional storage is read on start and preserves per-instance VMess usage', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-storage-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('js2ray-storage-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const storage = path.join(directory, 'usage.json');
  const config = {
    storage,
    outbounds: [
      {
        tag: 'account',
        protocol: 'vmess',
        users: [{ id, alterId: 1 }],
        networks: [{ address: '127.0.0.1', port: 1234 }],
      },
    ],
  };
  const first = createRuntime(config);
  assert.equal(fs.existsSync(storage), false);
  await first.start();
  first.protocols.vmess.api.getUsers('account')[id].bytesRead = 42;
  await first.close();
  const second = createRuntime(config);
  t.after(() => second.close());
  await second.start();
  assert.equal(second.protocols.vmess.api.getUsers('account')[id].bytesRead, 42);
  await second.close();
});
