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
];
function validate(option, add, prefix, inbound) {
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
  if (!['auto', '1.1', '2'].includes(option.httpVersion ?? 'auto'))
    add(prefix + '.httpVersion', 'Expected auto, 1.1 or 2.');
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
module.exports = { fields, validate };
