'use strict';
const crypto = require('node:crypto');
const { failure } = require('../../runtime/errors');
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : body.length < 256
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
function element(data, position = 0) {
  if (position + 2 > data.length) throw failure('ERR_TLS', 'Truncated certificate DER.', 'reality');
  let offset = position;
  const tag = data[offset++];
  let size = data[offset++];
  if (size & 128) {
    const count = size & 127;
    if (!count || count > 3 || offset + count > data.length)
      throw failure('ERR_TLS', 'Invalid certificate DER length.', 'reality');
    size = data.readUIntBE(offset, count);
    offset += count;
  }
  if (offset + size > data.length)
    throw failure('ERR_TLS', 'Truncated certificate DER.', 'reality');
  return { tag, body: data.subarray(offset, offset + size), next: offset + size };
}
const algorithm = Buffer.from('300506032b6570', 'hex');
function identity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const tbs = der(
    0x30,
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    der(0x30),
    der(0x30, der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('491231235959Z'))),
    der(0x30),
    spki,
  );
  return { privateKey, publicKey: spki.subarray(-32), tbs };
}
function certificate(identity, authKey) {
  const signature = crypto.createHmac('sha512', authKey).update(identity.publicKey).digest();
  return der(0x30, identity.tbs, algorithm, der(3, Buffer.from([0]), signature));
}
function verifyCertificate(bytes, authKey) {
  const cert = new crypto.X509Certificate(bytes);
  if (cert.publicKey.asymmetricKeyType !== 'ed25519')
    throw failure('ERR_AUTH', 'REALITY server authentication failed.', 'reality');
  const outer = element(bytes);
  if (outer.tag !== 0x30 || outer.next !== bytes.length)
    throw failure('ERR_TLS', 'Invalid REALITY certificate.', 'reality');
  const tbs = element(outer.body),
    algorithm = element(outer.body, tbs.next),
    signature = element(outer.body, algorithm.next);
  const expected = crypto
    .createHmac('sha512', authKey)
    .update(cert.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
    .digest();
  if (
    signature.tag !== 3 ||
    signature.body.length !== 65 ||
    signature.body[0] !== 0 ||
    signature.next !== outer.body.length ||
    !crypto.timingSafeEqual(signature.body.subarray(1), expected)
  )
    throw failure('ERR_AUTH', 'REALITY server authentication failed.', 'reality');
  return cert.publicKey;
}
module.exports = { identity, certificate, verifyCertificate };
