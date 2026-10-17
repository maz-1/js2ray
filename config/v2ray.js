'use strict';

// Convert the accepted traditional JSON subset before validating its behavior.
function adaptV2ray(input, add) {
  const metadata = [];
  const checkKeys = (object, allowed, prefix) => {
    for (const key of Object.keys(object ?? {}))
      if (!allowed.includes(key)) add(`${prefix}.${key}`, 'Unsupported V2Ray behavior field.');
  };
  const transport = (stream = {}, prefix, download = false) => {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
      add(prefix, 'Expected stream settings.');
      stream = {};
    }
    checkKeys(
      stream,
      [
        'network',
        'security',
        'tlsSettings',
        'realitySettings',
        'wsSettings',
        'tcpSettings',
        'xhttpSettings',
        'quicSettings',
        ...(download ? ['address', 'port'] : []),
      ],
      prefix,
    );
    const network = stream.network === 'raw' ? 'tcp' : (stream.network ?? 'tcp');
    if (!['tcp', 'ws', 'xhttp', 'quic'].includes(network))
      add(`${prefix}.network`, 'Transport is not implemented.');
    const security = stream.security ?? 'none';
    if (!['none', 'tls', 'reality'].includes(security))
      add(`${prefix}.security`, 'Supported transport security: none, TLS and REALITY.');
    const option = {};
    if (stream.quicSettings !== undefined) {
      const q = stream.quicSettings;
      if (network !== 'quic' || !q || typeof q !== 'object' || Array.isArray(q))
        add(prefix + '.quicSettings', 'Expected QUIC settings on network quic.');
      else {
        checkKeys(q, ['security', 'key', 'header'], prefix + '.quicSettings');
        if (q.security !== undefined && q.security !== 'none')
          add(
            prefix + '.quicSettings.security',
            'QUIC UDP packet encryption is unsupported; use none.',
          );
        if (q.key !== undefined && q.key !== '')
          add(prefix + '.quicSettings.key', 'QUIC packet encryption keys are unsupported.');
        if (q.header !== undefined) {
          if (!q.header || typeof q.header !== 'object' || Array.isArray(q.header))
            add(prefix + '.quicSettings.header', 'Expected header type none.');
          else {
            checkKeys(q.header, ['type'], prefix + '.quicSettings.header');
            if (q.header.type !== undefined && q.header.type !== 'none')
              add(
                prefix + '.quicSettings.header.type',
                'QUIC packet disguise is unsupported; use none.',
              );
          }
        }
      }
    }
    if (security === 'reality') {
      if (network !== 'tcp') add(prefix + '.security', 'REALITY requires raw TCP.');
      option.reality = stream.realitySettings ?? {};
    } else if (stream.realitySettings !== undefined)
      add(prefix + '.realitySettings', 'REALITY settings require security reality.');
    if (stream.xhttpSettings !== undefined) {
      const xhttp = stream.xhttpSettings;
      if (network !== 'xhttp')
        add(prefix + '.xhttpSettings', 'XHTTP settings require network xhttp.');
      if (!xhttp || typeof xhttp !== 'object' || Array.isArray(xhttp))
        add(prefix + '.xhttpSettings', 'Expected XHTTP settings.');
      else {
        const fields = require('./xhttp').fields.filter((field) => field !== 'httpVersion');
        checkKeys(xhttp, ['path', 'headers', 'extra', ...fields], prefix + '.xhttpSettings');
        let extra = xhttp;
        if (xhttp.extra !== undefined) {
          if (!xhttp.extra || typeof xhttp.extra !== 'object' || Array.isArray(xhttp.extra))
            add(prefix + '.xhttpSettings.extra', 'Expected XHTTP extra settings.');
          else {
            checkKeys(
              xhttp.extra,
              ['headers', ...fields.filter((field) => !['host', 'mode'].includes(field))],
              prefix + '.xhttpSettings.extra',
            );
            if (
              Object.keys(xhttp).some((field) => !['host', 'path', 'mode', 'extra'].includes(field))
            )
              add(
                prefix + '.xhttpSettings',
                'Use host/path/mode/extra without overlapping fields.',
              );
            extra = xhttp.extra;
          }
        }
        Object.assign(option, extra);
        delete option.extra;
        option.host = xhttp.host;
        option.path = xhttp.path === '' ? '/' : (xhttp.path ?? '/');
        option.mode = xhttp.mode === '' ? 'auto' : (xhttp.mode ?? 'auto');
      }
    }
    if (stream.tcpSettings && Object.keys(stream.tcpSettings).length)
      add(`${prefix}.tcpSettings`, 'TCP camouflage is not accepted by this runtime.');
    if (stream.wsSettings) {
      if (typeof stream.wsSettings !== 'object' || Array.isArray(stream.wsSettings)) {
        add(`${prefix}.wsSettings`, 'Expected WebSocket settings.');
        return { type: network, option };
      }
      if (network !== 'ws') add(`${prefix}.wsSettings`, 'WebSocket settings require network ws.');
      checkKeys(stream.wsSettings, ['path', 'host', 'headers'], `${prefix}.wsSettings`);
      const ws = stream.wsSettings;
      if (
        ws.headers !== undefined &&
        (!ws.headers || typeof ws.headers !== 'object' || Array.isArray(ws.headers))
      )
        add(`${prefix}.wsSettings.headers`, 'Expected HTTP headers.');
      const headers = { ...ws.headers };
      const headerHost = Object.keys(headers).find((key) => key.toLowerCase() === 'host');
      if (headerHost && ws.host && headers[headerHost] !== ws.host)
        add(`${prefix}.wsSettings.host`, 'Conflicts with headers.Host.');
      if (ws.host && !headerHost) headers.Host = ws.host;
      option.path = ws.path ?? '/';
      option.headers = headers;
    }
    if (security === 'tls') {
      const tls = stream.tlsSettings ?? {};
      if (tls.allowInsecure !== undefined && typeof tls.allowInsecure !== 'boolean')
        add(`${prefix}.tlsSettings.allowInsecure`, 'Expected a boolean.');
      checkKeys(
        tls,
        [
          'serverName',
          'allowInsecure',
          'certificates',
          ...(['xhttp', 'quic'].includes(network) ? ['alpn'] : []),
        ],
        `${prefix}.tlsSettings`,
      );
      if (tls.alpn !== undefined && network === 'xhttp') {
        if (
          !Array.isArray(tls.alpn) ||
          !tls.alpn.length ||
          tls.alpn.some((value) => !['h3', 'h2', 'http/1.1'].includes(value)) ||
          (tls.alpn.includes('h3') && tls.alpn.length !== 1)
        )
          add(
            prefix + '.tlsSettings.alpn',
            'XHTTP h3 ALPN must appear alone; mixed HTTP/3 fallback is unsupported.',
          );
        else
          option.httpVersion =
            tls.alpn.length === 1
              ? tls.alpn[0] === 'h3'
                ? '3'
                : tls.alpn[0] === 'h2'
                  ? '2'
                  : '1.1'
              : 'auto';
      }
      option.tls = { serverName: tls.serverName, rejectUnauthorized: !tls.allowInsecure };
      if (network === 'quic' && tls.alpn !== undefined) option.tls.alpn = tls.alpn;
      if (tls.certificates) {
        if (!Array.isArray(tls.certificates) || tls.certificates.length !== 1)
          add(`${prefix}.tlsSettings.certificates`, 'Exactly one certificate pair is supported.');
        const pair = tls.certificates[0] ?? {};
        checkKeys(
          pair,
          ['certificateFile', 'keyFile', ...(['quic', 'xhttp'].includes(network) ? ['usage'] : [])],
          `${prefix}.tlsSettings.certificates[0]`,
        );
        if (['quic', 'xhttp'].includes(network) && pair.usage === 'verify') {
          option.tls.caFile = pair.certificateFile;
          if (pair.keyFile !== undefined)
            add(
              prefix + '.tlsSettings.certificates[0].keyFile',
              'CA verification does not accept a private key.',
            );
        } else {
          if (pair.usage !== undefined && pair.usage !== 'encipherment')
            add(
              prefix + '.tlsSettings.certificates[0].usage',
              'Supported QUIC certificate usage: encipherment or verify.',
            );
          option.tls.certFile = pair.certificateFile;
          option.tls.keyFile = pair.keyFile;
        }
      }
    } else if (stream.tlsSettings)
      add(`${prefix}.tlsSettings`, 'TLS settings require security tls.');
    if (option.downloadSettings !== undefined) {
      const value = option.downloadSettings;
      if (download) {
        add(
          prefix + '.xhttpSettings.downloadSettings',
          'Nested download settings are unsupported.',
        );
        delete option.downloadSettings;
      } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
        add(prefix + '.xhttpSettings.downloadSettings', 'Expected download stream settings.');
      } else {
        const converted = transport(value, prefix + '.xhttpSettings.downloadSettings', true);
        option.downloadSettings = { ...converted, address: value.address, port: value.port };
      }
    }
    return { type: network, option };
  };
  const convert = (bound, index, inbound) => {
    if (!bound || typeof bound !== 'object' || Array.isArray(bound)) return bound;
    if (
      !bound.settings &&
      !bound.streamSettings &&
      bound.port === undefined &&
      bound.listen === undefined
    )
      return bound;
    const prefix = `${inbound ? 'inbounds' : 'outbounds'}[${index}]`;
    checkKeys(
      bound,
      [
        'tag',
        'protocol',
        'settings',
        'streamSettings',
        ...(inbound ? ['port', 'listen', 'sniffing'] : ['mux']),
      ],
      prefix,
    );
    let settings = bound.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      add(`${prefix}.settings`, 'Expected protocol settings.');
      settings = {};
    }
    const result = { tag: bound.tag, protocol: bound.protocol };
    if (bound.sniffing !== undefined) result.sniffing = bound.sniffing;
    const stream = transport(bound.streamSettings, `${prefix}.streamSettings`);
    if (bound.mux) {
      checkKeys(bound.mux, ['enabled', 'concurrency'], `${prefix}.mux`);
      result.mux = bound.mux;
    }
    if (bound.protocol === 'freedom') {
      checkKeys(settings, ['redirect', 'domainStrategy'], `${prefix}.settings`);
      if (settings.redirect !== undefined) result.redirect = settings.redirect;
      if (settings.domainStrategy !== undefined) result.domainStrategy = settings.domainStrategy;
      if (bound.streamSettings)
        add(`${prefix}.streamSettings`, 'Freedom does not accept a proxy transport.');
      return result;
    }
    if (bound.protocol === 'blackhole') {
      checkKeys(settings, ['response'], `${prefix}.settings`);
      if (
        settings.response &&
        (settings.response.type !== 'none' ||
          Object.keys(settings.response).some((key) => key !== 'type'))
      )
        add(prefix + '.settings.response', 'Only silent Blackhole responses are supported.');
      return result;
    }
    if (inbound) {
      result.networks = [{ ...stream, address: bound.listen ?? '127.0.0.1', port: bound.port }];
      if (bound.protocol === 'dokodemo-door') {
        checkKeys(settings, ['address', 'port', 'network', 'followRedirect'], prefix + '.settings');
        if ((settings.network ?? 'tcp') !== 'tcp' || settings.followRedirect)
          add(prefix + '.settings', 'Only fixed TCP forwarding is supported.');
        result.protocol = 'tcp';
        result.target = { host: settings.address, port: settings.port };
      } else if (['vless', 'vmess'].includes(bound.protocol)) {
        checkKeys(
          settings,
          bound.protocol === 'vless' ? ['clients', 'decryption'] : ['clients'],
          `${prefix}.settings`,
        );
        result.users = settings.clients ?? [];
        if (bound.protocol === 'vless' && settings.decryption !== 'none')
          add(`${prefix}.settings.decryption`, 'VLESS requires decryption none.');
      } else if (bound.protocol === 'socks') {
        checkKeys(settings, ['auth', 'accounts', 'udp', 'allowTransparent'], `${prefix}.settings`);
        if (settings.udp !== undefined) result.udp = settings.udp;
        if (settings.allowTransparent)
          add(`${prefix}.settings.allowTransparent`, 'Transparent SOCKS is not implemented.');
        if (!['noauth', 'password'].includes(settings.auth ?? 'noauth'))
          add(`${prefix}.settings.auth`, 'Unsupported SOCKS authentication mode.');
        result.users = settings.auth === 'password' ? (settings.accounts ?? []) : [];
        if (settings.auth === 'password' && !result.users.length)
          add(`${prefix}.settings.accounts`, 'Password authentication requires accounts.');
      }
    } else {
      const key = bound.protocol === 'socks' ? 'servers' : 'vnext';
      checkKeys(settings, [key], `${prefix}.settings`);
      const nodes = settings[key];
      if (!Array.isArray(nodes) || nodes.length !== 1)
        add(`${prefix}.settings.${key}`, 'Exactly one server per outbound is currently supported.');
      const node = nodes?.[0] ?? {};
      checkKeys(node, ['address', 'port', 'users'], `${prefix}.settings.${key}[0]`);
      result.networks = [{ ...stream, address: node.address, port: node.port }];
      if (node.users !== undefined && !Array.isArray(node.users))
        add(`${prefix}.settings.${key}[0].users`, 'Expected an array.');
      result.users = (Array.isArray(node.users) ? node.users : []).map((user, j) => {
        const copy = { ...user };
        if (bound.protocol === 'vless' && Object.hasOwn(copy, 'security')) {
          if (copy.security !== 'auto')
            add(
              `${prefix}.settings.${key}[0].users[${j}].security`,
              'Only the recognized unused legacy value auto is accepted on VLESS.',
            );
          metadata.push({
            path: `${prefix}.settings.${key}[0].users[${j}].security`,
            reason:
              'Recognized unused VMess metadata on VLESS; encryption and TLS are validated independently.',
          });
          delete copy.security;
        }
        return copy;
      });
    }
    return result;
  };
  const result = { ...input };
  if (result.log) {
    checkKeys(result.log, ['loglevel'], 'log');
    if (!['debug', 'info', 'warning', 'error', 'none'].includes(result.log.loglevel))
      add('log.loglevel', 'Unknown log level.');
    metadata.push({
      path: 'log.loglevel',
      reason: 'Logging is injected by the library caller or CLI.',
    });
    delete result.log;
  }
  if (Array.isArray(input.inbounds))
    result.inbounds = input.inbounds.map((bound, index) => convert(bound, index, true));
  if (Array.isArray(input.outbounds))
    result.outbounds = input.outbounds.map((bound, index) => convert(bound, index, false));
  return { input: result, metadata };
}
module.exports = { adaptV2ray };
