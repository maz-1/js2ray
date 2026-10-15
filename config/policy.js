'use strict';
const path = require('node:path');
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
      add(error.path ? field + '.' + error.path : field, error.message);
    }
  };
  const geodata = {};
  if (
    input.geodata !== undefined &&
    keys(input.geodata, ['geoip', 'geosite', 'external'], 'geodata')
  ) {
    for (const [kind, resource] of Object.entries(input.geodata).filter(
      ([kind]) => kind !== 'external',
    )) {
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
  if (input.geodata?.external !== undefined) {
    if (
      keys(input.geodata.external, Object.keys(input.geodata.external ?? {}), 'geodata.external')
    ) {
      geodata.external = Object.create(null);
      for (const [name, resource] of Object.entries(input.geodata.external)) {
        const prefix = 'geodata.external.' + name;
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name))
          add(prefix, 'Expected an asset filename without directories.');
        if (!keys(resource, ['kind', 'path', 'version', 'sha256', 'maxBytes'], prefix)) continue;
        if (!['geoip', 'geosite'].includes(resource.kind))
          add(prefix + '.kind', 'Expected geoip or geosite.');
        if (typeof resource.path !== 'string') {
          add(prefix + '.path', 'Expected a resource path.');
          continue;
        }
        if (
          resource.maxBytes !== undefined &&
          (!Number.isSafeInteger(resource.maxBytes) ||
            resource.maxBytes < 1 ||
            resource.maxBytes > 256 * 1024 * 1024)
        )
          add(prefix + '.maxBytes', 'Invalid resource size limit.');
        geodata.external[name] = { ...resource, path: path.resolve(baseDir, resource.path) };
      }
    }
  }
  const assets = attempt('geodata', () => new GeoData(geodata));
  const dns = require('./dns').dnsConfig(input.dns, {
    add,
    assets,
    baseDir,
    host,
    port,
    inbounds,
    outbounds,
  });
  let routing = input.routing;
  if (routing !== undefined && typeof routing !== 'function') {
    if (keys(routing, ['domainStrategy', 'domainMatcher', 'rules'], 'routing'))
      attempt('routing', () => new Router(routing, assets, input.compatibility ?? 'native'));
    const outboundTags = new Set(outbounds.map((bound) => bound.tag));
    const inboundTags = new Set(inbounds.map((bound) => bound.tag));
    for (const [i, rule] of (Array.isArray(routing?.rules) ? routing.rules : []).entries()) {
      if (!outboundTags.has(rule?.outboundTag))
        add(`routing.rules[${i}].outboundTag`, 'Referenced outbound tag does not exist.');
      for (const tag of Array.isArray(rule?.inboundTag) ? rule.inboundTag : [])
        if (
          !inboundTags.has(tag) &&
          tag !== dns?.tag &&
          !(dns?.servers ?? []).some((s) => s?.tag === tag)
        )
          add(`routing.rules[${i}].inboundTag`, 'Referenced inbound tag does not exist.');
    }
  }
  return { dns, routing, geodata, assets };
}
module.exports = { policy };
