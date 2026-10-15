'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script through npm run test:package.');
function command(args, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
}
const [packed] = JSON.parse(command([npm, 'pack', '--json', '--ignore-scripts'], root));
for (const entry of packed.files) {
  assert.ok(
    !/v2ray-config|\.test-tools|node_modules|test\/|\.exe$|\.wasm$|\.node$|install\.js$/.test(
      entry.path,
    ),
    entry.path,
  );
}
const archive = path.join(root, packed.filename);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js2ray-package-'));
try {
  fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
  command(
    [
      npm,
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      archive,
    ],
    directory,
  );
  const installed = JSON.parse(
    fs.readFileSync(path.join(directory, 'node_modules/js2ray/package.json'), 'utf8'),
  );
  assert.equal(installed.scripts.install, undefined);
  assert.equal(installed.scripts.postinstall, undefined);
  assert.deepEqual(Object.keys(installed.dependencies), ['ws']);
  command(
    [
      '-e',
      `(async () => {
    const assert = require('node:assert/strict');
    const api = require('js2ray');
    const esm = await import('js2ray');
    assert.equal(typeof esm.createRuntime, 'function');
    for (const name of ['createHttpAgent','createHttpsAgent','createUndiciConnector','createUndiciDispatcher','createWebSocket','createRuntimeManager','RuntimeManager']) assert.equal(typeof esm[name], 'function');
    assert.equal(global.log, undefined);
    const runtime = api.createRuntime({inbounds:[]});
    await runtime.start();
    assert.equal(runtime.listenersInfo.length, 0);
    await runtime.close();
    const manager = api.createRuntimeManager({inbounds:[]});
    await manager.start();
    const rotation = await manager.rotate({}); await rotation.drained;
    await manager.close();
    const net = require('node:net');
    const target = net.createServer(socket => socket.pipe(socket));
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
    const server = api.createRuntime({inbounds:[{protocol:'vless',users:[{id}],networks:[{type:'xhttp',port:0,option:{mode:'stream-one',httpVersion:'2'}}]}]});
    await server.start();
    const client = api.createRuntime({outbounds:[{protocol:'vless',users:[{id,encryption:'none'}],networks:[{type:'xhttp',address:'127.0.0.1',port:server.listenersInfo[0].address.port,option:{mode:'stream-one',httpVersion:'2'}}]}]});
    await client.start();
    const stream = await client.dial({host:'127.0.0.1',port:target.address().port});
    stream.write('packed-xhttp');
    const chunks = []; let received = 0;
    for await (const chunk of stream) { chunks.push(chunk); received += chunk.length; if (received >= 12) break; }
    assert.equal(Buffer.concat(chunks).toString(), 'packed-xhttp');
    assert.equal(client.listenersInfo.length, 0);
    await client.close(); await server.close();
    await new Promise(resolve => target.close(resolve));
    console.log('package-ok');
  })().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    directory,
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      version: packed.version,
      packageFiles: packed.files.length,
      nativeRuntimeAssets: 0,
    }) + '\n',
  );
} finally {
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('js2ray-package-')
  )
    throw new Error('Unexpected cleanup path.');
  fs.rmSync(directory, { recursive: true, force: true });
  if (path.dirname(archive) !== root || path.basename(archive) !== packed.filename)
    throw new Error('Unexpected package path.');
  fs.rmSync(archive);
}
