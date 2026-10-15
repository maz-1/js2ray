'use strict';
// Opt-in only. The source file and its credentials are never copied or printed.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createRuntime } = require('../');
const { StreamReader } = require('../runtime/reader');

async function main() {
  const filename = path.resolve(process.argv[2] ?? 'v2ray-config.json');
  const original = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const outbound = original.outbounds.find((item) => item.tag === (process.argv[3] ?? 'proxy'));
  if (!outbound) throw new Error('Required outbound is absent.');
  const lookup = (hostname, options, callback) => {
    const mapped = original.dns?.hosts?.[hostname];
    if (typeof mapped === 'string' && net.isIP(mapped)) {
      const item = { address: mapped, family: net.isIP(mapped) };
      return callback(null, options.all ? [item] : item.address, item.family);
    }
    require('node:dns').lookup(hostname, options, callback);
  };
  const runtime = createRuntime(
    { inbounds: [], outbounds: [outbound] },
    { baseDir: path.dirname(filename), lookup },
  );
  try {
    await runtime.start();
    const stream = await runtime.dial({ host: 'example.com', port: 80 });
    stream.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    const reader = new StreamReader(stream, { timeoutMs: 15000, maxBytes: 4096 });
    let status = '';
    while (!status.endsWith('\r\n')) status += (await reader.read(1)).toString('ascii');
    if (!/^HTTP\/1\.[01] [23]\d\d /.test(status))
      throw new Error('Remote HTTP response was not successful.');
    process.stdout.write(
      JSON.stringify({
        ok: true,
        status: Number(status.split(' ')[1]),
        localProxyListeners: runtime.listenersInfo.length,
      }) + '\n',
    );
  } finally {
    await runtime.close();
  }
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({ ok: false, code: error.code ?? 'ERR_SMOKE', phase: error.phase ?? 'smoke' }) +
      '\n',
  );
  process.exitCode = 1;
});
