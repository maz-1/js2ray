'use strict';
const crypto = require('node:crypto');
const { u16, vector, extension } = require('./wire');
// Pinned uTLS 1.6.7 HelloChrome_120 (non-PQ): randomized extension order and
// GREASE ECH. ECH GREASE is deliberately not an encrypted inner ClientHello.
function chrome120(name, publicKey) {
  const grease = () => {
    const byte = (crypto.randomInt(16) << 4) | 10;
    return (byte << 8) | byte;
  };
  const first = grease();
  let last = grease();
  while (last === first) last = grease();
  const group = grease(),
    version = grease(),
    cipher = grease();
  const ciphers = Buffer.concat([
    u16(cipher),
    Buffer.from('130113021303c02bc02fc02cc030cca9cca8c013c014009c009d002f0035', 'hex'),
  ]);
  const nameExtension = extension(0, vector(Buffer.concat([Buffer.from([0]), vector(name)])));
  const ech = Buffer.concat([
    Buffer.from([0]),
    u16(1),
    u16(crypto.randomInt(2) ? 1 : 3),
    crypto.randomBytes(1),
    vector(require('./crypto').keyPair().publicKey),
    vector(crypto.randomBytes(144 + 32 * crypto.randomInt(4))),
  ]);
  const extensions = [
    nameExtension,
    extension(23, Buffer.alloc(0)),
    extension(0xff01, Buffer.from([0])),
    extension(10, vector(Buffer.concat([u16(group), u16(29), u16(23), u16(24)]))),
    extension(11, Buffer.from([1, 0])),
    extension(35, Buffer.alloc(0)),
    extension(16, vector(Buffer.from('02683208687474702f312e31', 'hex'))),
    extension(5, Buffer.from([1, 0, 0, 0, 0])),
    extension(13, vector(Buffer.from('04030804040105030805050108060601', 'hex'))),
    extension(18, Buffer.alloc(0)),
    extension(
      51,
      vector(Buffer.concat([u16(group), vector(Buffer.from([0])), u16(29), vector(publicKey)])),
    ),
    extension(45, Buffer.from([1, 1])),
    extension(43, Buffer.concat([Buffer.from([6]), u16(version), u16(0x0304), u16(0x0303)])),
    extension(27, Buffer.from([2, 0, 2])),
    extension(17513, vector(Buffer.from('026832', 'hex'))),
    extension(0xfe0d, ech),
  ];
  for (let index = extensions.length - 1; index > 0; index--) {
    const other = crypto.randomInt(index + 1);
    [extensions[index], extensions[other]] = [extensions[other], extensions[index]];
  }
  return {
    ciphers,
    extensions: Buffer.concat([
      extension(first, Buffer.alloc(0)),
      ...extensions,
      extension(last, Buffer.from([0])),
    ]),
  };
}
module.exports = { chrome120 };
