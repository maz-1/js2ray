'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('import is inert and an isolated process exits naturally', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const signals = ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'uncaughtException', 'exit'];
    const before = signals.map(name => process.listenerCount(name));
    const stdin = process.stdin.isPaused();
    require('./');
    assert.deepEqual(signals.map(name => process.listenerCount(name)), before);
    assert.equal(process.stdin.isPaused(), stdin);
    assert.equal(global.log, undefined);
    process.stdout.write('import-ok');
  `,
    ],
    { cwd: require('node:path').resolve(__dirname, '..'), timeout: 2000, encoding: 'utf8' },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'import-ok', 'import must not intercept assertion failures or exit');
});

test('exports the explicit runtime factory', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "console.log(typeof require('./').createRuntime)"],
    {
      cwd: require('node:path').resolve(__dirname, '..'),
      timeout: 1000,
      encoding: 'utf8',
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.stdout.trim(), 'function');
});
