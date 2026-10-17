'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const available = require('node:module').isBuiltin('node:quic');
const api = require('..');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const h3 = {
  type: 'xhttp',
  address: '127.0.0.1',
  port: 443,
  option: { httpVersion: '3', tls: {} },
};
const outbound = (network) => ({
  protocol: 'vless',
  users: [{ id, encryption: 'none' }],
  networks: [network],
});
test(
  'HTTP/3 unavailable builds: pure CLI check, unused/split/native/legacy Runtime and Manager guards',
  { skip: available },
  (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-h3-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const variants = [
      { outbounds: [{ protocol: 'freedom' }, outbound(h3)] },
      { outbounds: [outbound({ ...h3, option: { httpVersion: '2', downloadSettings: h3 } })] },
      {
        outbounds: [
          {
            protocol: 'vless',
            settings: {
              vnext: [{ address: '127.0.0.1', port: 443, users: [{ id, encryption: 'none' }] }],
            },
            streamSettings: { network: 'xhttp', security: 'tls', tlsSettings: { alpn: ['h3'] } },
          },
        ],
      },
    ];
    for (let n = 0; n < variants.length; n++) {
      const value = {
        ...variants[n],
        inbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port: 0 }] }],
      };
      assert.equal(api.checkConfig(value).ok, true);
      for (const factory of [api.createRuntime, api.createRuntimeManager])
        assert.throws(
          () => factory(value),
          (cause) => cause.code === 'ERR_UNSUPPORTED' && cause.phase === 'http3',
        );
      const filename = path.join(directory, `${n}.json`);
      fs.writeFileSync(filename, JSON.stringify(value));
      const run = (command) =>
        spawnSync(process.execPath, ['cli/index.js', command, filename], {
          cwd: path.join(__dirname, '..'),
          timeout: 4000,
          encoding: 'utf8',
          windowsHide: true,
        });
      assert.equal(run('check').status, 0);
      const result = run('run');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ERR_UNSUPPORTED/);
      assert.match(result.stderr, /--experimental-quic/);
      assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
    }
  },
);
for (const esm of [false, true])
  test(`HTTP/3 lazy guard preserves ordinary ${esm ? 'ESM' : 'CJS'} Manager communication without QUIC loading`, () => {
    const code = `${esm ? "import api from './index.mjs'; import net from 'node:net'; import {once} from 'node:events';" : "const api=require('./');const net=require('node:net');const {once}=require('node:events');"}
    (async()=>{const echo=net.createServer(s=>s.pipe(s));echo.listen(0,'127.0.0.1');await once(echo,'listening');
    const manager=api.createRuntimeManager();await manager.start();const s=await manager.dial({host:'127.0.0.1',port:echo.address().port});
    const received=once(s,'data');s.write('ordinary');if((await received)[0].toString()!=='ordinary')throw Error('mismatch');
    s.destroy();await manager.close();await new Promise(r=>echo.close(r));})().catch(e=>{console.error(e);process.exitCode=1});`;
    const result = spawnSync(
      process.execPath,
      [...(esm ? ['--input-type=module'] : []), '-e', code],
      { cwd: path.join(__dirname, '..'), timeout: 5000, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /quic|ExperimentalWarning/i);
  });
