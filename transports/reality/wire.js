'use strict';
const { failure } = require('../../runtime/errors');
const u16 = (number) => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(number);
  return out;
};
const u24 = (number) => {
  const out = Buffer.alloc(3);
  out.writeUIntBE(number, 0, 3);
  return out;
};
const vector = (data) => Buffer.concat([u16(data.length), data]);
const message = (type, data) => Buffer.concat([Buffer.from([type]), u24(data.length), data]);
const extension = (type, data) => Buffer.concat([u16(type), vector(data)]);
const record = (type, data) => Buffer.concat([Buffer.from([type, 3, 3]), vector(data)]);
class Cursor {
  constructor(data) {
    this.data = data;
    this.offset = 0;
  }
  take(size) {
    if (!Number.isInteger(size) || size < 0 || this.offset + size > this.data.length)
      throw failure('ERR_TLS', 'Truncated TLS structure.', 'reality');
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  byte() {
    return this.take(1)[0];
  }
  word() {
    return this.take(2).readUInt16BE();
  }
  vector(bytes = 2) {
    const size = this.take(bytes).readUIntBE(0, bytes);
    return this.take(size);
  }
  done() {
    if (this.offset !== this.data.length)
      throw failure('ERR_TLS', 'Trailing TLS structure bytes.', 'reality');
  }
}
function extensions(data) {
  const cursor = new Cursor(data),
    result = new Map();
  while (cursor.offset < data.length) {
    const type = cursor.word(),
      content = cursor.vector();
    if (result.has(type)) throw failure('ERR_TLS', 'Duplicate TLS extension.', 'reality');
    result.set(type, content);
  }
  return result;
}
function hello(data, server = false) {
  const cursor = new Cursor(data);
  if (cursor.byte() !== (server ? 2 : 1))
    throw failure('ERR_TLS', 'Unexpected TLS handshake type.', 'reality');
  const size = cursor.take(3).readUIntBE(0, 3);
  if (size !== data.length - 4 || cursor.word() !== 0x0303)
    throw failure('ERR_TLS', 'Invalid TLS hello.', 'reality');
  const random = cursor.take(32),
    sessionId = cursor.vector(1);
  if (sessionId.length > 32) throw failure('ERR_TLS', 'Invalid TLS session identity.', 'reality');
  const ciphers = server ? cursor.take(2) : cursor.vector();
  const compression = server ? cursor.take(1) : cursor.vector(1);
  if (!ciphers.length || ciphers.length % 2 || !compression.equals(Buffer.from([0])))
    throw failure('ERR_TLS', 'Invalid TLS cipher or compression vector.', 'reality');
  const list = extensions(cursor.vector());
  cursor.done();
  let serverName;
  if (list.has(0) && !server) {
    const container = new Cursor(list.get(0)),
      names = new Cursor(container.vector());
    container.done();
    if (names.byte() !== 0) throw failure('ERR_TLS', 'Invalid TLS SNI.', 'reality');
    serverName = names.vector().toString('ascii');
    names.done();
  }
  const shareData = list.get(51);
  const shares = [];
  if (shareData) {
    const container = new Cursor(shareData);
    const sharesCursor = new Cursor(server ? shareData : container.vector());
    if (!server) container.done();
    while (sharesCursor.offset < sharesCursor.data.length)
      shares.push({ group: sharesCursor.word(), data: sharesCursor.vector() });
    if (new Set(shares.map((share) => share.group)).size !== shares.length)
      throw failure('ERR_TLS', 'Duplicate TLS key share.', 'reality');
  }
  return {
    random,
    sessionId,
    ciphers,
    compression,
    extensions: list,
    shares,
    serverName,
    raw: data,
  };
}
async function readRecord(reader) {
  const header = await reader.read(5);
  const size = header.readUInt16BE(3);
  if (
    header[1] !== 3 ||
    ![1, 3].includes(header[2]) ||
    ![20, 21, 22, 23].includes(header[0]) ||
    !size ||
    size > 16640
  )
    throw failure('ERR_TLS', 'Invalid TLS record header.', 'reality');
  return Buffer.concat([header, await reader.read(size)]);
}
module.exports = {
  u16,
  u24,
  vector,
  message,
  extension,
  record,
  Cursor,
  extensions,
  hello,
  readRecord,
};
