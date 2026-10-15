'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { createRuntime } = require('../..');
const { encodeRequest } = require('../../protocols/vless');
const handshake = require('../../transports/reality/handshake');
const { readRecord } = require('../../transports/reality/wire');
const { write } = require('../../runtime/streams');
const { runCore, freePort } = require('./helpers');
const { id } = require('../fixtures/vision');
const fixture = require('../fixtures/reality');
const { echo, listen, readBytes } = require('../helpers');
for (const suite of [0x1301, 0x1302, 0x1303]) {
  test(`REALITY pure Node client prototype -> Xray 25.3.6 suite ${suite.toString(16)}`, async (t) => {
    const cover = await fixture.cover(t),
      target = await echo(t),
      port = await freePort();
    await runCore(
      t,
      'xray',
      {
        inbounds: [
          {
            listen: '127.0.0.1',
            port,
            protocol: 'vless',
            settings: { clients: [{ id }], decryption: 'none' },
            streamSettings: {
              network: 'tcp',
              security: 'reality',
              realitySettings: { dest: `127.0.0.1:${cover.port}`, xver: 0, ...fixture.server },
            },
          },
        ],
        outbounds: [{ protocol: 'freedom' }],
      },
      port,
      { profile: 'xray-xhttp' },
    );
    const raw = await fixture.tcp(port);
    t.after(() => raw.destroy());
    const result = await handshake.client(raw, fixture.client, { suite, onlySuite: true });
    t.after(() => {
      result.rx.destroy();
      result.tx.destroy();
    });
    assert.equal(result.authenticated, true);
    assert.equal(
      result.suite.algorithm,
      require('../../transports/reality/crypto').suites[suite].algorithm,
    );
    const payload = randomBytes(7001);
    await write(raw, result.tx.seal(23, Buffer.concat([encodeRequest({ id }, target), payload])));
    const input = handshake.reader(raw),
      parts = [];
    let bytes = 0;
    while (bytes < payload.length + 2) {
      const opened = result.rx.open(await readRecord(input));
      if (opened.type === 23) {
        parts.push(opened.data);
        bytes += opened.data.length;
      }
    }
    const received = Buffer.concat(parts);
    assert.deepEqual(received.subarray(0, 2), Buffer.from([0, 0]));
    assert.deepEqual(received.subarray(2), payload);
  });
}
test('REALITY Xray 25.3.6 chrome client -> pure Node server prototype', async (t) => {
  const cover = await fixture.cover(t),
    destination = await echo(t);
  const sockets = new Set(),
    payload = randomBytes(1701);
  let success, reject;
  const checked = new Promise((resolve, failed) => {
    success = resolve;
    reject = failed;
  });
  const server = net.createServer({ allowHalfOpen: true }, async (raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
    let target, result;
    try {
      target = await fixture.tcp(cover.port);
      sockets.add(target);
      result = await handshake.server(raw, fixture.server, target);
      if (result.fallback) {
        raw.pipe(target).pipe(raw);
        return;
      }
      const input = handshake.reader(raw),
        prefix = encodeRequest({ id }, destination),
        parts = [];
      let bytes = 0;
      while (bytes < prefix.length + payload.length) {
        const opened = result.rx.open(await readRecord(input));
        if (opened.type === 23) {
          parts.push(opened.data);
          bytes += opened.data.length;
        }
      }
      const request = Buffer.concat(parts);
      assert.deepEqual(request.subarray(0, prefix.length), prefix);
      assert.deepEqual(request.subarray(prefix.length), payload);
      await write(raw, result.tx.seal(23, Buffer.concat([Buffer.from([0, 0]), payload])));
      success(result.mirroredLengths);
    } catch (error) {
      raw.destroy();
      reject(error);
    } finally {
      if (result?.authenticated) {
        result.rx.destroy();
        result.tx.destroy();
        target?.destroy();
      }
    }
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const entry = await freePort();
  await runCore(
    t,
    'xray',
    {
      inbounds: [
        { listen: '127.0.0.1', port: entry, protocol: 'socks', settings: { auth: 'noauth' } },
      ],
      outbounds: [
        {
          protocol: 'vless',
          settings: {
            vnext: [{ address: '127.0.0.1', port, users: [{ id, encryption: 'none' }] }],
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: { fingerprint: 'chrome', ...fixture.client },
          },
        },
      ],
    },
    entry,
    { profile: 'xray-xhttp' },
  );
  const client = createRuntime({
    outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port: entry }] }],
  });
  await client.start();
  t.after(() => client.close());
  const stream = await client.dial(destination);
  const reply = readBytes(stream, payload.length);
  await write(stream, payload);
  assert.deepEqual(await reply, payload);
  const lengths = await checked;
  assert.ok([3, 6].includes(lengths.length));
  assert.ok(lengths.slice(2).every((length) => length >= 22 && length <= 16645));
  stream.destroy();
});
