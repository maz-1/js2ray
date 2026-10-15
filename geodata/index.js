'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const { iptoBuffer } = require('../core/utils');
const { failure } = require('../runtime/errors');

function protobuf(bytes) {
  let offset = 0;
  const fields = [];
  const uint = () => {
    let value = 0,
      factor = 1;
    for (let i = 0; i < 8; i++) {
      if (offset >= bytes.length) throw failure('ERR_GEODATA', 'Truncated protobuf.', 'geodata');
      const byte = bytes[offset++];
      value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) break;
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw failure('ERR_GEODATA', 'Oversized protobuf integer.', 'geodata');
  };
  while (offset < bytes.length) {
    if (fields.length >= 1000000)
      throw failure('ERR_LIMIT', 'Too many resource fields.', 'geodata');
    const tag = uint(),
      field = Math.floor(tag / 8),
      wire = tag & 7;
    if (!field) throw failure('ERR_GEODATA', 'Invalid protobuf field.', 'geodata');
    let value;
    if (wire === 0) value = uint();
    else {
      const size = wire === 2 ? uint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (size < 0 || offset + size > bytes.length)
        throw failure('ERR_GEODATA', 'Invalid protobuf length or wire type.', 'geodata');
      value = bytes.subarray(offset, offset + size);
      offset += size;
    }
    fields.push({ field, wire, value });
  }
  return fields;
}
const values = (fields, field) =>
  fields.filter((item) => item.field === field).map((item) => item.value);
function addressBytes(address) {
  if (!net.isIP(address)) throw new TypeError('Invalid IP address.');
  let bytes = iptoBuffer(address);
  if (
    bytes.length === 16 &&
    bytes.subarray(0, 12).equals(Buffer.from('00000000000000000000ffff', 'hex'))
  )
    bytes = bytes.subarray(12);
  return bytes;
}
function cidrMatcher(text) {
  if (typeof text !== 'string') throw new TypeError('Invalid CIDR.');
  const parts = text.split('/');
  if (parts.length > 2 || !net.isIP(parts[0])) throw new TypeError('Invalid CIDR.');
  const originalFamily = net.isIP(parts[0]);
  const bytes = addressBytes(parts[0]);
  let prefix = parts.length === 1 ? bytes.length * 8 : Number(parts[1]);
  if (originalFamily === 6 && bytes.length === 4 && parts.length === 2) prefix -= 96;
  if (
    !/^(?:0|[1-9]\d*)$/.test(String(parts[1] ?? prefix)) ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > bytes.length * 8
  )
    throw new TypeError('Invalid CIDR prefix.');
  return (address) => {
    if (!net.isIP(address)) return false;
    const candidate = addressBytes(address);
    if (candidate.length !== bytes.length) return false;
    const whole = Math.floor(prefix / 8),
      rest = prefix % 8;
    return (
      candidate.subarray(0, whole).equals(bytes.subarray(0, whole)) &&
      (!rest || candidate[whole] >> (8 - rest) === bytes[whole] >> (8 - rest))
    );
  };
}
const privateMatchers = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
].map(cidrMatcher);

class GeoData {
  constructor(resources = {}) {
    this.ips = new Map();
    this.sites = new Map();
    this.compiledSites = new Map();
    for (const kind of ['geoip', 'geosite']) {
      const resource = resources[kind];
      if (!resource) continue;
      try {
        if (!resource.version || !/^[a-f\d]{64}$/i.test(resource.sha256))
          throw new Error('Version and SHA256 are required.');
        const size = fs.statSync(resource.path).size;
        if (size > (resource.maxBytes ?? 32 * 1024 * 1024))
          throw new Error('Resource exceeds its size limit.');
        const bytes = fs.readFileSync(resource.path);
        if (
          crypto.createHash('sha256').update(bytes).digest('hex') !== resource.sha256.toLowerCase()
        )
          throw new Error('Resource SHA256 does not match.');
        for (const entry of values(protobuf(bytes), 1)) {
          const fields = protobuf(entry);
          const code = values(fields, 1)[0]?.toString('utf8').toLowerCase();
          const map = kind === 'geoip' ? this.ips : this.sites;
          if (!code || map.has(code)) throw new Error('Invalid or duplicate resource category.');
          if (kind === 'geoip') {
            const matchers = values(fields, 2).map((cidr) => {
              const sub = protobuf(cidr),
                ip = values(sub, 1)[0],
                prefix = values(sub, 2)[0] ?? 0;
              if (!Buffer.isBuffer(ip) || ![4, 16].includes(ip.length))
                throw new Error('Invalid GeoIP address.');
              return cidrMatcher(`${require('../core/utils').iptoString(ip)}/${prefix}`);
            });
            const inverse = Boolean(values(fields, 3)[0]);
            map.set(code, (address) => matchers.some((match) => match(address)) !== inverse);
          } else {
            map.set(
              code,
              values(fields, 2).map((domain) => {
                const sub = protobuf(domain),
                  type = values(sub, 1)[0] ?? 0,
                  value = values(sub, 2)[0]?.toString('utf8');
                if (![0, 1, 2, 3].includes(type) || !value || value.length > 1024)
                  throw new Error('Invalid GeoSite domain.');
                const attributes = values(sub, 3).map((attribute) =>
                  values(protobuf(attribute), 1)[0]?.toString('utf8').toLowerCase(),
                );
                return { type, value, attributes };
              }),
            );
          }
        }
      } catch (cause) {
        throw failure('ERR_GEODATA', `Cannot load ${kind} resource.`, 'geodata', cause);
      }
    }
  }
  ip(category) {
    let inverted = category.startsWith('!');
    const code = (inverted ? category.slice(1) : category).toLowerCase();
    const match =
      code === 'private'
        ? (address) => privateMatchers.some((fn) => fn(address))
        : this.ips.get(code);
    if (!match) throw failure('ERR_GEODATA', 'Referenced GeoIP category is missing.', 'geodata');
    return (address) => net.isIP(address) !== 0 && Boolean(match(address)) !== inverted;
  }
  site(category) {
    const key = category.toLowerCase();
    if (this.compiledSites.has(key)) return this.compiledSites.get(key);
    const [code, ...attributes] = key.split('@');
    const domains = this.sites.get(code);
    if (!domains)
      throw failure('ERR_GEODATA', 'Referenced GeoSite category is missing.', 'geodata');
    const matchers = domains
      .filter((domain) =>
        attributes.every((attribute) =>
          attribute.startsWith('!')
            ? !domain.attributes.includes(attribute.slice(1))
            : domain.attributes.includes(attribute),
        ),
      )
      .map((domain) => {
        if (domain.type === 1) {
          const expression = domain.value.replace(/^\(\?i\)/, '');
          const regex = new RegExp(expression, domain.value.startsWith('(?i)') ? 'i' : '');
          return (host) => regex.test(host);
        }
        return domainMatcher(
          `${['keyword', '', 'domain', 'full'][domain.type]}:${domain.value}`,
          this,
        );
      });
    const result = (host) => matchers.some((fn) => fn(host));
    this.compiledSites.set(key, result);
    return result;
  }
}
function domainMatcher(pattern, data = new GeoData(), plain = 'keyword') {
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 2048)
    throw new TypeError('Invalid domain matcher.');
  const separator = pattern.indexOf(':');
  const mode = separator < 0 ? plain : pattern.slice(0, separator);
  const value = (separator < 0 ? pattern : pattern.slice(separator + 1))
    .toLowerCase()
    .replace(/\.$/, '');
  if (!value) throw new TypeError('Empty domain matcher.');
  if (mode === 'geosite') return data.site(value);
  if (!['full', 'domain', 'keyword'].includes(mode))
    throw new TypeError('Unsupported domain matcher.');
  return (host) => {
    host = host.toLowerCase().replace(/\.$/, '');
    return mode === 'full'
      ? host === value
      : mode === 'domain'
        ? host === value || host.endsWith('.' + value)
        : host.includes(value);
  };
}
function ipMatcher(pattern, data = new GeoData()) {
  return pattern.startsWith('geoip:') ? data.ip(pattern.slice(6)) : cidrMatcher(pattern);
}
module.exports = { GeoData, protobuf, cidrMatcher, domainMatcher, ipMatcher };
