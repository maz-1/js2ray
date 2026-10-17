'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const available = require('node:module').isBuiltin('node:quic');

for (const esm of [false, true]) {
  test(`ordinary ${esm ? 'ESM' : 'CJS'} import and TCP proxy emits no QUIC warning`, () => {
    const code = `${esm ? "import api from './index.mjs'; import net from 'node:net'; import {once} from 'node:events';" : "const api=require('./');const net=require('node:net');const {once}=require('node:events');"}
      (async()=>{
        const echo=net.createServer(s=>s.pipe(s));echo.listen(0,'127.0.0.1');await once(echo,'listening');
        const r=api.createRuntime();await r.start();const s=await r.dial({host:'127.0.0.1',port:echo.address().port});
        const data=once(s,'data');s.write('ordinary');if((await data)[0].toString()!=='ordinary')throw Error('data mismatch');
        s.destroy();await r.close();await new Promise(resolve=>echo.close(resolve));
      })().catch(e=>{console.error(e);process.exitCode=1;});`;
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, ...(esm ? ['--input-type=module'] : []), '-e', code],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /quic|ExperimentalWarning/i);
  });
}

test(
  'CLI check is pure; CLI run rejects unsupported QUIC before TCP binds',
  { skip: available },
  (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-quic-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'synthetic.json');
    const config = {
      inbounds: [{ protocol: 'socks', networks: [{ port: 0 }] }],
      outbounds: [
        { protocol: 'freedom' },
        {
          protocol: 'vless',
          users: [{ id: 'd342d11e-d424-4583-b36e-524ab1f0afa4', encryption: 'none' }],
          networks: [{ type: 'quic', address: '127.0.0.1', port: 443, option: { tls: {} } }],
        },
      ],
    };
    fs.writeFileSync(filename, JSON.stringify(config));
    const run = (command) =>
      spawnSync(process.execPath, [...process.execArgv, 'cli/index.js', command, filename], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 5000,
      });
    assert.equal(run('check').status, 0);
    const result = run('run');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERR_UNSUPPORTED/);
    assert.match(result.stderr, /--experimental-quic/);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
  },
);
