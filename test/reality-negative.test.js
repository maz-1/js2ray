'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('..');
const fixture = require('./fixtures/reality');
const { controlled } = require('./fixtures/reality-flight');
const { RealityStream } = require('../transports/reality/stream');
const handshake = require('../transports/reality/handshake');
const keys = require('../transports/reality/crypto');
const wire = require('../transports/reality/wire');
const { write } = require('../runtime/streams');
const { echo } = require('./helpers');
const { waitFor } = require('./fixtures/reverse');
for (const fault of [
  'certificate',
  'verify',
  'finished',
  'compression-bomb',
  'compression-limit',
  'compression-length',
  'compression-algorithm',
  'compression-corrupt',
])
  test(`REALITY ${fault} fails before VLESS or application bytes leave the client`, async (t) => {
    const server = await controlled(t, { fault }),
      target = await echo(t);
    let reached = 0;
    target.server.on('connection', () => reached++);
    const client = createRuntime({ outbounds: [fixture.bound(server.port)] });
    await client.start();
    t.after(() => client.close());
    await assert.rejects(client.dial(target), (error) =>
      ['ERR_AUTH', 'ERR_TLS', 'ERR_LIMIT'].includes(error.code),
    );
    await server.done;
    assert.equal(server.evidence.receivedAfterFlight, 0);
    assert.equal(reached, 0);
    assert.equal(client.stats.pendingDials + client.stats.connections, 0);
  });
test('REALITY accepts authenticated Brotli certificates across deterministic random handshake/record fragmentation', async (t) => {
  for (const seed of [1, 7, 42, 0xdeadbeef]) {
    const server = await controlled(t, {
      compression: true,
      layout: 'fragmented',
      networkFragments: true,
      seed,
    });
    const raw = await fixture.tcp(server.port);
    const result = await handshake.client(raw, { ...fixture.client, fingerprint: 'chrome120' });
    assert.equal(result.authenticated, true);
    result.tx.destroy();
    result.rx.destroy();
    raw.destroy();
    await server.done;
  }
});
test('REALITY server rejects a validly encrypted but forged client Finished before reaching the VLESS target', async (t) => {
  const cover = await fixture.cover(t),
    target = await echo(t);
  let reached = 0;
  target.server.on('connection', () => reached++);
  const server = createRuntime({ inbounds: [fixture.bound(0, cover)] });
  await server.start();
  t.after(() => server.close());
  const raw = await fixture.tcp(server.listenersInfo[0].address.port);
  t.after(() => raw.destroy());
  const pair = keys.keyPair(),
    own = handshake.clientHello({ ...fixture.client, fingerprint: 'chrome120' }, pair),
    input = handshake.reader(raw);
  await write(raw, wire.record(22, own.hello));
  const reply = await handshake.readHello(input, true),
    suite = keys.suites[reply.parsed.ciphers.readUInt16BE()];
  const shared = keys.exchange(pair.privateKey, reply.parsed.shares[0].data),
    derived = keys.secrets(suite, shared, Buffer.concat([own.hello, reply.bytes]));
  shared.fill(0);
  own.auth.fill(0);
  const tx = new keys.TrafficKey(suite, derived.client),
    rx = new keys.TrafficKey(suite, derived.server);
  let transcript = Buffer.concat([own.hello, reply.bytes]),
    stage = 0,
    buffer = Buffer.alloc(0);
  while (stage < 4) {
    const record = await wire.readRecord(input);
    if (record[0] === 20) continue;
    buffer = Buffer.concat([buffer, rx.open(record).data]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUIntBE(1, 3)) {
      const item = buffer.subarray(0, 4 + buffer.readUIntBE(1, 3));
      buffer = buffer.subarray(item.length);
      transcript = Buffer.concat([transcript, item]);
      stage++;
    }
  }
  const wrong = keys.finished(suite, tx.secret, transcript);
  wrong[0] ^= 1;
  const app = new keys.TrafficKey(
    suite,
    keys.derive(suite, derived.master, 'c ap traffic', transcript),
  );
  const request = require('../protocols/vless').encodeRequest(
    { id: require('./fixtures/vision').id },
    target,
  );
  await write(
    raw,
    Buffer.concat([
      tx.seal(22, wire.message(20, wrong)),
      app.seal(23, Buffer.concat([request, Buffer.from('must-not-arrive')])),
    ]),
  );
  raw.once('end', () => raw.destroy());
  raw.resume();
  await require('node:events').once(raw, 'close');
  await waitFor(() => server.metrics.inbound.active === 0);
  assert.equal(server.metrics.errors.ERR_AUTH, 1);
  assert.equal(reached, 0);
  tx.destroy();
  rx.destroy();
  app.destroy();
  derived.master.fill(0);
});
test('REALITY parser seeded mutations remain bounded and reject low-order X25519 shares', async () => {
  const built = handshake.clientHello(
    { ...fixture.client, fingerprint: 'chrome120' },
    keys.keyPair(),
  );
  let state = 0x1736;
  for (let n = 0; n < 512; n++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const bytes = Buffer.from(built.hello);
    bytes[state % bytes.length] ^= 1 + (state % 255);
    const auth = handshake.authenticate(bytes, fixture.server);
    assert.equal(auth, undefined);
  }
  const bytes = Buffer.from(built.hello),
    share = wire.hello(bytes).shares.find((share) => share.group === 29);
  share.data.fill(0);
  assert.equal(handshake.authenticate(bytes, fixture.server), undefined);
  built.auth.fill(0);
  const fakeRaw = new (require('node:stream').Duplex)({
    read() {},
    write(data, encoding, callback) {
      callback();
    },
  });
  const key = () => new keys.TrafficKey(keys.suites[0x1301], Buffer.alloc(32, 1));
  const stream = new RealityStream(fakeRaw, { tx: key(), rx: key() }, { maxBufferBytes: 32768 });
  stream.on('error', () => {});
  const closed = new Promise((resolve) => stream.once('close', resolve));
  fakeRaw.push(Buffer.from('170303ffff', 'hex'));
  await closed;
  assert.equal(stream.errored.code, 'ERR_LIMIT');
  assert.equal(stream.buffer.length, 0);
});
