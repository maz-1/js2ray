'use strict';
const { domainToASCII } = require('node:url');
const dnsName = (value) =>
  typeof value === 'string' ? domainToASCII(value.replace(/\.$/, '')).toLowerCase() : '';
const key = (value) =>
  typeof value === 'string' &&
  /^[a-z\d_-]{43}$/i.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const shortId = (value) => typeof value === 'string' && /^(?:[a-f\d]{2}){0,8}$/i.test(value);
function version(value) {
  return (
    typeof value === 'string' &&
    /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) &&
    value.split('.').every((n) => Number(n) <= 255)
  );
}
function validate(value, { add, prefix, inbound, host, port }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add(prefix, 'Expected REALITY settings.');
    return;
  }
  const fields = inbound
    ? [
        'dest',
        'privateKey',
        'serverNames',
        'shortIds',
        'maxTimeDiff',
        'minClientVer',
        'maxClientVer',
        'show',
        'xver',
      ]
    : ['publicKey', 'serverName', 'shortId', 'fingerprint', 'clientVersion', 'show'];
  for (const field of Object.keys(value))
    if (!fields.includes(field)) add(prefix + '.' + field, 'Unsupported REALITY behavior field.');
  if (!key(value[inbound ? 'privateKey' : 'publicKey']))
    add(
      prefix + (inbound ? '.privateKey' : '.publicKey'),
      'Expected a canonical 32-byte base64url X25519 key.',
    );
  if (value.show !== undefined && value.show !== false)
    add(prefix + '.show', 'REALITY key logging is disabled.');
  if (inbound) {
    const match =
      typeof value.dest === 'string' && /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value.dest);
    if (!match || !host(match[1] || match[2]) || !port(Number(match[3])))
      add(prefix + '.dest', 'Expected a fixed TCP destination host:port.');
    if (
      !Array.isArray(value.serverNames) ||
      !value.serverNames.length ||
      value.serverNames.length > 128 ||
      value.serverNames.some((name) => !host(name) || require('node:net').isIP(name))
    )
      add(prefix + '.serverNames', 'Expected 1–128 explicit DNS names.');
    if (
      !Array.isArray(value.shortIds) ||
      !value.shortIds.length ||
      value.shortIds.length > 128 ||
      value.shortIds.some((id) => !shortId(id)) ||
      new Set(
        value.shortIds.map((id) =>
          typeof id === 'string' ? id.toLowerCase().padEnd(16, '0') : id,
        ),
      ).size !== value.shortIds.length
    )
      add(prefix + '.shortIds', 'Expected 1–128 unique hex short IDs, at most 8 bytes each.');
    if (value.xver !== undefined && value.xver !== 0)
      add(prefix + '.xver', 'REALITY PROXY protocol is unsupported.');
    if (
      value.maxTimeDiff !== undefined &&
      (!Number.isSafeInteger(value.maxTimeDiff) ||
        value.maxTimeDiff < 0 ||
        value.maxTimeDiff > 86400000)
    )
      add(prefix + '.maxTimeDiff', 'Expected a time tolerance from 0 to 86400000 milliseconds.');
    for (const field of ['minClientVer', 'maxClientVer'])
      if (value[field] !== undefined && !version(value[field]))
        add(prefix + '.' + field, 'Expected three version bytes as x.y.z.');
    if (
      version(value.minClientVer) &&
      version(value.maxClientVer) &&
      compare(value.minClientVer, value.maxClientVer) > 0
    )
      add(prefix + '.maxClientVer', 'Maximum client version precedes minimum.');
  } else {
    if (!host(value.serverName) || require('node:net').isIP(value.serverName))
      add(prefix + '.serverName', 'REALITY requires an explicit DNS server name.');
    if (!shortId(value.shortId))
      add(prefix + '.shortId', 'Expected a hex short ID, at most 8 bytes.');
    if (value.fingerprint !== undefined && !['chrome', 'chrome120'].includes(value.fingerprint))
      add(prefix + '.fingerprint', 'Supported fingerprint: pinned non-PQ Chrome 120.');
    if (value.clientVersion !== undefined && !version(value.clientVersion))
      add(prefix + '.clientVersion', 'Expected three version bytes as x.y.z.');
  }
}
function compare(left, right) {
  const number = (value) => value.split('.').reduce((n, byte) => n * 256 + Number(byte), 0);
  return number(left) - number(right);
}
function normalize(value, inbound) {
  return inbound
    ? {
        ...value,
        serverNames: Array.isArray(value.serverNames) ? value.serverNames.map(dnsName) : [],
        shortIds: (Array.isArray(value.shortIds) ? value.shortIds : []).map((id) =>
          typeof id === 'string' ? id.toLowerCase() : id,
        ),
        maxTimeDiff: value.maxTimeDiff ?? 0,
      }
    : {
        ...value,
        serverName: dnsName(value.serverName),
        fingerprint: value.fingerprint ?? 'chrome120',
        clientVersion: value.clientVersion ?? '4.0.0',
        shortId: typeof value.shortId === 'string' ? value.shortId.toLowerCase() : value.shortId,
      };
}
module.exports = { validate, normalize, compare };
