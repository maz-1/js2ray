'use strict';
const fs = require('node:fs'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (file) => sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
function sourceEvidence() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true })
    .split('\0')
    .filter((file) =>
      /^(?:index\.(?:js|mjs|d\.ts)|(?:cli|adapters|config|runtime|transports|protocols|reverse|dns|routing|geodata|core)\/.*\.js)$/.test(
        file,
      ),
    )
    .sort();
  const sources = Object.fromEntries(files.map((file) => [file, digest(file)]));
  return {
    sourceNormalization: 'UTF-8, CRLF to LF',
    sources,
    sourceSha256: sha(
      Object.entries(sources)
        .map(([file, value]) => `${value} ${file}\n`)
        .join(''),
    ),
    dependenciesSha256: digest('package-lock.json'),
  };
}
function verify(record, { formal = true, current = true } = {}) {
  if (
    !record.passed ||
    (formal &&
      (!record.formalAcceptance ||
        record.concurrentSessions < 100 ||
        record.durationMinutes < 30 ||
        record.elapsedMs < 1800000))
  )
    throw Error('Acceptance record did not pass the requested duration and concurrency.');
  if (
    !Array.isArray(record.closed) ||
    !record.closed.length ||
    record.closed.some(
      (s) =>
        s.state !== 'closed' ||
        s.connections !== 0 ||
        s.pendingDials !== 0 ||
        s.listeners !== 0 ||
        s.generations !== 0,
    )
  )
    throw Error('Acceptance record did not release runtime resources.');
  if (current) {
    const expected = sourceEvidence();
    if (
      JSON.stringify(record.sources) !== JSON.stringify(expected.sources) ||
      record.sourceSha256 !== expected.sourceSha256
    )
      throw Error('Acceptance product sources differ from current checkout.');
    if (record.dependenciesSha256 && record.dependenciesSha256 !== expected.dependenciesSha256)
      throw Error('Acceptance dependencies differ from current checkout.');
  }
  if (record.closedProxyProcesses?.some((p) => !p.exited))
    throw Error('Acceptance proxy process remains alive.');
  return true;
}
module.exports = { sha, digest, sourceEvidence, verify };
if (require.main === module) {
  for (const file of process.argv.slice(2)) verify(JSON.parse(fs.readFileSync(file, 'utf8')));
  process.stdout.write('acceptance-evidence-ok\n');
}
