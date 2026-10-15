'use strict';
// Matched values stay in memory. Reports contain field paths only.
const net = require('node:net');
function collect(input) {
  const secrets = [],
    ports = [];
  function add(field, value, { key = false, short = false } = {}) {
    if (
      typeof value !== 'string' ||
      !value ||
      value === '/' ||
      value === 'localhost' ||
      (net.isIP(value) && /^(127\.|0\.|::1$)/.test(value))
    )
      return;
    const variants = new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ]);
    if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) {
      variants.add(value.replaceAll('-', ''));
      variants.add(value.toUpperCase());
      variants.add(value.toLowerCase());
    }
    if (key && /^[\w-]{43}$/.test(value)) {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length === 32) {
        variants.add(bytes.toString('base64'));
        variants.add(bytes.toString('hex'));
      }
    }
    if (short) {
      variants.add(value.toUpperCase());
      variants.add(value.toLowerCase());
    }
    secrets.push({ field, variants: [...variants], short });
  }
  function port(field, value) {
    if (Number.isInteger(value) && value > 0 && value <= 65535) ports.push({ field, value });
  }
  function endpoint(field, value) {
    const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value ?? '');
    if (
      match &&
      ((match[1] || match[2]) === 'localhost' || /^(127\.|0\.|::1$)/.test(match[1] || match[2]))
    )
      return;
    add(field, value);
    if (match) {
      add(field + '.host', match[1] || match[2]);
      port(field + '.port', Number(match[3]));
    }
  }
  function walk(value, prefix, inBound = false, outbound = false) {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      const field = prefix + '.' + name,
        lower = name.toLowerCase();
      if (
        /prefix/i.test(name) ||
        /^(id|user|useremail|clientip|source|sourceip|sourceport|pass|password|email|privatekey|publickey|shortid|shortids|key|token|secret|authorization|cookie)$/.test(
          lower,
        )
      )
        for (const entry of Array.isArray(item) ? item : [item])
          add(field, entry, {
            key: /^(privatekey|publickey)$/.test(lower),
            short: /^shortids?$/.test(lower),
          });
      if (prefix.startsWith('$.dns')) {
        if (['address', 'clientip', 'servername'].includes(lower) && typeof item === 'string') {
          add(field, item);
          try {
            const url = new URL(item.replace(/^(tcp|https)\+local:/, '$1:'));
            add(field + '.host', url.hostname);
            if (url.port) port(field + '.port', Number(url.port));
          } catch {}
        }
        if (lower === 'port') port(field, item);
      }
      if (lower === 'attrs' && item && typeof item === 'object')
        for (const entry of Object.values(item)) add(field + '.value', entry);
      if (inBound) {
        if (['address', 'listen', 'servername', 'servernames', 'host'].includes(lower))
          for (const entry of Array.isArray(item) ? item : [item]) add(field, entry);
        if (['dest', 'redirect'].includes(lower)) endpoint(field, item);
        if (lower === 'port' && outbound) port(field, item);
        if (lower === 'path') {
          add(field, item);
          if (typeof item === 'string')
            for (const [index, part] of item.split(/[/?&#=]+/).entries())
              if (part.length >= 6 && !['vless', 'websocket', 'dns-query'].includes(part))
                add(field + `.fragment[${index}]`, part);
        }
        if (lower === 'headers' && item && typeof item === 'object')
          for (const [header, entry] of Object.entries(item))
            if (/^(host|authorization|cookie|x-api-key)$/i.test(header))
              add(field + '.' + header, entry);
      }
      if (name === 'outbounds' || name === 'inbounds') {
        if (Array.isArray(item))
          for (const [index, bound] of item.entries())
            walk(bound, field + `[${index}]`, true, name === 'outbounds');
      } else walk(item, field, inBound, outbound);
    }
  }
  walk(input, '$');
  return { secrets, ports };
}
function scan(material, file, text, object) {
  const matches = [],
    genericPorts = [];
  for (const secret of material.secrets)
    if (
      secret.variants.some((value) => {
        if (secret.short && value.length < 8)
          return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).includes(value.toLowerCase());
        return text.includes(value);
      })
    )
      matches.push({ file, field: secret.field, ...(object ? { object } : {}) });
  for (const port of material.ports)
    if (new RegExp(`(^|[^a-zA-Z0-9])${port.value}([^a-zA-Z0-9]|$)`).test(text)) {
      if ([53, 80, 443].includes(port.value)) genericPorts.push(port.field);
      else matches.push({ file, field: port.field, ...(object ? { object } : {}) });
    }
  return { matches, genericPorts };
}
module.exports = { collect, scan };
