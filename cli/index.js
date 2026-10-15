#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime, checkConfig, redact } = require('../');

async function main(args) {
  const [command, file] = args;
  if (!['check', 'run', 'check-cover'].includes(command) || !file) {
    process.stderr.write('Usage: js2ray <check|run|check-cover> <config.json>\n');
    process.exitCode = 2;
    return;
  }
  const filename = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const options = { baseDir: path.dirname(filename) };
  if (command === 'check') {
    const report = checkConfig(config, options);
    process.stdout.write(JSON.stringify(redact(report), null, 2) + '\n');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === 'check-cover') {
    const normalized = require('../config').normalizeConfig(config, options);
    const controller = new AbortController();
    const { Resolver } = require('../dns');
    const resolver = new Resolver(normalized.dns, {
      data: normalized._assets,
      signal: controller.signal,
    });
    try {
      const results = [];
      for (const inbound of normalized.inbounds)
        for (const network of inbound.networks)
          if (network.option.reality)
            results.push(
              ...(await require('../transports/reality').inspectCover(network.option.reality, {
                ...normalized.limits,
                signal: controller.signal,
                lookup: resolver.bootstrapLookup,
              })),
            );
      if (!results.length)
        throw require('../runtime/errors').failure(
          'ERR_CONFIG',
          'No REALITY inbound cover is configured.',
          'config',
        );
      process.stdout.write(JSON.stringify({ ok: true, covers: results }) + '\n');
    } finally {
      controller.abort();
      resolver.close();
    }
    return;
  }
  const runtime = createRuntime(config, {
    ...options,
    logger: (event) => process.stderr.write(JSON.stringify(event) + '\n'),
  });
  await runtime.start();
  const close = () =>
    runtime.close({ drainTimeoutMs: 5000 }).catch((error) => {
      process.stderr.write(JSON.stringify(error.toJSON?.() ?? { code: 'ERR_CLOSE' }) + '\n');
      process.exitCode = 1;
    });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    JSON.stringify(
      error.toJSON?.() ?? { code: 'ERR_CLI', message: 'Cannot read or run configuration.' },
    ) + '\n',
  );
  process.exitCode = 1;
});
