'use strict';
const path = require('node:path');
const net = require('node:net');
const { GeoData, domainMatcher, ipMatcher } = require('../geodata');
const { Router } = require('../routing');

function policy(input, { baseDir, add, host, port, inbounds, outbounds }) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed, prefix) => {
    if (!object(value)) {
      add(prefix, 'Expected an object.');
      return false;
    }
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) add(`${prefix}.${key}`, 'Unsupported behavior field.');
    return true;
  };
  const attempt = (field, fn) => {
    try {
      return fn();
    } catch (error) {
      add(field, error.message);
    }
  };
  const geodata = {};
  if (input.geodata !== undefined && keys(input.geodata, ['geoip', 'geosite'], 'geodata')) {
    for (const [kind, resource] of Object.entries(input.geodata)) {
      if (!keys(resource, ['path', 'version', 'sha256', 'maxBytes'], `geodata.${kind}`)) continue;
      if (typeof resource.path !== 'string') {
        add(`geodata.${kind}.path`, 'Expected a resource path.');
        continue;
      }
      if (
        resource.maxBytes !== undefined &&
        (!Number.isSafeInteger(resource.maxBytes) ||
          resource.maxBytes < 1 ||
          resource.maxBytes > 256 * 1024 * 1024)
      )
        add(`geodata.${kind}.maxBytes`, 'Expected a byte limit up to 256 MiB.');
      geodata[kind] = { ...resource, path: path.resolve(baseDir, resource.path) };
    }
  }
  const assets = attempt('geodata', () => new GeoData(geodata));
  let routing = input.routing;
  if (routing !== undefined && typeof routing !== 'function') {
    if (keys(routing, ['domainStrategy', 'rules'], 'routing'))
      attempt('routing', () => new Router(routing, assets));
    const outboundTags = new Set(outbounds.map((bound) => bound.tag));
    const inboundTags = new Set(inbounds.map((bound) => bound.tag));
    for (const [i, rule] of (Array.isArray(routing?.rules) ? routing.rules : []).entries()) {
      if (!outboundTags.has(rule?.outboundTag))
        add(`routing.rules[${i}].outboundTag`, 'Referenced outbound tag does not exist.');
      for (const tag of Array.isArray(rule?.inboundTag) ? rule.inboundTag : [])
        if (!inboundTags.has(tag) && tag !== input.dns?.tag)
          add(`routing.rules[${i}].inboundTag`, 'Referenced inbound tag does not exist.');
    }
  }
  let dns;
  if (
    input.dns !== undefined &&
    keys(
      input.dns,
      [
        'hosts',
        'servers',
        'queryStrategy',
        'disableCache',
        'disableFallback',
        'tag',
        'timeoutMs',
        'cacheSize',
        'maxConcurrent',
      ],
      'dns',
    )
  ) {
    dns = { ...input.dns };
    if (!['UseIP', 'UseIPv4', 'UseIPv6'].includes(dns.queryStrategy ?? 'UseIP'))
      add('dns.queryStrategy', 'Unsupported DNS query strategy.');
    for (const field of ['disableCache', 'disableFallback'])
      if (dns[field] !== undefined && typeof dns[field] !== 'boolean')
        add(`dns.${field}`, 'Expected a boolean.');
    for (const field of ['timeoutMs', 'cacheSize', 'maxConcurrent'])
      if (dns[field] !== undefined && (!Number.isSafeInteger(dns[field]) || dns[field] < 1))
        add(`dns.${field}`, 'Expected a positive safe integer.');
    if (
      dns.tag !== undefined &&
      (typeof dns.tag !== 'string' || !dns.tag || inbounds.some((bound) => bound.tag === dns.tag))
    )
      add('dns.tag', 'Expected a distinct nonempty DNS inbound tag.');
    if (dns.hosts !== undefined && keys(dns.hosts, Object.keys(dns.hosts ?? {}), 'dns.hosts')) {
      for (const [pattern, values] of Object.entries(dns.hosts)) {
        attempt(`dns.hosts.${pattern}`, () => domainMatcher(pattern, assets, 'full'));
        if (
          !(Array.isArray(values) ? values : [values]).length ||
          !(Array.isArray(values) ? values : [values]).every(host)
        )
          add(`dns.hosts.${pattern}`, 'Expected IP addresses or domain aliases.');
      }
    }
    if (dns.servers !== undefined && (!Array.isArray(dns.servers) || !dns.servers.length))
      add('dns.servers', 'Expected a nonempty DNS server array.');
    dns.servers = (Array.isArray(dns.servers) ? dns.servers : ['localhost']).map((value, i) => {
      const prefix = `dns.servers[${i}]`,
        server = typeof value === 'string' ? { address: value } : { ...value };
      if (
        !keys(
          server,
          ['address', 'port', 'domains', 'expectIPs', 'skipFallback', 'outboundTag', 'tls'],
          prefix,
        )
      )
        return server;
      if (typeof server.address !== 'string')
        add(prefix + '.address', 'Expected a DNS server address.');
      else if (server.address.startsWith('https'))
        attempt(prefix + '.address', () => {
          const url = new URL(server.address.replace(/^https\+local:/, 'https:'));
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            !host(url.hostname.replace(/^\[|\]$/g, ''))
          )
            throw Error('Invalid DoH URL.');
          if (server.port !== undefined) throw Error('Specify the DoH port in its URL.');
        });
      else if (server.address !== 'localhost' && !net.isIP(server.address))
        add(
          prefix + '.address',
          'Plain DNS servers require an IP address; localhost selects the system resolver.',
        );
      if (server.port !== undefined && !port(server.port))
        add(prefix + '.port', 'Invalid DNS server port.');
      for (const field of ['domains', 'expectIPs'])
        if (server[field] !== undefined) {
          if (!Array.isArray(server[field])) add(prefix + '.' + field, 'Expected an array.');
          else
            for (const pattern of server[field])
              attempt(prefix + '.' + field, () =>
                (field === 'domains' ? domainMatcher : ipMatcher)(pattern, assets),
              );
        }
      if (server.skipFallback !== undefined && typeof server.skipFallback !== 'boolean')
        add(prefix + '.skipFallback', 'Expected a boolean.');
      if (
        server.outboundTag !== undefined &&
        !outbounds.some((bound) => bound.tag === server.outboundTag)
      )
        add(prefix + '.outboundTag', 'Referenced outbound tag does not exist.');
      if (
        server.tls !== undefined &&
        keys(server.tls, ['ca', 'caFile', 'serverName'], prefix + '.tls')
      ) {
        server.tls = { ...server.tls };
        if (server.tls.caFile !== undefined) {
          if (typeof server.tls.caFile !== 'string')
            add(prefix + '.tls.caFile', 'Expected a CA path.');
          else server.tls.caFile = path.resolve(baseDir, server.tls.caFile);
        }
        if (server.tls.ca !== undefined && typeof server.tls.ca !== 'string')
          add(prefix + '.tls.ca', 'Expected PEM CA text.');
        if (server.tls.serverName !== undefined && !host(server.tls.serverName))
          add(prefix + '.tls.serverName', 'Invalid TLS certificate name.');
      }
      return server;
    });
  }
  return { dns, routing, geodata, assets };
}
module.exports = { policy };
