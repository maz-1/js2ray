'use strict';
const net = require('node:net');
const { domainMatcher, ipMatcher } = require('../geodata');

function ports(value) {
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
  constructor(config = {}, data) {
    if ((config.domainStrategy ?? 'AsIs') !== 'AsIs')
      throw new TypeError('Only routing AsIs is supported.');
    this.rules = (config.rules ?? []).map((rule) => {
      if (rule.type !== undefined && rule.type !== 'field')
        throw new TypeError('Only field rules are supported.');
      for (const field of Object.keys(rule))
        if (
          !['type', 'inboundTag', 'domain', 'ip', 'port', 'network', 'outboundTag'].includes(field)
        )
          throw new TypeError('Unsupported routing field.');
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
      if (rule.inboundTag) {
        const tags = list('inboundTag');
        conditions.push((target) => tags.includes(target.inboundTag));
      }
      if (rule.domain) {
        const domains = list('domain').map((pattern) => domainMatcher(pattern, data));
        conditions.push(
          (target) =>
            !net.isIP(target.routeHost ?? target.host) &&
            domains.some((fn) => fn(target.routeHost ?? target.host)),
        );
      }
      if (rule.ip) {
        const ips = list('ip').map((pattern) => ipMatcher(pattern, data));
        conditions.push(
          (target) =>
            Boolean(net.isIP(target.routeHost ?? target.host)) &&
            ips.some((fn) => fn(target.routeHost ?? target.host)),
        );
      }
      if (rule.port !== undefined) {
        const match = ports(rule.port);
        conditions.push((target) => match(target.port));
      }
      if (rule.network !== undefined) {
        if (
          typeof rule.network !== 'string' ||
          rule.network.split(',').some((item) => !['tcp', 'udp'].includes(item))
        )
          throw new TypeError('Unknown routing network.');
        conditions.push((target) => rule.network.split(',').includes(target.network ?? 'tcp'));
      }
      if (!conditions.length || typeof rule.outboundTag !== 'string' || !rule.outboundTag)
        throw new TypeError('A routing rule needs conditions and an outbound tag.');
      return { tag: rule.outboundTag, matches: (target) => conditions.every((fn) => fn(target)) };
    });
  }
  select(target) {
    return this.rules.find((rule) => rule.matches(target))?.tag;
  }
}
module.exports = { Router, ports };
