'use strict';
const crypto = require('node:crypto');
const { iptoString, iptoBuffer } = require('../core/utils');
const { failure, Js2rayError } = require('../runtime/errors');

function query(host, type, id = crypto.randomInt(65536), clientIp) {
  if (host.length > 253) throw new TypeError('DNS name exceeds 253 characters.');
  const labels = host
    .replace(/\.$/, '')
    .split('.')
    .map((label) => {
      const bytes = Buffer.from(label, 'ascii');
      if (!bytes.length || bytes.length > 63) throw new TypeError('Invalid DNS name.');
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id);
  header.writeUInt16BE(0x100, 2);
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  let opt = Buffer.alloc(0);
  if (clientIp !== undefined) {
    const family = require('node:net').isIP(clientIp);
    if (!family) throw new TypeError('Invalid ECS IP address.');
    const address = iptoBuffer(clientIp).subarray(0, family === 4 ? 3 : 12);
    opt = Buffer.alloc(19 + address.length);
    opt.writeUInt16BE(41, 1);
    opt.writeUInt16BE(1350, 3);
    opt.writeUInt32BE(0x8000, 5);
    opt.writeUInt16BE(8 + address.length, 9);
    opt.writeUInt16BE(8, 11);
    opt.writeUInt16BE(4 + address.length, 13);
    opt.writeUInt16BE(family === 4 ? 1 : 2, 15);
    opt[17] = family === 4 ? 24 : 96;
    address.copy(opt, 19);
    header.writeUInt16BE(1, 10);
  }
  return Buffer.concat([header, ...labels, tail, opt]);
}
function ecs(bytes) {
  if (
    bytes.length < 12 ||
    bytes.readUInt16BE(4) !== 1 ||
    bytes.readUInt16BE(6) ||
    bytes.readUInt16BE(8)
  )
    throw new TypeError('Invalid ECS query header.');
  let offset = name(bytes, 12).end + 4,
    found;
  for (let i = 0; i < bytes.readUInt16BE(10); i++) {
    offset = name(bytes, offset).end;
    if (offset + 10 > bytes.length) throw new TypeError('Truncated EDNS record.');
    const type = bytes.readUInt16BE(offset),
      length = bytes.readUInt16BE(offset + 8);
    offset += 10;
    const end = offset + length;
    if (end > bytes.length) throw new TypeError('Truncated EDNS options.');
    if (type !== 41) {
      offset = end;
      continue;
    }
    while (offset < end) {
      if (offset + 4 > end) throw new TypeError('Truncated EDNS option.');
      const code = bytes.readUInt16BE(offset),
        size = bytes.readUInt16BE(offset + 2);
      offset += 4;
      if (offset + size > end) throw new TypeError('Truncated EDNS option data.');
      if (code === 8) {
        if (found || size < 4) throw new TypeError('Invalid ECS option.');
        const wireFamily = bytes.readUInt16BE(offset),
          family = wireFamily === 1 ? 4 : wireFamily === 2 ? 6 : 0,
          prefix = bytes[offset + 2];
        if (!family || prefix > (family === 4 ? 32 : 128) || size !== 4 + Math.ceil(prefix / 8))
          throw new TypeError('Invalid ECS prefix.');
        const address = Buffer.alloc(family === 4 ? 4 : 16);
        bytes.copy(address, 0, offset + 4, offset + size);
        found = { family, prefix, address: iptoString(address) };
      }
      offset += size;
    }
  }
  if (offset !== bytes.length) throw new TypeError('Trailing DNS query data.');
  return found;
}
function name(bytes, offset) {
  const seen = new Set();
  const labels = [];
  let end;
  for (let i = 0; i < 128; i++) {
    if (offset >= bytes.length || seen.has(offset)) throw new Error('Invalid compressed DNS name.');
    seen.add(offset);
    const length = bytes[offset++];
    if ((length & 192) === 192) {
      if (offset >= bytes.length) throw new Error('Truncated DNS pointer.');
      end ??= offset + 1;
      offset = ((length & 63) << 8) | bytes[offset];
      continue;
    }
    if (length & 192 || length > 63 || offset + length > bytes.length)
      throw new Error('Invalid DNS label.');
    if (!length) return { value: labels.join('.').toLowerCase(), end: end ?? offset };
    labels.push(bytes.toString('ascii', offset, offset + length));
    offset += length;
    if (labels.join('.').length > 253) throw new Error('Oversized DNS name.');
  }
  throw new Error('Too many DNS pointers.');
}
function response(bytes, request) {
  try {
    if (
      bytes.length < 12 ||
      bytes.length > 65535 ||
      bytes.readUInt16BE() !== request.readUInt16BE()
    )
      throw new Error('Invalid DNS reply ID.');
    const flags = bytes.readUInt16BE(2);
    if (!(flags & 0x8000) || flags & 0x7800 || bytes.readUInt16BE(4) !== 1)
      throw new Error('Invalid DNS reply header.');
    const wanted = name(request, 12),
      question = name(bytes, 12);
    if (
      question.value !== wanted.value ||
      question.end + 4 > bytes.length ||
      !bytes
        .subarray(question.end, question.end + 4)
        .equals(request.subarray(wanted.end, wanted.end + 4))
    )
      throw new Error('DNS question mismatch.');
    if (flags & 0x200) return { truncated: true, records: [] };
    if (flags & 15)
      throw new Js2rayError('ERR_DNS', 'DNS server returned an error.', {
        phase: 'dns',
        context: { rcode: flags & 15 },
      });
    const count = bytes.readUInt16BE(6);
    if (count > 4096) throw new Error('Too many DNS answers.');
    let offset = question.end + 4;
    const records = [];
    for (let i = 0; i < count; i++) {
      const owner = name(bytes, offset);
      offset = owner.end;
      if (offset + 10 > bytes.length) throw new Error('Truncated DNS answer.');
      const type = bytes.readUInt16BE(offset),
        cls = bytes.readUInt16BE(offset + 2),
        ttl = bytes.readUInt32BE(offset + 4),
        length = bytes.readUInt16BE(offset + 8);
      offset += 10;
      if (offset + length > bytes.length) throw new Error('Truncated DNS payload.');
      if (cls === 1 && ((type === 1 && length === 4) || (type === 28 && length === 16)))
        records.push({
          owner: owner.value,
          type,
          address: iptoString(bytes.subarray(offset, offset + length)),
          ttl,
        });
      if (cls === 1 && type === 5) {
        const alias = name(bytes, offset);
        if (alias.end !== offset + length) throw new Error('Invalid CNAME payload length.');
        records.push({ owner: owner.value, type, alias: alias.value, ttl });
      }
      offset += length;
    }
    const allowed = new Set([wanted.value]);
    for (let i = 0; i < 16; i++)
      for (const record of records)
        if (record.type === 5 && allowed.has(record.owner)) allowed.add(record.alias);
    const type = request.readUInt16BE(wanted.end);
    const aliasTtl = Math.min(
      ...records
        .filter((record) => record.type === 5 && allowed.has(record.owner))
        .map((record) => record.ttl),
    );
    return {
      truncated: false,
      records: records
        .filter((record) => record.type === type && allowed.has(record.owner))
        .map((record) => ({ ...record, ttl: Math.min(record.ttl, aliasTtl) })),
    };
  } catch (cause) {
    if (cause instanceof Js2rayError) throw cause;
    throw failure('ERR_DNS', 'Invalid or unsuccessful DNS response.', 'dns', cause);
  }
}
module.exports = { query, response, name, ecs };
