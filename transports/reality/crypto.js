'use strict';
const crypto = require('node:crypto');
const { failure } = require('../../runtime/errors');
const suites = {
  0x1301: { hash: 'sha256', size: 32, algorithm: 'aes-128-gcm', keySize: 16 },
  0x1302: { hash: 'sha384', size: 48, algorithm: 'aes-256-gcm', keySize: 32 },
  0x1303: { hash: 'sha256', size: 32, algorithm: 'chacha20-poly1305', keySize: 32 },
};
const hash = (suite, data) => crypto.createHash(suite.hash).update(data).digest();
const mac = (suite, key, data) => crypto.createHmac(suite.hash, key).update(data).digest();
function expand(suite, secret, label, context, size) {
  const name = Buffer.from('tls13 ' + label);
  const info = Buffer.concat([
    Buffer.from([size >> 8, size & 255, name.length]),
    name,
    Buffer.from([context.length]),
    context,
  ]);
  let previous = Buffer.alloc(0),
    output = Buffer.alloc(0);
  for (let index = 1; output.length < size; index++) {
    previous = mac(suite, secret, Buffer.concat([previous, info, Buffer.from([index])]));
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, size);
}
const derive = (suite, secret, label, transcript) =>
  expand(suite, secret, label, hash(suite, transcript), suite.size);
function secrets(suite, shared, transcript) {
  const zero = Buffer.alloc(suite.size);
  const early = mac(suite, zero, zero);
  const handshake = mac(suite, derive(suite, early, 'derived', Buffer.alloc(0)), shared);
  const master = mac(suite, derive(suite, handshake, 'derived', Buffer.alloc(0)), zero);
  const client = derive(suite, handshake, 'c hs traffic', transcript);
  const server = derive(suite, handshake, 's hs traffic', transcript);
  early.fill(0);
  handshake.fill(0);
  return { master, client, server };
}
const finished = (suite, secret, transcript) =>
  mac(
    suite,
    expand(suite, secret, 'finished', Buffer.alloc(0), suite.size),
    hash(suite, transcript),
  );
const privateKey = (bytes) =>
  crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), bytes]),
    format: 'der',
    type: 'pkcs8',
  });
const publicKey = (bytes) =>
  crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), bytes]),
    format: 'der',
    type: 'spki',
  });
function keyPair() {
  const pair = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
}
const exchange = (key, bytes) =>
  crypto.diffieHellman({ privateKey: key, publicKey: publicKey(bytes) });
function authKey(shared, random) {
  return Buffer.from(
    crypto.hkdfSync('sha256', shared, random.subarray(0, 20), Buffer.from('REALITY'), 32),
  );
}
function authSeal(key, random, plaintext, hello, algorithm = 'aes-256-gcm') {
  const cipher = crypto.createCipheriv(algorithm, key, random.subarray(20), { authTagLength: 16 });
  cipher.setAAD(hello);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function authOpen(key, random, ciphertext, hello, algorithm = 'aes-256-gcm') {
  const cipher = crypto.createDecipheriv(algorithm, key, random.subarray(20), {
    authTagLength: 16,
  });
  cipher.setAAD(hello);
  cipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
}
class TrafficKey {
  constructor(suite, secret) {
    this.suite = suite;
    this.secret = secret;
    this.reset();
  }
  reset() {
    this.key = expand(this.suite, this.secret, 'key', Buffer.alloc(0), this.suite.keySize);
    this.iv = expand(this.suite, this.secret, 'iv', Buffer.alloc(0), 12);
    this.sequence = 0n;
  }
  nonce() {
    if (this.sequence >= 0x10000000000000000n)
      throw failure('ERR_TLS', 'TLS record sequence exhausted.', 'reality');
    const iv = Buffer.from(this.iv),
      count = Buffer.alloc(8);
    count.writeBigUInt64BE(this.sequence++);
    for (let i = 0; i < 8; i++) iv[4 + i] ^= count[i];
    return iv;
  }
  seal(type, data, wireSize = 0) {
    const size = Math.max(data.length + 22, wireSize);
    if (data.length > 16384 || size > 16645 || (wireSize && wireSize < data.length + 22))
      throw failure('ERR_LIMIT', 'TLS record exceeds its limit.', 'reality');
    const header = Buffer.from([23, 3, 3, (size - 5) >> 8, (size - 5) & 255]);
    const plain = Buffer.concat([data, Buffer.from([type]), Buffer.alloc(size - data.length - 22)]);
    const cipher = crypto.createCipheriv(this.suite.algorithm, this.key, this.nonce(), {
      authTagLength: 16,
    });
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
  open(record) {
    if (
      record[0] !== 23 ||
      record[1] !== 3 ||
      record[2] !== 3 ||
      record.length < 22 ||
      record.length > 16645 ||
      record.readUInt16BE(3) !== record.length - 5
    )
      throw failure('ERR_TLS', 'Invalid TLS ciphertext record.', 'reality');
    const cipher = crypto.createDecipheriv(this.suite.algorithm, this.key, this.nonce(), {
      authTagLength: 16,
    });
    cipher.setAAD(record.subarray(0, 5));
    cipher.setAuthTag(record.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(record.subarray(5, -16)), cipher.final()]);
    let end = plaintext.length - 1;
    while (end >= 0 && plaintext[end] === 0) end--;
    if (end < 0 || end > 16384 || ![21, 22, 23].includes(plaintext[end]))
      throw failure('ERR_TLS', 'Invalid TLS inner type or content length.', 'reality');
    return { type: plaintext[end], data: plaintext.subarray(0, end) };
  }
  update() {
    const next = expand(this.suite, this.secret, 'traffic upd', Buffer.alloc(0), this.suite.size);
    this.destroy();
    this.secret = next;
    this.reset();
  }
  destroy() {
    this.secret.fill(0);
    this.key.fill(0);
    this.iv.fill(0);
  }
}
module.exports = {
  suites,
  hash,
  mac,
  expand,
  derive,
  secrets,
  finished,
  privateKey,
  keyPair,
  exchange,
  authKey,
  authSeal,
  authOpen,
  TrafficKey,
};
