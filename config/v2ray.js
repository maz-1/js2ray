'use strict';

// Convert the accepted traditional JSON subset before validating its behavior.
function adaptV2ray(input, add) {
  const metadata = [];
  const checkKeys = (object, allowed, prefix) => {
    for (const key of Object.keys(object ?? {}))
      if (!allowed.includes(key)) add(`${prefix}.${key}`, 'Unsupported V2Ray behavior field.');
  };
  const transport = (stream = {}, prefix) => {
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
      add(prefix, 'Expected stream settings.');
      stream = {};
    }
    checkKeys(stream, ['network', 'security', 'tlsSettings', 'wsSettings', 'tcpSettings'], prefix);
    const network = stream.network ?? 'tcp';
    if (!['tcp', 'ws'].includes(network)) add(`${prefix}.network`, 'Transport is not implemented.');
    const security = stream.security ?? 'none';
    if (!['none', 'tls'].includes(security))
      add(`${prefix}.security`, 'Only none and TLS transport security are implemented.');
    const option = {};
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
      checkKeys(tls, ['serverName', 'allowInsecure', 'certificates'], `${prefix}.tlsSettings`);
      option.tls = { serverName: tls.serverName, rejectUnauthorized: !tls.allowInsecure };
      if (tls.certificates) {
        if (!Array.isArray(tls.certificates) || tls.certificates.length !== 1)
          add(`${prefix}.tlsSettings.certificates`, 'Exactly one certificate pair is supported.');
        const pair = tls.certificates[0] ?? {};
        checkKeys(pair, ['certificateFile', 'keyFile'], `${prefix}.tlsSettings.certificates[0]`);
        option.tls.certFile = pair.certificateFile;
        option.tls.keyFile = pair.keyFile;
      }
    } else if (stream.tlsSettings)
      add(`${prefix}.tlsSettings`, 'TLS settings require security tls.');
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
        if (settings.udp) add(`${prefix}.settings.udp`, 'SOCKS UDP is not implemented.');
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
