'use strict';
const net = require('node:net');
const { domainMatcher, ipMatcher } = require('../geodata');
const { DomainSet } = require('../geodata/domains');
const { expression } = require('../geodata/regex');

function ports(value) {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError('Expected a port number or range string.');
  const ranges = String(value)
    .split(',')
    .map((item) => {
      if (!/^\d+(?:-\d+)?$/.test(item)) throw new TypeError('Invalid port range.');
      const [start, end = start] = item.split('-').map(Number);
      if (start < 0 || end > 65535 || start > end) throw new TypeError('Invalid port range.');
      return [start, end];
    });
  return (port) => ranges.some(([start, end]) => port >= start && port <= end);
}
class Router {
  constructor(config = {}, data, profile = 'native') {
    this.strategy = config.domainStrategy ?? 'AsIs';
    if (!['AsIs', 'IPIfNonMatch', 'IPOnDemand'].includes(this.strategy))
      throw new TypeError('Unknown routing domain strategy.');
    if (!Array.isArray(config.rules ?? [])) throw new TypeError('Expected routing rules array.');
    const algorithms = ['linear', 'mph', 'hybrid'];
    if (!algorithms.includes(config.domainMatcher ?? 'hybrid'))
      throw new TypeError('Expected linear, mph or hybrid domain matcher.');
    this.rules = (config.rules ?? []).map((rule, index) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule))
        throw new TypeError('Expected a routing rule.');
      if (rule.type !== undefined && rule.type !== 'field')
        throw new TypeError('Only field rules are supported.');
      for (const field of Object.keys(rule))
        if (
          ![
            'type',
            'inboundTag',
            'domain',
            'domains',
            'ip',
            'port',
            'network',
            'outboundTag',
            'source',
            'sourceIP',
            'sourcePort',
            'user',
            'protocol',
            'attrs',
            'ruleTag',
            'domainMatcher',
          ].includes(field)
        )
          throw Object.assign(new TypeError('Unsupported routing field.'), {
            path: `rules[${index}].${field}`,
          });
      if (!algorithms.includes(rule.domainMatcher ?? config.domainMatcher ?? 'hybrid'))
        throw new TypeError('Expected linear, mph or hybrid domain matcher.');
      if (
        rule.ruleTag !== undefined &&
        (typeof rule.ruleTag !== 'string' || rule.ruleTag.length > 256)
      )
        throw new TypeError('Expected a rule tag up to 256 characters.');
      const list = (field) => {
        if (
          !Array.isArray(rule[field]) ||
          !rule[field].length ||
          rule[field].some((value) => typeof value !== 'string' || !value)
        )
          throw new TypeError('Expected a nonempty string array.');
        return rule[field];
      };
      const conditions = [];
      if (rule.inboundTag !== undefined) {
        const tags = list('inboundTag');
        conditions.push((target) => tags.includes(target.inboundTag));
      }
      if (rule.domain !== undefined || rule.domains !== undefined) {
        const values = [
          ...(rule.domain === undefined ? [] : list('domain')),
          ...(rule.domains === undefined ? [] : list('domains')),
        ];
        const domains = new DomainSet(
          values.map((pattern) => domainMatcher(pattern, data)),
          (rule.domainMatcher ?? config.domainMatcher ?? 'hybrid') !== 'linear',
        );
        conditions.push(
          (target) =>
            !net.isIP(target.routeHost ?? target.host) &&
            domains.test(target.routeHost ?? target.host),
        );
      }
      if (rule.source !== undefined || rule.sourceIP !== undefined) {
        const values = [
          ...(rule.source === undefined ? [] : list('source')),
          ...(rule.sourceIP === undefined ? [] : list('sourceIP')),
        ];
        const matches = values.map((pattern) => ipMatcher(pattern, data));
        conditions.push((target) =>
          Boolean(net.isIP(target.sourceIP ?? '') && matches.some((fn) => fn(target.sourceIP))),
        );
      }
      if (rule.sourcePort !== undefined) {
        const match = ports(rule.sourcePort);
        conditions.push(
          (target) => Number.isInteger(target.sourcePort) && match(target.sourcePort),
        );
      }
      if (rule.user !== undefined) {
        const matches = list('user').map((value) =>
          value.startsWith('regexp:') && profile !== 'v2ray-5.14.1'
            ? expression(value.slice(7))
            : (text) => text === value,
        );
        conditions.push(
          (target) =>
            typeof target.userEmail === 'string' && matches.some((fn) => fn(target.userEmail)),
        );
      }
      if (rule.protocol !== undefined) {
        const protocols = list('protocol');
        if (protocols.some((p) => !['http', 'tls', 'bittorrent'].includes(p)))
          throw new TypeError('Supported sniffed protocols: http, tls and bittorrent.');
        conditions.push(
          (target) =>
            typeof target.protocol === 'string' &&
            protocols.some((p) => target.protocol.startsWith(p)),
        );
      }
      if (rule.attrs !== undefined) {
        if (
          profile === 'v2ray-5.14.1' ||
          !rule.attrs ||
          typeof rule.attrs !== 'object' ||
          Array.isArray(rule.attrs)
        )
          throw new TypeError(
            'HTTP attrs use Xray object semantics; V2Ray Starlark is unsupported.',
          );
        const entries = Object.entries(rule.attrs);
        if (!entries.length || entries.length > 128)
          throw new TypeError('Expected 1–128 HTTP attribute conditions.');
        const matches = entries.map(([key, value]) => {
          if (!/^(?::(?:method|path)|[!#$%&'*+.^_`|~\w-]+)$/i.test(key))
            throw new TypeError('Invalid HTTP attribute key.');
          return [key.toLowerCase(), expression(value)];
        });
        conditions.push((target) =>
          Boolean(target.attrs && matches.every(([key, match]) => match(target.attrs[key]))),
        );
      }
      if (rule.ip !== undefined) {
        const ips = list('ip').map((pattern) => ipMatcher(pattern, data));
        conditions.push((target) =>
          [target.routeHost ?? target.host, ...(target.routeIPs ?? [])].some(
            (address) => net.isIP(address) && ips.some((fn) => fn(address)),
          ),
        );
      }
      if (rule.port !== undefined) {
        const match = ports(rule.port);
        conditions.push((target) => match(target.port));
      }
      if (rule.network !== undefined) {
        if (
          !(typeof rule.network === 'string' || Array.isArray(rule.network)) ||
          (Array.isArray(rule.network) ? rule.network : rule.network.split(',')).some(
            (item) => !['tcp', 'udp'].includes(item),
          )
        )
          throw new TypeError('Unknown routing network.');
        const networks = Array.isArray(rule.network) ? rule.network : rule.network.split(',');
        if (!networks.length) throw new TypeError('Expected routing networks.');
        conditions.push((target) => networks.includes(target.network ?? 'tcp'));
      }
      if (!conditions.length || typeof rule.outboundTag !== 'string' || !rule.outboundTag)
        throw new TypeError('A routing rule needs conditions and an outbound tag.');
      return {
        tag: rule.outboundTag,
        ruleTag: rule.ruleTag,
        needsIP: Boolean(rule.ip),
        matches: (target) => conditions.every((fn) => fn(target)),
      };
    });
  }
  select(target) {
    return this.rules.find((rule) => rule.matches(target))?.tag;
  }
  async selectAsync(target, resolve) {
    if (this.strategy === 'AsIs' || net.isIP(target.routeHost ?? target.host))
      return this.select(target);
    if (this.strategy === 'IPIfNonMatch') {
      const first = this.select(target);
      if (first !== undefined) return first;
    }
    let resolved = false;
    for (const rule of this.rules) {
      if (rule.needsIP && !resolved) {
        // Never mutate host: a proxy peer must still receive the domain name.
        const records = await resolve(target.routeHost ?? target.host);
        target = { ...target, routeIPs: records.map((record) => record.address) };
        resolved = true;
      }
      if (rule.matches(target)) return rule.tag;
    }
  }
}
module.exports = { Router, ports };
