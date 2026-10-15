'use strict';
const net = require('node:net');
const path = require('node:path');
const { domainMatcher, ipMatcher } = require('../geodata');

function endpoint(server) {
  const address = server.address;
  if (address === 'localhost') return { type: 'system', local: true };
  if (net.isIP(address)) return { type: 'udp', host: address, port: server.port ?? 53 };
  if (/^https(?:\+local)?:/.test(address)) {
    const local = address.startsWith('https+local:');
    const url = new URL(address.replace(/^https\+local:/, 'https:'));
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      server.port !== undefined
    )
      throw new TypeError('Invalid DoH URL; specify its port in the URL.');
    return {
      type: 'https',
      local,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 443),
      url,
    };
  }
  if (/^tcp(?:\+local)?:\/\//.test(address)) {
    const local = address.startsWith('tcp+local:');
    const url = new URL(address.replace(/^tcp\+local:/, 'tcp:'));
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.pathname && url.pathname !== '/') ||
      server.port !== undefined
    )
      throw new TypeError('Invalid TCP DNS URL; specify its port in the URL.');
    return {
      type: 'tcp',
      local,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 53),
    };
  }
  if (/^\[.*\]:\d+$/.test(address) || /^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) {
    const url = new URL('udp://' + address);
    if (server.port !== undefined) throw new TypeError('DNS port specified twice.');
    return {
      type: 'udp',
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 53),
    };
  }
  throw new TypeError(
    'Supported DNS servers: IP, localhost, tcp://, tcp+local://, https:// and https+local://. HTTP/3 and DoQ are deferred.',
  );
}
function dnsConfig(input, { add, assets, baseDir, host, port, inbounds, outbounds }) {
  if (input === undefined) return;
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const normalize = (value, fields, prefix) => {
    if (!object(value)) {
      add(prefix, 'Expected an object.');
      return {};
    }
    const names = new Map(fields.map((field) => [field.toLowerCase(), field]));
    if (fields.includes('expectIPs')) names.set('expectedips', 'expectIPs');
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const name = names.get(key.toLowerCase());
      if (!name) add(prefix + '.' + key, 'Unsupported DNS behavior field.');
      else if (Object.hasOwn(result, name))
        add(prefix + '.' + key, 'Conflicting DNS field aliases.');
      else result[name] = entry;
    }
    return result;
  };
  const common = [
    'queryStrategy',
    'disableCache',
    'cacheStrategy',
    'fallbackStrategy',
    'clientIp',
    'timeoutMs',
    'tag',
  ];
  const dns = normalize(
    input,
    [
      ...common,
      'hosts',
      'servers',
      'disableFallback',
      'disableFallbackIfMatch',
      'cacheSize',
      'maxConcurrent',
      'domainMatcher',
    ],
    'dns',
  );
  const validate = (value, prefix, global) => {
    if (value.queryStrategy !== undefined) {
      const aliases = new Map([
        ['useip', 'UseIP'],
        ['useipv4', 'UseIPv4'],
        ['useip4', 'UseIPv4'],
        ['useipv6', 'UseIPv6'],
        ['useip6', 'UseIPv6'],
      ]);
      const normalized =
        typeof value.queryStrategy === 'string' &&
        aliases.get(value.queryStrategy.toLowerCase().replace(/[_-]/g, ''));
      if (!normalized) add(prefix + '.queryStrategy', 'Expected UseIP, UseIPv4 or UseIPv6.');
      else value.queryStrategy = normalized;
    }
    for (const field of [
      'disableCache',
      'disableFallback',
      'disableFallbackIfMatch',
      'skipFallback',
    ])
      if (value[field] !== undefined && typeof value[field] !== 'boolean')
        add(prefix + '.' + field, 'Expected a boolean.');
    for (const field of ['timeoutMs', 'cacheSize', 'maxConcurrent'])
      if (
        value[field] !== undefined &&
        (!Number.isSafeInteger(value[field]) ||
          value[field] < 1 ||
          value[field] > (field === 'timeoutMs' ? 2147483647 : 1000000))
      )
        add(prefix + '.' + field, 'Expected a bounded positive safe integer.');
    if (value.cacheStrategy !== undefined && !['enabled', 'disabled'].includes(value.cacheStrategy))
      add(prefix + '.cacheStrategy', 'Expected enabled or disabled.');
    if (
      value.fallbackStrategy !== undefined &&
      !['enabled', 'disabled', 'disabledIfAnyMatch'].includes(value.fallbackStrategy)
    )
      add(prefix + '.fallbackStrategy', 'Expected enabled, disabled or disabledIfAnyMatch.');
    if (value.clientIp !== undefined && !net.isIP(value.clientIp))
      add(prefix + '.clientIp', 'Expected an IPv4 or IPv6 ECS address.');
    if (
      value.tag !== undefined &&
      (typeof value.tag !== 'string' ||
        !value.tag ||
        value.tag.length > 256 ||
        inbounds.some((b) => b.tag === value.tag))
    )
      add(prefix + '.tag', 'Expected a distinct nonempty DNS inbound tag.');
    if (
      value.cacheStrategy !== undefined &&
      value.disableCache !== undefined &&
      (value.cacheStrategy === 'disabled') !== value.disableCache
    )
      add(prefix + '.cacheStrategy', 'Conflicts with disableCache.');
    if (
      global &&
      value.domainMatcher !== undefined &&
      !['linear', 'mph', 'hybrid'].includes(value.domainMatcher)
    )
      add(prefix + '.domainMatcher', 'Expected linear, mph or hybrid.');
  };
  const attempt = (prefix, fn) => {
    try {
      return fn();
    } catch (e) {
      add(prefix, e.message);
    }
  };
  validate(dns, 'dns', true);
  if (dns.hosts !== undefined) {
    if (!object(dns.hosts)) add('dns.hosts', 'Expected a hosts object.');
    else
      for (const [pattern, values] of Object.entries(dns.hosts)) {
        attempt('dns.hosts.' + pattern, () => domainMatcher(pattern, assets, 'full'));
        if (
          !(Array.isArray(values) ? values : [values]).length ||
          !(Array.isArray(values) ? values : [values]).every(host)
        )
          add('dns.hosts.' + pattern, 'Expected IP addresses or domain aliases.');
      }
  }
  if (dns.servers !== undefined && (!Array.isArray(dns.servers) || !dns.servers.length))
    add('dns.servers', 'Expected a nonempty DNS server array.');
  dns.servers = (Array.isArray(dns.servers) ? dns.servers : ['localhost']).map((entry, index) => {
    const prefix = `dns.servers[${index}]`;
    const server = normalize(
      typeof entry === 'string' ? { address: entry } : entry,
      [...common, 'address', 'port', 'domains', 'expectIPs', 'skipFallback', 'outboundTag', 'tls'],
      prefix,
    );
    validate(server, prefix);
    if (typeof server.address !== 'string')
      add(prefix + '.address', 'Expected a DNS server address.');
    else
      attempt(prefix + '.address', () => {
        const parsed = endpoint(server);
        if (parsed.host && (!host(parsed.host) || !port(parsed.port)))
          throw new TypeError('Invalid DNS host or port.');
      });
    if (server.port !== undefined && !port(server.port)) add(prefix + '.port', 'Invalid DNS port.');
    for (const field of ['domains', 'expectIPs'])
      if (server[field] !== undefined) {
        if (!Array.isArray(server[field]) || !server[field].length)
          add(prefix + '.' + field, 'Expected a nonempty array.');
        else
          for (const pattern of server[field])
            attempt(prefix + '.' + field, () =>
              (field === 'domains' ? domainMatcher : ipMatcher)(pattern, assets),
            );
      }
    if (server.outboundTag !== undefined && !outbounds.some((b) => b.tag === server.outboundTag))
      add(prefix + '.outboundTag', 'Referenced outbound tag does not exist.');
    if (server.tls !== undefined) {
      server.tls = normalize(server.tls, ['ca', 'caFile', 'serverName'], prefix + '.tls');
      if (server.tls.caFile !== undefined) {
        if (typeof server.tls.caFile !== 'string')
          add(prefix + '.tls.caFile', 'Expected a CA path.');
        else server.tls.caFile = path.resolve(baseDir, server.tls.caFile);
      }
      if (server.tls.ca !== undefined && typeof server.tls.ca !== 'string')
        add(prefix + '.tls.ca', 'Expected PEM CA text.');
      if (server.tls.serverName !== undefined && !host(server.tls.serverName))
        add(prefix + '.tls.serverName', 'Invalid TLS name.');
      if (
        typeof server.address === 'string' &&
        attempt(prefix + '.tls', () => endpoint(server))?.type !== 'https'
      )
        add(prefix + '.tls', 'TLS settings require DoH.');
    }
    return server;
  });
  return dns;
}
module.exports = { dnsConfig, endpoint };
