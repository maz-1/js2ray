'use strict';
const net = require('node:net');
const { iptoBuffer, iptoString } = require('../../core/utils');
const { host: validHost } = require('../../config');
const { failure } = require('../../runtime/errors');
const invalid = () => failure('ERR_PROTOCOL', 'Invalid Mux frame.', 'mux');
function encode({ id, status, error = false, target, data, globalId }) {
  if (!Number.isInteger(id) || id < 0 || id > 65535 || ![1, 2, 3, 4].includes(status))
    throw invalid();
  let address = Buffer.alloc(0);
  if (status === 1 || (status === 2 && target?.network === 'udp')) {
    if (
      !target ||
      !validHost(target.host) ||
      !Number.isInteger(target.port) ||
      target.port < 0 ||
      target.port > 65535 ||
      !['tcp', 'udp'].includes(target.network ?? 'tcp')
    )
      throw invalid();
    const family = net.isIP(target.host),
      name = Buffer.from(target.host);
    if (!family && name.length > 255) throw invalid();
    const prefix = Buffer.alloc(4);
    prefix[0] = target.network === 'udp' ? 2 : 1;
    prefix.writeUInt16BE(target.port, 1);
    prefix[3] = family === 4 ? 1 : family === 6 ? 3 : 2;
    address = Buffer.concat([
      prefix,
      family ? iptoBuffer(target.host) : Buffer.concat([Buffer.from([name.length]), name]),
    ]);
    if (status === 1 && globalId !== undefined) {
      if (!Buffer.isBuffer(globalId) || globalId.length !== 8 || target.network !== 'udp')
        throw invalid();
      address = Buffer.concat([address, globalId]);
    }
  }
  if (data !== undefined && (!Buffer.isBuffer(data) || data.length > 65535)) throw invalid();
  const head = Buffer.alloc(6);
  head.writeUInt16BE(4 + address.length);
  head.writeUInt16BE(id, 2);
  head[4] = status;
  head[5] = (data !== undefined ? 1 : 0) | (error ? 2 : 0);
  const size = Buffer.alloc(data !== undefined ? 2 : 0);
  if (size.length) size.writeUInt16BE(data.length);
  return Buffer.concat([head, address, size, data ?? Buffer.alloc(0)]);
}
function decode(buffer) {
  if (buffer.length < 2) return undefined;
  const length = buffer.readUInt16BE();
  if (length < 4 || length > 512) throw invalid();
  if (buffer.length < 2 + length) return undefined;
  const metadata = buffer.subarray(2, 2 + length),
    id = metadata.readUInt16BE(),
    status = metadata[2],
    flags = metadata[3];
  if (![1, 2, 3, 4].includes(status) || flags & ~3) throw invalid();
  let target;
  if (status === 1 || (status === 2 && length > 4 && metadata[4] === 2)) {
    if (length < 8 || ![1, 2].includes(metadata[4])) throw invalid();
    const port = metadata.readUInt16BE(5),
      type = metadata[7];
    let host;
    if (type === 1 || type === 3) {
      const bytes = type === 1 ? 4 : 16;
      if (length < 8 + bytes) throw invalid();
      host = iptoString(metadata.subarray(8, 8 + bytes));
    } else if (type === 2) {
      if (length < 9 || !metadata[8] || length < 9 + metadata[8]) throw invalid();
      host = metadata.subarray(9, 9 + metadata[8]).toString('utf8');
    } else throw invalid();
    if (!validHost(host)) throw invalid();
    target = { host, port, network: metadata[4] === 1 ? 'tcp' : 'udp' };
  }
  let end = length + 2,
    data;
  if (flags & 1) {
    if (buffer.length < end + 2) return undefined;
    const size = buffer.readUInt16BE(end);
    end += 2;
    if (buffer.length < end + size) return undefined;
    data = buffer.subarray(end, end + size);
    end += size;
  }
  return { id, status, error: Boolean(flags & 2), target, data, bytes: end };
}
module.exports = { encode, decode };
