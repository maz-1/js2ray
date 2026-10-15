'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const keys = require('../transports/reality/crypto');
const handshake = require('../transports/reality/handshake');
const wire = require('../transports/reality/wire');
const certs = require('../transports/reality/certificate');
const fixture = require('./fixtures/reality');
for (const [id, length, record] of [
  [0x1301, 32, '1703030014607fd351e26f2298a938f36b82ebb8056ea5c697'],
  [0x1302, 48, '170303001497e92ba0d13aa69b9d5535d87c4c3c0efbad04b1'],
  [0x1303, 32, '17030300146809a8838b23dd6b210276fb9a46189a67e5bc71'],
]) {
  test(`REALITY TLS 1.3 fixed record vector ${id.toString(16)}, authentication, sequence, padding and erasure`, () => {
    const suite = keys.suites[id];
    const tx = new keys.TrafficKey(suite, Buffer.alloc(length, 0x11));
    const rx = new keys.TrafficKey(suite, Buffer.alloc(length, 0x11));
    const body = Buffer.from('one');
    assert.equal(tx.seal(23, body).toString('hex'), record);
    assert.deepEqual(rx.open(Buffer.from(record, 'hex')), { type: 23, data: body });
    assert.throws(() => rx.open(Buffer.from(record, 'hex')));
    tx.destroy();
    rx.destroy();
    assert.equal(
      tx.secret.every((byte) => byte === 0),
      true,
    );
    const a = new keys.TrafficKey(suite, Buffer.alloc(length, 0x11)),
      b = new keys.TrafficKey(suite, Buffer.alloc(length, 0x11));
    a.update();
    b.update();
    const padded = a.seal(23, body, 4096);
    assert.equal(padded.length, 4096);
    assert.deepEqual(b.open(padded).data, body);
    assert.throws(() => a.seal(23, body, 22), { code: 'ERR_LIMIT' });
    a.sequence = 0x10000000000000000n;
    assert.throws(() => a.seal(23, body), { code: 'ERR_TLS' });
    a.destroy();
    b.destroy();
  });
}
test('REALITY ClientHello authentication binds random, full transcript, key share, short ID, time and version', () => {
  const pair = keys.keyPair();
  const config = { ...fixture.client, fingerprint: 'chrome120', clientVersion: '4.0.0' };
  const built = handshake.clientHello(config, pair);
  const valid = handshake.authenticate(built.hello, fixture.server);
  assert.ok(valid);
  assert.deepEqual(valid.auth, built.auth);
  valid.auth.fill(0);
  for (const offset of [6, 37, 39, built.hello.length - 1]) {
    const mutated = Buffer.from(built.hello);
    mutated[offset] ^= 1;
    let accepted;
    try {
      accepted = handshake.authenticate(mutated, fixture.server);
    } catch {}
    assert.equal(accepted, undefined);
  }
  for (const changed of [
    { shortIds: ['ff'] },
    { serverNames: ['wrong.test'] },
    { maxTimeDiff: 1 },
    { minClientVer: '4.0.1' },
    { maxClientVer: '3.255.255' },
  ])
    assert.equal(
      handshake.authenticate(built.hello, { ...fixture.server, ...changed }, Date.now() + 1000),
      undefined,
    );
  assert.equal(handshake.authenticate(built.hello, fixture.server, Date.now() + 61000), undefined);
  built.auth.fill(0);
});
test('REALITY certificate authentication is mandatory and independent of public CA trust', () => {
  const identity = certs.identity(),
    auth = crypto.randomBytes(32);
  const certificate = certs.certificate(identity, auth);
  const verified = certs.verifyCertificate(certificate, auth);
  assert.equal(verified.asymmetricKeyType, 'ed25519');
  assert.throws(() => certs.verifyCertificate(certificate, Buffer.alloc(32)), { code: 'ERR_AUTH' });
  const mutated = Buffer.from(certificate);
  mutated[mutated.length - 1] ^= 1;
  assert.throws(() => certs.verifyCertificate(mutated, auth), { code: 'ERR_AUTH' });
  assert.throws(
    () =>
      certs.verifyCertificate(
        new crypto.X509Certificate(require('./fixtures/vision').cert).raw,
        auth,
      ),
    { code: 'ERR_AUTH' },
  );
});
test('REALITY wire parser rejects malformed vectors, duplicate extensions, oversized and truncated records', async () => {
  assert.throws(() => new wire.Cursor(Buffer.from([0, 4, 1])).vector(), { code: 'ERR_TLS' });
  assert.throws(
    () =>
      wire.extensions(
        Buffer.concat([
          wire.extension(43, Buffer.from([3, 4])),
          wire.extension(43, Buffer.from([3, 4])),
        ]),
      ),
    { code: 'ERR_TLS' },
  );
  for (const value of ['1703030000', '170303ffff', '1703030002ff']) {
    const source = Readable.from([Buffer.from(value, 'hex')], { objectMode: false });
    await assert.rejects(wire.readRecord(handshake.reader(source)));
  }
  const built = handshake.clientHello(fixture.client, keys.keyPair());
  for (let n = 0; n < built.hello.length; n++)
    assert.throws(() => wire.hello(built.hello.subarray(0, n)), { code: 'ERR_TLS' });
  built.auth.fill(0);
});
