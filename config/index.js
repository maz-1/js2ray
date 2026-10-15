'use strict';

const path = require('node:path');
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');
const { Js2rayError } = require('../runtime/errors');
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const supported = {
  inbound: ['vmess', 'socks', 'vless', 'tcp'],
  outbound: ['vmess', 'socks', 'vless', 'freedom', 'blackhole', 'service'],
};

function diagnostic(field, reason) {
  return {
    code: 'ERR_CONFIG',
    path: field,
    reason,
    suggestion: 'Use a supported field or remove this option.',
  };
}
function host(value) {
  if (typeof value !== 'string' || !value || value.includes('%')) return false;
  if (isIP(value)) return true;
  if (/^[\d.]+$/.test(value)) return false;
  const ascii = domainToASCII(value).replace(/\.$/, '');
  return (
    ascii &&
    ascii.length <= 253 &&
    ascii.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  );
}
function port(value, allowZero = false) {
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
}
function checkConfig(input = {}, { baseDir = process.cwd() } = {}) {
  const diagnostics = [];
  const add = (field, reason) => diagnostics.push(diagnostic(field, reason));
  const keys = (object, allowed, prefix) => {
    for (const key of Object.keys(object))
      if (!allowed.includes(key))
        add(prefix ? `${prefix}.${key}` : key, 'Unsupported behavior field.');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, diagnostics: [diagnostic('$', 'Configuration must be an object.')] };
  const adapted = require('./v2ray').adaptV2ray(input, add);
  input = adapted.input;
  keys(
    input,
    ['inbounds', 'outbounds', 'routing', 'dns', 'geodata', 'reverse', 'storage', 'debug', 'limits'],
    '',
  );
  if (input.debug !== undefined && typeof input.debug !== 'function')
    add('debug', 'Expected a logger function.');
  if (input.storage !== undefined && typeof input.storage !== 'string')
    add('storage', 'Expected a filesystem path.');
  const tags = new Set();
  const bounds = (kind) => {
    const field = `${kind}s`;
    const source =
      input[field] === undefined
        ? kind === 'outbound'
          ? [{ protocol: 'freedom', tag: 'direct' }]
          : []
        : input[field];
    if (!Array.isArray(source) || (kind === 'outbound' && source.length === 0)) {
      add(field, 'Expected an array; outbounds must contain at least one entry.');
      return [];
    }
    return source.map((item, i) => {
      const prefix = `${field}[${i}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        add(prefix, 'Expected an object.');
        return {};
      }
      keys(
        item,
        [
          'tag',
          'protocol',
          'networks',
          'users',
          'redirect',
          'domainStrategy',
          'target',
          'sniffing',
          'mux',
          'service',
          'allow',
          'udp',
          'packetEncoding',
        ],
        prefix,
      );
      const protocol = item.protocol ?? (kind === 'outbound' ? 'freedom' : undefined);
      if (item.mux !== undefined) {
        const mux = item.mux;
        if (kind !== 'outbound' || !mux || typeof mux !== 'object' || Array.isArray(mux))
          add(prefix + '.mux', 'Expected outbound Mux settings.');
        else {
          keys(mux, ['enabled', 'concurrency'], prefix + '.mux');
          if (typeof mux.enabled !== 'boolean')
            add(prefix + '.mux.enabled', 'Expected an explicit boolean.');
          if (
            mux.enabled &&
            (protocol !== 'vless' ||
              !Number.isInteger(mux.concurrency ?? 8) ||
              (mux.concurrency ?? 8) < 1 ||
              (mux.concurrency ?? 8) > 128)
          )
            add(prefix + '.mux', 'Mux supports VLESS TCP with concurrency 1–128.');
        }
      }
      if (!supported[kind].includes(protocol))
        add(`${prefix}.protocol`, 'Protocol is not supported by this runtime.');
      if (
        item.udp !== undefined &&
        (protocol !== 'socks' || kind !== 'inbound' || typeof item.udp !== 'boolean')
      )
        add(prefix + '.udp', 'UDP enablement requires a SOCKS inbound boolean.');
      if (
        item.packetEncoding !== undefined &&
        (protocol !== 'vless' ||
          kind !== 'outbound' ||
          !['none', 'xudp'].includes(item.packetEncoding))
      )
        add(prefix + '.packetEncoding', 'Expected VLESS outbound packetEncoding none or xudp.');
      const tag = item.tag ?? `${kind}-${i}`;
      if (typeof tag !== 'string' || !tag || tags.has(tag))
        add(`${prefix}.tag`, 'Expected a unique nonempty tag across all bounds.');
      tags.add(tag);
      const networks = item.networks ?? [];
      if (
        !['freedom', 'blackhole', 'service'].includes(protocol) &&
        (!Array.isArray(networks) || !networks.length)
      )
        add(`${prefix}.networks`, 'At least one network is required.');
      if (
        ['freedom', 'blackhole', 'service'].includes(protocol) &&
        (item.networks !== undefined || item.users !== undefined)
      )
        add(prefix, 'This outbound does not accept networks or users.');
      if (protocol === 'service') {
        if (
          typeof item.service !== 'string' ||
          !item.service ||
          !item.allow ||
          !host(item.allow.host) ||
          !port(item.allow.port)
        )
          add(prefix, 'Service outbound requires a registered name and exact allowed host/port.');
        else keys(item.allow, ['host', 'port'], prefix + '.allow');
      } else if (item.service !== undefined || item.allow !== undefined)
        add(prefix, 'Service fields require protocol service.');
      let redirect;
      if (item.redirect !== undefined) {
        if (protocol !== 'freedom' || typeof item.redirect !== 'string')
          add(prefix + '.redirect', 'Freedom redirect requires host:port.');
        else {
          const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(item.redirect);
          if (!match || !host(match[1] || match[2]) || !port(Number(match[3])))
            add(prefix + '.redirect', 'Invalid redirect target.');
          else redirect = item.redirect;
        }
      }
      if (
        item.domainStrategy !== undefined &&
        (protocol !== 'freedom' ||
          !['AsIs', 'UseIP', 'UseIPv4', 'UseIPv6'].includes(item.domainStrategy))
      )
        add(prefix + '.domainStrategy', 'Unsupported Freedom domain strategy.');
      if (protocol === 'tcp') {
        if (!item.target || !host(item.target.host) || !port(item.target.port))
          add(prefix + '.target', 'TCP inbound requires a fixed host and port.');
        else keys(item.target, ['host', 'port'], prefix + '.target');
      } else if (item.target !== undefined)
        add(prefix + '.target', 'Only TCP inbounds accept target.');
      if (item.sniffing !== undefined) {
        const sniff = item.sniffing;
        if (
          kind !== 'inbound' ||
          protocol === 'vmess' ||
          !sniff ||
          typeof sniff !== 'object' ||
          Array.isArray(sniff)
        )
          add(prefix + '.sniffing', 'Sniffing requires a SOCKS, VLESS or TCP inbound.');
        else {
          keys(
            sniff,
            ['enabled', 'destOverride', 'routeOnly', 'timeoutMs', 'maxBytes'],
            prefix + '.sniffing',
          );
          for (const field of ['enabled', 'routeOnly'])
            if (sniff[field] !== undefined && typeof sniff[field] !== 'boolean')
              add(prefix + '.sniffing.' + field, 'Expected a boolean.');
          if (
            sniff.destOverride !== undefined &&
            (!Array.isArray(sniff.destOverride) ||
              sniff.destOverride.some((value) => !['http', 'tls'].includes(value)))
          )
            add(prefix + '.sniffing.destOverride', 'Only HTTP and TLS sniffing are supported.');
          for (const field of ['timeoutMs', 'maxBytes'])
            if (
              sniff[field] !== undefined &&
              (!Number.isSafeInteger(sniff[field]) ||
                sniff[field] < 1 ||
                (field === 'maxBytes' && sniff[field] > 65536))
            )
              add(prefix + '.sniffing.' + field, 'Invalid sniffing limit.');
        }
      }
      const normalizedNetworks = (Array.isArray(networks) ? networks : []).map((network, j) => {
        const np = `${prefix}.networks[${j}]`;
        if (!network || typeof network !== 'object' || Array.isArray(network)) {
          add(np, 'Expected a network object.');
          return {};
        }
        keys(network, ['type', 'address', 'port', 'option'], np);
        const type = network.type ?? 'tcp';
        if (!['tcp', 'ws', 'xhttp'].includes(type))
          add(
            `${np}.type`,
            'Only TCP, WebSocket and XHTTP are supported; TLS is configured independently.',
          );
        const address = network.address ?? (kind === 'inbound' ? '127.0.0.1' : undefined);
        if (!host(address)) add(`${np}.address`, 'Expected a valid IP address or domain.');
        if (!port(network.port, kind === 'inbound'))
          add(`${np}.port`, 'Expected an integer port in range.');
        let option = network.option ?? {};
        if (!option || typeof option !== 'object' || Array.isArray(option)) {
          add(np + '.option', 'Expected transport options.');
          option = {};
        }
        keys(
          option,
          ['path', 'headers', 'tls', ...(type === 'xhttp' ? require('./xhttp').fields : [])],
          np + '.option',
        );
        if (type === 'xhttp')
          require('./xhttp').validate(option, add, np + '.option', kind === 'inbound');
        if (type === 'tcp' && (option.path !== undefined || option.headers !== undefined))
          add(np + '.option', 'WebSocket path and headers require type ws.');
        if (
          option.path !== undefined &&
          (typeof option.path !== 'string' ||
            !option.path.startsWith('/') ||
            /[\r\n#]/.test(option.path))
        )
          add(
            np + '.option.path',
            'Expected an absolute WebSocket request path without fragments.',
          );
        if (
          option.headers !== undefined &&
          (!option.headers || typeof option.headers !== 'object' || Array.isArray(option.headers))
        )
          add(np + '.option.headers', 'Expected an HTTP headers object.');
        for (const [name, value] of Object.entries(option.headers ?? {})) {
          if (
            typeof value !== 'string' ||
            /[\r\n]/.test(name + value) ||
            !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
            (type === 'xhttp'
              ? /^(?:host|referer|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|proxy-connection|http2-settings|accept-encoding)$|^sec-websocket-/i.test(
                  name,
                )
              : /^(connection|upgrade|sec-websocket-)/i.test(name))
          )
            add(np + '.option.headers', 'Invalid or reserved WebSocket header.');
        }
        const tls = option.tls;
        let normalizedTls;
        if (tls !== undefined) {
          if (!tls || typeof tls !== 'object' || Array.isArray(tls))
            add(np + '.option.tls', 'Expected TLS options.');
          else {
            keys(
              tls,
              [
                'serverName',
                'rejectUnauthorized',
                'ca',
                'cert',
                'key',
                'caFile',
                'certFile',
                'keyFile',
              ],
              np + '.option.tls',
            );
            if (tls.serverName !== undefined && !host(tls.serverName))
              add(np + '.option.tls.serverName', 'Invalid certificate name.');
            if (tls.rejectUnauthorized !== undefined && typeof tls.rejectUnauthorized !== 'boolean')
              add(np + '.option.tls.rejectUnauthorized', 'Expected a boolean.');
            normalizedTls = { ...tls };
            for (const field of ['ca', 'cert', 'key'])
              if (tls[field] !== undefined && typeof tls[field] !== 'string')
                add(np + '.option.tls.' + field, 'Expected PEM text.');
            for (const field of ['caFile', 'certFile', 'keyFile'])
              if (tls[field] !== undefined) {
                if (typeof tls[field] !== 'string')
                  add(np + '.option.tls.' + field, 'Expected a filesystem path.');
                else normalizedTls[field] = path.resolve(baseDir, tls[field]);
              }
            if (kind === 'inbound' && (!(tls.cert || tls.certFile) || !(tls.key || tls.keyFile)))
              add(np + '.option.tls', 'Inbound TLS requires a certificate and private key.');
          }
        }
        return {
          type,
          address,
          port: network.port,
          option: {
            ...option,
            headers: option.headers ? { ...option.headers } : undefined,
            tls: normalizedTls,
          },
        };
      });
      if (item.udp && normalizedNetworks.some((network) => network.type !== 'tcp'))
        add(prefix + '.udp', 'SOCKS UDP association requires TCP/TLS control transports.');
      const users = item.users ?? [];
      if (!Array.isArray(users)) add(`${prefix}.users`, 'Expected an array.');
      const normalizedUsers = (Array.isArray(users) ? users : []).map((user, j) => {
        const up = `${prefix}.users[${j}]`;
        if (!user || typeof user !== 'object' || Array.isArray(user)) {
          add(up, 'Expected a user object.');
          return {};
        }
        keys(
          user,
          protocol === 'vless'
            ? ['id', 'encryption', 'flow', 'email']
            : protocol === 'vmess'
              ? [
                  'id',
                  'security',
                  'alterId',
                  'email',
                  'traffic',
                  'ipCount',
                  'ipCountDuration',
                  'expire',
                  'deactive',
                ]
              : ['user', 'pass'],
          up,
        );
        if (protocol === 'vless') {
          if (typeof user.id !== 'string' || !uuid.test(user.id))
            add(up + '.id', 'Expected a canonical UUID.');
          if (kind === 'outbound' && user.encryption !== 'none')
            add(up + '.encryption', 'VLESS requires encryption none.');
          if (user.encryption !== undefined && user.encryption !== 'none')
            add(up + '.encryption', 'VLESS only supports encryption none.');
          if (
            ![
              undefined,
              '',
              'xtls-rprx-vision',
              ...(kind === 'outbound' ? ['xtls-rprx-vision-udp443'] : []),
            ].includes(user.flow)
          )
            add(up + '.flow', 'Unsupported VLESS flow.');
        } else if (protocol === 'vmess') {
          if (typeof user.id !== 'string' || !uuid.test(user.id))
            add(`${up}.id`, 'Expected a canonical UUID.');
          if (
            !['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'].includes(user.security ?? 'auto')
          )
            add(`${up}.security`, 'Unsupported VMess security mode.');
          if (
            !Number.isInteger(user.alterId ?? 0) ||
            (user.alterId ?? 0) < 0 ||
            (user.alterId ?? 0) > 64
          )
            add(`${up}.alterId`, 'Expected an alterId between 0 and 64.');
          for (const field of ['traffic', 'ipCount', 'ipCountDuration', 'expire'])
            if (
              user[field] !== undefined &&
              (!Number.isSafeInteger(user[field]) || user[field] < 0)
            )
              add(up + '.' + field, 'Expected a nonnegative integer.');
        } else if (protocol === 'socks') {
          for (const key of ['user', 'pass'])
            if (
              typeof user[key] !== 'string' ||
              Buffer.byteLength(user[key]) < 1 ||
              Buffer.byteLength(user[key]) > 255
            )
              add(`${up}.${key}`, 'Expected a UTF-8 credential of 1–255 bytes.');
        }
        return { ...user };
      });
      if (['vmess', 'vless'].includes(protocol) && !normalizedUsers.length)
        add(`${prefix}.users`, 'This protocol requires explicitly configured users.');
      const vision =
        protocol === 'vless' &&
        normalizedUsers.some((user) => user.flow?.startsWith('xtls-rprx-vision'));
      if (vision) {
        if (normalizedNetworks.some((network) => network.type !== 'tcp' || !network.option.tls))
          add(prefix + '.networks', 'Vision requires raw TCP with TLS (outer TLS 1.3).');
        if (item.mux?.enabled)
          add(prefix + '.mux', 'Vision permits UDP/XUDP only; TCP Mux is unsupported.');
        if (item.packetEncoding === 'none')
          add(prefix + '.packetEncoding', 'Vision UDP requires XUDP.');
        for (const network of normalizedNetworks)
          Object.defineProperty(network, Symbol.for('js2ray.vision'), { value: true });
      }
      return ['freedom', 'blackhole', 'service'].includes(protocol)
        ? {
            tag,
            protocol,
            ...(protocol === 'service' ? { service: item.service, allow: { ...item.allow } } : {}),
            ...(redirect ? { redirect } : {}),
            ...(item.domainStrategy ? { domainStrategy: item.domainStrategy } : {}),
          }
        : {
            tag,
            protocol,
            networks: normalizedNetworks,
            users: normalizedUsers,
            ...(item.udp !== undefined ? { udp: item.udp } : {}),
            ...(vision && kind === 'outbound'
              ? { packetEncoding: 'xudp' }
              : item.packetEncoding
                ? { packetEncoding: item.packetEncoding }
                : {}),
            ...(item.mux ? { mux: { ...item.mux } } : {}),
            ...(item.target ? { target: { ...item.target } } : {}),
            ...(item.sniffing ? { sniffing: { ...item.sniffing } } : {}),
          };
    });
  };
  const inbounds = bounds('inbound');
  const outbounds = bounds('outbound');
  const reverse = require('./reverse').reverseConfig(input.reverse, add, host, [
    ...inbounds,
    ...outbounds,
  ]);
  const policy = require('./policy').policy(input, {
    baseDir,
    add,
    host,
    port,
    inbounds: [...inbounds, ...(reverse?.bridges ?? [])],
    outbounds: [...outbounds, ...(reverse?.portals ?? [])],
  });
  const limits = {
    connectTimeoutMs: 10000,
    handshakeTimeoutMs: 10000,
    idleTimeoutMs: 0,
    maxConnections: 1024,
    maxPendingDials: 128,
    maxBufferBytes: 1024 * 1024,
    ...input.limits,
  };
  if (input.limits && (typeof input.limits !== 'object' || Array.isArray(input.limits)))
    add('limits', 'Expected an object.');
  for (const [key, value] of Object.entries(limits)) {
    if (
      ![
        'connectTimeoutMs',
        'handshakeTimeoutMs',
        'idleTimeoutMs',
        'maxConnections',
        'maxPendingDials',
        'maxBufferBytes',
      ].includes(key)
    )
      add(`limits.${key}`, 'Unknown resource limit.');
    if (!Number.isSafeInteger(value) || value < (key === 'idleTimeoutMs' ? 0 : 1))
      add(`limits.${key}`, 'Expected a positive safe integer (idle timeout also permits zero).');
  }
  const config = {
    inbounds,
    outbounds,
    routing: policy.routing,
    dns: policy.dns,
    geodata: policy.geodata,
    reverse,
    storage:
      typeof input.storage === 'string' && input.storage
        ? path.resolve(baseDir, input.storage)
        : undefined,
    debug: input.debug,
    limits,
  };
  Object.defineProperty(config, '_assets', { value: policy.assets });
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    metadata: adapted.metadata,
    config,
    capabilities: {
      protocols: { inbound: [...supported.inbound], outbound: [...supported.outbound] },
      transports: ['tcp', 'tls', 'ws', 'wss', 'xhttp'],
      udp: ['vless', 'freedom', 'socks', 'vmess', 'mux', 'xudp', 'reverse'],
      reverse: true,
      mux: true,
    },
  };
}
function normalizeConfig(input, options) {
  const report = checkConfig(input, options);
  if (!report.ok)
    throw new Js2rayError('ERR_CONFIG', 'Configuration validation failed.', {
      phase: 'config',
      context: { diagnostics: report.diagnostics },
    });
  return report.config;
}
function redact(value) {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (
        /^(id|user|pass|password|email|key|cert|ca|pfx|headers)$/i.test(key) ||
        /token|secret|authorization|cookie/i.test(key)
      )
        return '<redacted>';
      if (key === 'path' && typeof entry === 'string' && entry.startsWith('/')) return '<redacted>';
      return typeof entry === 'function' ? '<function>' : entry;
    }),
  );
}
module.exports = { checkConfig, normalizeConfig, redact, host, port };
