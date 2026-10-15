'use strict';
const { host: validHost } = require('../config');
const { failure } = require('../runtime/errors');

// undefined means incomplete; null means this prefix cannot yield a supported name.
function inspectMetadata(bytes, protocols = ['http', 'tls', 'bittorrent']) {
  if (!bytes.length) return undefined;
  if (bytes[0] === 19 && protocols.includes('bittorrent')) {
    const prefix = Buffer.from('\x13BitTorrent protocol');
    if (
      !bytes
        .subarray(0, Math.min(bytes.length, prefix.length))
        .equals(prefix.subarray(0, Math.min(bytes.length, prefix.length)))
    )
      return null;
    return bytes.length < prefix.length ? undefined : { protocol: 'bittorrent' };
  }
  if (bytes[0] === 22 && protocols.includes('tls')) {
    let offset = 0;
    const parts = [];
    while (offset < bytes.length) {
      if (bytes.length - offset < 5) return undefined;
      if (bytes[offset] !== 22 || bytes[offset + 1] !== 3) return null;
      const length = bytes.readUInt16BE(offset + 3);
      if (!length || length > 18432) return null;
      if (bytes.length < offset + 5 + length) return undefined;
      parts.push(bytes.subarray(offset + 5, offset + 5 + length));
      offset += 5 + length;
      const hello = Buffer.concat(parts);
      if (hello.length < 4) continue;
      if (hello[0] !== 1) return null;
      const end = hello.readUIntBE(1, 3) + 4;
      if (hello.length < end) continue;
      try {
        let p = 38;
        p += 1 + hello[p];
        p += 2 + hello.readUInt16BE(p);
        p += 1 + hello[p];
        const extensionsEnd = p + 2 + hello.readUInt16BE(p);
        p += 2;
        if (extensionsEnd > end) return null;
        while (p + 4 <= extensionsEnd) {
          const type = hello.readUInt16BE(p),
            size = hello.readUInt16BE(p + 2);
          p += 4;
          if (p + size > extensionsEnd) return null;
          if (type === 0) {
            const listEnd = p + 2 + hello.readUInt16BE(p);
            let q = p + 2;
            if (listEnd !== p + size) return null;
            while (q + 3 <= listEnd) {
              const nameType = hello[q],
                length = hello.readUInt16BE(q + 1);
              q += 3;
              if (q + length > listEnd) return null;
              if (nameType === 0) {
                const name = hello.subarray(q, q + length).toString('ascii');
                return validHost(name) ? { host: name.toLowerCase(), protocol: 'tls' } : null;
              }
              q += length;
            }
          }
          p += size;
        }
      } catch {
        return null;
      }
      return { protocol: 'tls' };
    }
    return undefined;
  }
  if (!protocols.includes('http') || !/^[A-Z]/.test(String.fromCharCode(bytes[0]))) return null;
  const text = bytes.toString('latin1'),
    end = text.indexOf('\r\n\r\n');
  if (end < 0) return undefined;
  const request = /^([A-Z]+) ([^\r\n ]+) HTTP\/1\.[01]\r\n/.exec(text);
  if (!request) return null;
  const names = text
    .slice(0, end)
    .split('\r\n')
    .slice(1)
    .filter((line) => /^host:/i.test(line));
  if (names.length > 1) return null;
  const attrs = Object.create(null);
  attrs[':method'] = request[1];
  attrs[':path'] = request[2];
  const lines = text.slice(0, end).split('\r\n').slice(1);
  if (lines.length > 128) return null;
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!header) return null;
    const key = header[1].toLowerCase(),
      value = header[2].trim();
    attrs[key] = attrs[key] === undefined ? value : attrs[key] + ', ' + value;
  }
  if (!names.length) return { protocol: 'http', attrs };
  const value = names[0].slice(5).trim(),
    match = /^(?:\[([^\]]+)\]|([^:]+))(?::\d+)?$/.exec(value);
  const name = match && (match[1] || match[2]);
  return name && validHost(name) ? { host: name.toLowerCase(), protocol: 'http', attrs } : null;
}
function inspect(bytes, protocols) {
  const result = inspectMetadata(bytes, protocols);
  return result ? (result.host ?? null) : result;
}

async function sniff(stream, options = {}, signal) {
  if (!options.enabled) return undefined;
  const chunks = [];
  let size = 0;
  const limit = options.maxBytes ?? 16384,
    deadline = Date.now() + (options.timeoutMs ?? 200);
  stream.pause();
  try {
    while (size < limit) {
      if (signal?.aborted) throw failure('ERR_CANCELLED', 'Sniffing cancelled.', 'routing');
      const available = Math.min(stream.readableLength, limit - size);
      const chunk = available ? stream.read(available) : null;
      if (chunk) {
        chunks.push(chunk);
        size += chunk.length;
        const result = inspectMetadata(Buffer.concat(chunks, size));
        if (result !== undefined) return result ?? undefined;
      } else {
        if (stream.destroyed || stream.readableEnded || Date.now() >= deadline) return undefined;
        const ready = await new Promise((resolve, reject) => {
          const finish = (error, result) => {
            clearTimeout(timer);
            stream.removeListener('readable', readable);
            stream.removeListener('end', ended);
            stream.removeListener('close', ended);
            stream.removeListener('error', failed);
            signal?.removeEventListener('abort', cancelled);
            error ? reject(error) : resolve(result);
          };
          const readable = () => finish(undefined, true),
            ended = () => finish(undefined, false),
            failed = (error) => finish(error),
            cancelled = () => finish(failure('ERR_CANCELLED', 'Sniffing cancelled.', 'routing'));
          const timer = setTimeout(ended, Math.max(1, deadline - Date.now()));
          stream.once('readable', readable);
          stream.once('end', ended);
          stream.once('close', ended);
          stream.once('error', failed);
          signal?.addEventListener('abort', cancelled, { once: true });
        });
        if (!ready) return undefined;
      }
    }
    return undefined;
  } finally {
    if (chunks.length && !stream.destroyed) stream.unshift(Buffer.concat(chunks, size));
  }
}
module.exports = { inspect, inspectMetadata, sniff };
