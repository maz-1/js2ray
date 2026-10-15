'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { randomBytes, createHash } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { wrap, RecordGate } = require('../transports/vision-tls');
const { listen, readBytes } = require('./helpers');
const { write } = require('../runtime/streams');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'));

async function pair(t, cipher, { fragment = false, coalesce = false } = {}) {
  const sockets = new Set();
  function shape(raw) {
    if (fragment) {
      const read = raw.read;
      raw.read = function (size) {
        return read.call(this, size > 0 ? Math.min(size, 1) : size);
      };
    }
    if (coalesce) {
      const send = raw.write.bind(raw);
      let batch = [],
        scheduled = false;
      raw.write = (chunk, callback) => {
        batch.push(Buffer.from(chunk));
        if (callback) queueMicrotask(() => callback());
        if (!scheduled) {
          scheduled = true;
          setImmediate(() => {
            const data = Buffer.concat(batch);
            batch = [];
            scheduled = false;
            if (!raw.destroyed) send(data);
          });
        }
        return true;
      };
    }
  }
  let accept;
  const connected = new Promise((resolve) => {
    accept = resolve;
  });
  const server = net.createServer({ allowHalfOpen: true }, (raw) => {
    sockets.add(raw);
    shape(raw);
    const stream = wrap(
      raw,
      {
        secureContext: tls.createSecureContext({ cert, key, ciphers: cipher }),
        minVersion: 'TLSv1.3',
      },
      { server: true },
    );
    stream.once('secureConnect', () => accept(stream));
    t.after(() => stream.destroy());
  });
  const port = await listen(server);
  t.after(() => {
    for (const raw of sockets) raw.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const raw = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  await once(raw, 'connect');
  shape(raw);
  const client = wrap(raw, {
    ca: cert,
    servername: 'js2ray.test',
    ciphers: cipher,
    minVersion: 'TLSv1.3',
  });
  t.after(() => client.destroy());
  await once(client, 'secureConnect');
  return [client, await connected];
}
for (const cipher of [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
]) {
  test(`Vision prototype public TLS API: bidirectional switch and buffered bytes ${cipher}`, async (t) => {
    const peers = await pair(t, cipher);
    for (const [sender, receiver] of [peers, [...peers].reverse()]) {
      const prefix = randomBytes(1003);
      const suffix = randomBytes(131103);
      // Deliberately leave plaintext unread while direct bytes are already in TCP.
      const pending = readBytes(receiver, prefix.length);
      await write(sender, prefix);
      sender.switchWrite();
      const writing = write(sender, suffix);
      assert.deepEqual(await pending, prefix);
      receiver.switchRead();
      assert.deepEqual(await readBytes(receiver, suffix.length), suffix);
      await writing;
      assert.equal(receiver.visionState().readDirect, true);
      assert.equal(sender.visionState().writeDirect, true);
    }
    const ended = once(peers[1], 'end');
    peers[1].resume();
    peers[0].end();
    await ended;
  });
}

test('Vision prototype: unread TLS plaintext blocks the next record, 2 MiB transfer stays exact', async (t) => {
  const [client, server] = await pair(t, 'TLS_AES_128_GCM_SHA256');
  const prefix = randomBytes(16001);
  await write(client, prefix);
  client.switchWrite();
  const body = randomBytes(2 * 1024 * 1024 + 17);
  let offset = 0;
  const sending = (async () => {
    for (; offset < body.length; offset += 7001)
      await write(client, body.subarray(offset, offset + 7001));
  })();
  assert.deepEqual(await readBytes(server, 7), prefix.subarray(0, 7));
  assert.deepEqual(await readBytes(server, prefix.length - 7), prefix.subarray(7));
  server.switchRead();
  const hash = createHash('sha256');
  let received = 0;
  while (received < body.length) {
    const size = Math.min(509, body.length - received);
    hash.update(await readBytes(server, size));
    received += size;
  }
  await sending;
  assert.equal(hash.digest('hex'), createHash('sha256').update(body).digest('hex'));
});

test('Vision prototype: one-byte encrypted reads plus coalesced final ciphertext/direct data', async (t) => {
  const peers = await pair(t, 'TLS_AES_128_GCM_SHA256', { fragment: true, coalesce: true });
  for (const [sender, receiver] of [peers, [...peers].reverse()]) {
    const prefix = randomBytes(71),
      body = randomBytes(2017);
    const reading = readBytes(receiver, prefix.length);
    await write(sender, prefix);
    sender.switchWrite();
    await write(sender, body);
    assert.deepEqual(await reading, prefix);
    receiver.switchRead();
    assert.deepEqual(await readBytes(receiver, body.length), body);
  }
});

test('Vision TLS record gate fixed synthetic vectors: sequence, KeyUpdate, authentication and late TLS writes', async () => {
  const vectors = [
    [
      32,
      [
        '1703030014607fd351e26f2298a938f36b82ebb8056ea5c697',
        '17030300161a0d055fb0c4c084bf17bc1116e30fc339e59016f584',
        '1703030016667561b9c88cd9ad95db26cc8f24283ff076d031e362',
      ],
    ],
    [
      48,
      [
        '170303001497e92ba0d13aa69b9d5535d87c4c3c0efbad04b1',
        '17030300163f1065c01ac681b95a12214cac603ae4c42c844495d3',
        '17030300165a877aec0c2a7b1c184294d7df773944b0b05c4458b8',
      ],
    ],
    [
      32,
      [
        '17030300146809a8838b23dd6b210276fb9a46189a67e5bc71',
        '1703030016b303767d6943a14bfd9eba942d714369754c1e40eba2',
        '1703030016f7e3f5a5f6416ce848c1ebab3fee75e5354c4a5bbf26',
      ],
    ],
  ];
  for (const [length, records] of vectors) {
    const gate = new RecordGate(new PassThrough());
    gate.secret(Buffer.from('SERVER_TRAFFIC_SECRET_0 synthetic ' + '11'.repeat(length)));
    assert.equal(gate.plaintext(Buffer.from(records[0], 'hex')), 3);
    assert.equal(gate.plaintext(Buffer.from(records[1], 'hex')), 0);
    assert.equal(gate.sequence, 0n);
    assert.equal(gate.plaintext(Buffer.from(records[2], 'hex')), 5);
    assert.throws(() => gate.plaintext(Buffer.from(records[2], 'hex')));
    const secret = gate.readSecret;
    gate.switchRead();
    assert.equal(
      secret.every((byte) => byte === 0),
      true,
    );
    gate.writeDirect = true;
    await assert.rejects(write(gate, Buffer.from('late outer TLS')), { code: 'ERR_TLS' });
    gate.destroy();
  }
});

test('Vision TLS record gate rejects zero-length, oversized and truncated encrypted records', async () => {
  for (const header of ['1703030000', '170303ffff', '1703030002ff']) {
    const raw = new PassThrough();
    const gate = new RecordGate(raw);
    const error = once(gate, 'error');
    raw.end(Buffer.from(header, 'hex'));
    assert.equal((await error)[0].code, 'ERR_TLS');
  }
});

test('Vision TLS record gate waits for a delayed public secret event before admitting application ciphertext', async () => {
  const raw = new PassThrough();
  const gate = new RecordGate(raw);
  const record = Buffer.from('1703030014607fd351e26f2298a938f36b82ebb8056ea5c697', 'hex');
  let admitted = 0;
  gate.on('data', (chunk) => {
    assert.deepEqual(chunk, record);
    admitted++;
    gate.credit(3);
    gate.switchRead();
  });
  let finish;
  const switched = new Promise((resolve) => {
    finish = resolve;
  });
  gate.onDirectReadable = () => {
    assert.equal(raw.read().toString(), 'direct bytes');
    finish();
  };
  raw.write(Buffer.concat([record, Buffer.from('direct bytes')]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, 0);
  assert.deepEqual(gate.buffer, record);
  gate.secret(Buffer.from('SERVER_TRAFFIC_SECRET_0 synthetic ' + '11'.repeat(32)));
  await switched;
  assert.equal(admitted, 1);
  gate.destroy();
});
