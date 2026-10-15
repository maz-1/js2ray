'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Duplex } = require('node:stream');
const { createRuntime, checkConfig } = require('../');
const { encodeRequest, readRequest, responseStream } = require('../protocols/vless');
const { echo, readBytes } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');

function source(parts) {
  return new Duplex({
    read() {
      const part = parts.shift();
      setImmediate(() => this.push(part ?? null));
    },
    write(chunk, encoding, callback) {
      callback();
    },
  });
}

test('VLESS request matches a fixed v0 byte vector', () => {
  assert.equal(
    encodeRequest({ id }, { host: '127.0.0.1', port: 443 }).toString('hex'),
    '00d342d11ed4244583b36e524ab1f0afa4000101bb017f000001',
  );
});

for (const host of ['127.0.0.1', '::ffff:192.0.2.1', 'example.test']) {
  test(`VLESS request parser accepts every split: ${host}`, async () => {
    const request = encodeRequest({ id }, { host, port: 443 });
    for (let split = 1; split < request.length; split++) {
      const stream = source([
        request.subarray(0, split),
        request.subarray(split),
        Buffer.from('surplus'),
      ]);
      const result = await readRequest(stream, { users: [{ id }] }, {});
      assert.equal(result.port, 443);
      assert.equal(result.command, 1);
      assert.equal(
        require('node:net').isIP(result.host) || result.host,
        require('node:net').isIP(host) || host,
      );
      assert.equal((await readBytes(stream, 7)).toString(), 'surplus');
      stream.destroy();
    }
  });
}

test('VLESS response parser preserves bytes with every header/data split', async () => {
  const response = Buffer.from([0, 2, 0xaa, 0xbb, 0, 1, 2, 255]);
  for (let split = 1; split < response.length; split++) {
    const raw = source([response.subarray(0, split), response.subarray(split)]);
    const stream = responseStream(raw, 1024);
    assert.deepEqual(await readBytes(stream, 4), Buffer.from([0, 1, 2, 255]));
    stream.destroy();
  }
});

test('VLESS authentication, truncation, command and flow reject explicitly', async () => {
  const request = encodeRequest({ id }, { host: 'example.test', port: 443 });
  await assert.rejects(
    readRequest(source([request]), { users: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] }, {}),
    { code: 'ERR_AUTH' },
  );
  await assert.rejects(readRequest(source([request.subarray(0, 20)]), { users: [{ id }] }, {}), {
    code: 'ERR_PROTOCOL',
  });
  const command = Buffer.from(request);
  command[18] = 4;
  await assert.rejects(readRequest(source([command]), { users: [{ id }] }, {}), {
    code: 'ERR_UNSUPPORTED',
  });
  const report = checkConfig({
    outbounds: [
      {
        protocol: 'vless',
        users: [{ id, encryption: 'none', flow: 'unsupported-flow' }],
        networks: [{ address: 'example.test', port: 443 }],
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((item) => item.path.endsWith('.flow')));
});

for (const type of ['tcp', 'tls', 'ws', 'wss']) {
  test(
    `VLESS ${type}: direct stream, large binary payload and cancellation`,
    { timeout: 5000 },
    async (t) => {
      const target = await echo(t);
      const secure = ['tls', 'wss'].includes(type);
      const network = { type: ['ws', 'wss'].includes(type) ? 'ws' : 'tcp', port: 0, option: {} };
      if (secure) network.option.tls = { cert, key };
      if (network.type === 'ws') network.option.path = '/vless';
      const server = createRuntime({
        inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network] }],
      });
      await server.start();
      const client = createRuntime({
        outbounds: [
          {
            protocol: 'vless',
            users: [{ id, encryption: 'none' }],
            networks: [
              {
                ...network,
                address: '127.0.0.1',
                port: server.listenersInfo[0].address.port,
                option: {
                  ...network.option,
                  tls: secure ? { serverName: 'js2ray.test', ca: cert } : undefined,
                },
              },
            ],
          },
        ],
      });
      t.after(() => Promise.all([server.close(), client.close()]));
      await client.start();
      const stream = await client.dial(target);
      const body = Buffer.from('binary\0data\xff'.repeat(10000));
      stream.write(body);
      assert.deepEqual(await readBytes(stream, body.length), body);
      if (network.type === 'ws') {
        stream.write('tail');
        assert.equal((await readBytes(stream, 4)).toString(), 'tail');
        stream.end();
      } else stream.end('tail');
      const tail = [];
      for await (const chunk of stream) tail.push(chunk);
      assert.equal(Buffer.concat(tail).toString(), network.type === 'ws' ? '' : 'tail');
    },
  );
}
