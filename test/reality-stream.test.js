'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { RealityStream } = require('../transports/reality/stream');
const { TrafficKey, suites } = require('../transports/reality/crypto');
const { message } = require('../transports/reality/wire');
const { write } = require('../runtime/streams');
const { listen, readBytes } = require('./helpers');
async function pair(t, options = {}) {
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const server = net.createServer({ allowHalfOpen: true }, accept);
  const port = await listen(server);
  const peer = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  peer.on('error', () => {});
  const raw = await accepted;
  const key = () => new TrafficKey(suites[0x1301], Buffer.alloc(32, 0x11));
  const tx = key(),
    rx = key();
  const stream = new RealityStream(raw, { tx: key(), rx: key() }, options);
  t.after(() => {
    stream.destroy();
    peer.destroy();
    tx.destroy();
    rx.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return { stream, raw, peer, tx, rx };
}
test('REALITY record stream preserves one-byte ciphertext reads, buffered plaintext and authenticated half-close', async (t) => {
  const { stream, peer, tx } = await pair(t);
  const body = randomBytes(40001);
  const ciphertext = Buffer.concat([
    tx.seal(23, body.subarray(0, 16384)),
    tx.seal(23, body.subarray(16384, 32768)),
    tx.seal(23, body.subarray(32768)),
    tx.seal(21, Buffer.from([1, 0])),
  ]);
  // Leave plaintext unread while the peer finishes its write side.
  for (let n = 0; n < 40; n++) await write(peer, ciphertext.subarray(n, n + 1));
  peer.end(ciphertext.subarray(40));
  assert.deepEqual(await readBytes(stream, body.length), body);
  const end = once(stream, 'end');
  stream.resume();
  await end;
  // A read EOF must still permit writes in the opposite direction.
  await write(stream, Buffer.from('after-eof'));
  const record = await require('../transports/reality/wire').readRecord(
    require('../transports/reality/handshake').reader(peer),
  );
  const decoder = new TrafficKey(suites[0x1301], Buffer.alloc(32, 0x11));
  assert.equal(decoder.open(record).data.toString(), 'after-eof');
  decoder.destroy();
  stream.end();
  await once(stream, 'close');
});
test('REALITY manual gate retains coalesced Direct bytes until the final TLS record is consumed', async (t) => {
  const { stream, peer, tx } = await pair(t, { manual: true });
  const before = randomBytes(123),
    after = randomBytes(131091);
  await write(peer, Buffer.concat([tx.seal(23, before), after]));
  assert.deepEqual(await readBytes(stream, before.length), before);
  assert.equal(stream.readableLength, 0);
  stream.switchRead();
  stream.switchWrite();
  assert.deepEqual(await readBytes(stream, after.length), after);
  await write(stream, Buffer.from('direct'));
  assert.equal((await readBytes(peer, 6)).toString(), 'direct');
  assert.ok(stream.rx.secret.every((n) => n === 0));
  assert.ok(stream.tx.secret.every((n) => n === 0));
});
test('REALITY fragmented post-handshake KeyUpdate changes both sequences and acknowledges with the prior write key', async (t) => {
  const { stream, peer, tx, rx } = await pair(t);
  const update = message(24, Buffer.from([1]));
  await write(
    peer,
    Buffer.concat([tx.seal(22, update.subarray(0, 2)), tx.seal(22, update.subarray(2))]),
  );
  tx.update();
  await write(peer, tx.seal(23, Buffer.from('new-key')));
  assert.equal((await readBytes(stream, 7)).toString(), 'new-key');
  const input = require('../transports/reality/handshake').reader(peer);
  assert.deepEqual(rx.open(await require('../transports/reality/wire').readRecord(input)), {
    type: 22,
    data: message(24, Buffer.from([0])),
  });
  rx.update();
  await write(stream, Buffer.from('reply'));
  assert.equal(
    rx.open(await require('../transports/reality/wire').readRecord(input)).data.toString(),
    'reply',
  );
});
test('REALITY rejects corrupted, truncated and invalid control records without releasing plaintext', async (t) => {
  for (const mode of ['tag', 'truncated', 'control', 'update-boundary']) {
    const { stream, peer, tx } = await pair(t);
    const error = once(stream, 'error');
    let bytes =
      mode === 'control'
        ? tx.seal(22, message(1, Buffer.alloc(0)))
        : mode === 'update-boundary'
          ? tx.seal(22, Buffer.concat([message(24, Buffer.from([0])), message(4, Buffer.alloc(0))]))
          : tx.seal(23, Buffer.from('secret'));
    if (mode === 'tag') bytes[bytes.length - 1] ^= 1;
    if (mode === 'truncated') peer.end(bytes.subarray(0, -1));
    else await write(peer, bytes);
    assert.match((await error)[0].code, /^ERR_(TLS|PROTOCOL)$/);
    assert.equal(stream.readableLength, 0);
  }
});
test('REALITY bounds oversized writes and consumer-raised read watermarks', async (t) => {
  const { stream, peer, tx } = await pair(t, { maxBufferBytes: 32768 });
  stream.read(1 << 20);
  const error = once(stream, 'error');
  await write(
    peer,
    Buffer.concat(Array.from({ length: 3 }, () => tx.seal(23, Buffer.alloc(16384)))),
  );
  assert.equal((await error)[0].code, 'ERR_LIMIT');
  const other = await pair(t, { maxBufferBytes: 32768 });
  await assert.rejects(write(other.stream, Buffer.alloc(32769)), { code: 'ERR_LIMIT' });
});
