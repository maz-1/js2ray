'use strict';
const fields = [
  'host',
  'mode',
  'httpVersion',
  'xPaddingBytes',
  'noGRPCHeader',
  'noSSEHeader',
  'scMaxEachPostBytes',
  'scMaxBufferedPosts',
  'scStreamUpServerSecs',
  'xmux',
  'downloadSettings',
];
const xmuxFields = [
  'maxConcurrency',
  'maxConnections',
  'cMaxReuseTimes',
  'hMaxRequestTimes',
  'hMaxReusableSecs',
  'hKeepAlivePeriod',
];
function range(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) return;
  const from = Number(match[1]),
    to = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to > 2147483647)
    return;
  return { from, to };
}
function xmuxSettings(input = {}) {
  const values = Object.fromEntries(
    xmuxFields.slice(0, -1).map((field) => [field, range(input[field] ?? 0)]),
  );
  const keepAlive = input.hKeepAlivePeriod ?? 0;
  if (!keepAlive && Object.values(values).every((value) => value.to === 0)) {
    values.maxConcurrency = { from: 16, to: 32 };
    values.hMaxRequestTimes = { from: 600, to: 900 };
    values.hMaxReusableSecs = { from: 1800, to: 3000 };
  }
  return { ...values, hKeepAlivePeriod: keepAlive };
}
function validate(option, add, prefix, inbound) {
  if (option.downloadSettings !== undefined) {
    if (inbound) add(prefix + '.downloadSettings', 'Download settings are outbound-only.');
    if (option.mode === 'stream-one')
      add(prefix + '.downloadSettings', 'stream-one uses one request and cannot split directions.');
  }
  if (option.xmux !== undefined) {
    const value = option.xmux,
      path = prefix + '.xmux';
    if (!value || typeof value !== 'object' || Array.isArray(value))
      add(path, 'Expected XMUX settings.');
    else {
      for (const field of Object.keys(value))
        if (!xmuxFields.includes(field))
          add(path + '.' + field, 'Unsupported XMUX behavior field.');
      for (const field of xmuxFields.slice(0, -1))
        if (value[field] !== undefined && !range(value[field]))
          add(path + '.' + field, 'Expected an integer or inclusive range within 0–2147483647.');
      if (
        value.hKeepAlivePeriod !== undefined &&
        (!Number.isSafeInteger(value.hKeepAlivePeriod) ||
          Math.abs(value.hKeepAlivePeriod) > 2147483647)
      )
        add(
          path + '.hKeepAlivePeriod',
          'Expected an integer in seconds; negative disables HTTP/2 keepalive.',
        );
      if (range(value.maxConcurrency ?? 0)?.to > 0 && range(value.maxConnections ?? 0)?.to > 0)
        add(path, 'maxConcurrency and maxConnections cannot both be positive.');
      // Xray accepts this client policy in server configurations too; it has no wire effect there.
    }
  }
  if (option.host !== undefined && option.host !== '') {
    try {
      if (!new URL('http://' + option.host).hostname) throw Error();
    } catch {
      add(prefix + '.host', 'Expected a valid HTTP authority.');
    }
  }
  if (
    option.host !== undefined &&
    (typeof option.host !== 'string' || /[\s/\\?#@]/.test(option.host))
  )
    add(prefix + '.host', 'Expected an HTTP authority without whitespace or URL components.');
  if (!['auto', 'packet-up', 'stream-up', 'stream-one'].includes(option.mode ?? 'auto'))
    add(prefix + '.mode', 'Expected auto, packet-up, stream-up or stream-one.');
  if (!['auto', '1.1', '2', '3'].includes(option.httpVersion ?? 'auto'))
    add(prefix + '.httpVersion', 'Expected auto, 1.1, 2 or 3.');
  if (option.httpVersion === '3') {
    if (!option.tls) add(prefix + '.tls', 'HTTP/3 requires explicit integrated TLS settings.');
    if (option.xmux?.hKeepAlivePeriod !== undefined && option.xmux.hKeepAlivePeriod !== -1)
      add(prefix + '.xmux.hKeepAlivePeriod', 'HTTP/3 has no HTTP/2 PING policy; omit or use -1.');
  }
  if (
    option.path !== undefined &&
    (/[\s\\]/.test(option.path) || /%(?![0-9a-f]{2})/i.test(option.path))
  )
    add(prefix + '.path', 'Expected an encoded HTTP path.');
  if (option.xPaddingBytes !== undefined) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(String(option.xPaddingBytes));
    if (
      !match ||
      Number(match[1]) < 1 ||
      Number(match[2] ?? match[1]) < Number(match[1]) ||
      Number(match[2] ?? match[1]) > 4096
    )
      add(prefix + '.xPaddingBytes', 'Expected a padding length or range within 1–4096.');
  }
  for (const field of ['noGRPCHeader', 'noSSEHeader'])
    if (option[field] !== undefined && typeof option[field] !== 'boolean')
      add(prefix + '.' + field, 'Expected a boolean.');
  for (const [field, maximum] of [
    ['scMaxEachPostBytes', 1048576],
    ['scMaxBufferedPosts', 128],
  ])
    if (
      option[field] !== undefined &&
      (!Number.isSafeInteger(option[field]) || option[field] < 1 || option[field] > maximum)
    )
      add(prefix + '.' + field, `Expected an integer within 1–${maximum}.`);
  if (
    option.scStreamUpServerSecs !== undefined &&
    (!Number.isInteger(option.scStreamUpServerSecs) ||
      option.scStreamUpServerSecs < -1 ||
      option.scStreamUpServerSecs === 0 ||
      option.scStreamUpServerSecs > 3600)
  )
    add(prefix + '.scStreamUpServerSecs', 'Expected -1 or an interval within 1–3600 seconds.');
  if (inbound && option.headers && Object.keys(option.headers).length)
    add(prefix + '.headers', 'XHTTP custom request headers are outbound-only.');
}
module.exports = { fields, validate, range, xmuxSettings };
