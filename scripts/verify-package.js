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
  assert.deepEqual(Object.keys(installed.dependencies).sort(), ['re2js', 'ws']);
  const privateConfig = path.join(root, 'v2ray-config.json');
  if (fs.existsSync(privateConfig)) {
    const audit = require('./private-audit');
    const material = audit.collect(JSON.parse(fs.readFileSync(privateConfig, 'utf8')));
    for (const entry of packed.files) {
      const contents = fs
        .readFileSync(path.join(directory, 'node_modules/js2ray', entry.path))
        .toString('utf8');
      assert.equal(
        audit.scan(material, entry.path, contents).matches.length,
        0,
        'Installed package contains a private field.',
      );
    }
  }
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
    const policy=api.checkConfig({compatibility:'xray-25.3.6',dns:{clientIp:'192.0.2.99',servers:[{address:'tcp+local://127.0.0.1:53',queryStrategy:'UseIPv4'}]},routing:{rules:[{domains:['regexp:^api[0-9]+\\\\.synthetic$'],source:['127.0.0.0/8'],attrs:{':method':'^GET$'},outboundTag:'direct'}]}});
    assert.equal(policy.ok,true,JSON.stringify(policy.diagnostics));
    const policyRuntime=api.createRuntime({compatibility:'v2ray-5.14.1',dns:{hosts:{'installed.synthetic':'192.0.2.1'}}});await policyRuntime.start();assert.equal((await policyRuntime.resolve('installed.synthetic'))[0].address,'192.0.2.1');await policyRuntime.close();
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
    const client = api.createRuntime({outbounds:[{protocol:'vless',users:[{id,encryption:'none'}],networks:[{type:'xhttp',address:'127.0.0.1',port:server.listenersInfo[0].address.port,option:{mode:'stream-one',httpVersion:'2',xmux:{maxConnections:1}}}]}]});
    await client.start();
    const stream = await client.dial({host:'127.0.0.1',port:target.address().port});
    stream.write('packed-xhttp');
    const chunks = []; let received = 0;
    for await (const chunk of stream) { chunks.push(chunk); received += chunk.length; if (received >= 12) break; }
    assert.equal(Buffer.concat(chunks).toString(), 'packed-xhttp');
    assert.equal(client.listenersInfo.length, 0);
    assert.equal(client.metrics.xhttp.created, 1);
    const nextStream = await client.dial({host:'127.0.0.1',port:target.address().port});
    nextStream.write('packed-xmux');
    const nextChunks=[]; let nextReceived=0;
    for await (const chunk of nextStream) { nextChunks.push(chunk); nextReceived+=chunk.length; if(nextReceived>=11) break; }
    assert.equal(Buffer.concat(nextChunks).toString(), 'packed-xmux');
    assert.equal(client.metrics.xhttp.created, 1);
    await client.close(); await server.close();
    assert.equal(client.metrics.xhttp.clients, 0);
    assert.equal(client.metrics.xhttp.sockets, 0);
    const splitServer = api.createRuntime({inbounds:[{protocol:'vless',users:[{id}],networks:[{type:'xhttp',port:0,option:{path:'/shared/',httpVersion:'1.1'}}]}]});
    await splitServer.start();
    const cleanups=[];
    const {proxy} = require(${JSON.stringify(path.join(root, 'test/fixtures/xhttp-proxy.js'))});
    const up = await proxy({after:fn=>cleanups.push(fn)}, {target:{port:splitServer.listenersInfo[0].address.port},version:'2',prefix:'/up/',method:'POST'});
    const down = await proxy({after:fn=>cleanups.push(fn)}, {target:{port:splitServer.listenersInfo[0].address.port},version:'1.1',prefix:'/down/',method:'GET'});
    const splitNetwork = {...up.network,option:{...up.network.option,mode:'packet-up',downloadSettings:down.network}};
    const splitClient=api.createRuntime({outbounds:[{protocol:'vless',users:[{id,encryption:'none'}],networks:[splitNetwork]}]});
    await splitClient.start();
    const splitStream=await splitClient.dial({host:'127.0.0.1',port:target.address().port});
    splitStream.write('packed-split');
    const splitChunks=[]; let splitReceived=0;
    for await(const chunk of splitStream){splitChunks.push(chunk);splitReceived+=chunk.length;if(splitReceived>=12)break;}
    assert.equal(Buffer.concat(splitChunks).toString(),'packed-split');
    assert.equal(splitClient.metrics.xhttp.created,2);
    await splitClient.close();await splitServer.close();for(const cleanup of cleanups.reverse())await cleanup();
    assert.equal(splitClient.metrics.xhttp.clients,0);assert.equal(splitClient.stats.listeners,0);
    await new Promise(resolve => target.close(resolve));
    const tls = require('node:tls');
    const fs = require('node:fs');
    const { once } = require('node:events');
    const cert = fs.readFileSync(${JSON.stringify(path.join(root, 'test/fixtures/tls/cert.pem'))}, 'utf8');
    const key = fs.readFileSync(${JSON.stringify(path.join(root, 'test/fixtures/tls/key.pem'))}, 'utf8');
    const tlsTarget = tls.createServer({cert,key,minVersion:'TLSv1.3',allowHalfOpen:true}, socket => socket.pipe(socket));
    await new Promise(resolve => tlsTarget.listen(0,'127.0.0.1',resolve));
    const flow = 'xtls-rprx-vision';
    const visionServer = api.createRuntime({inbounds:[{protocol:'vless',users:[{id,flow}],networks:[{port:0,option:{tls:{cert,key}}}]}]});
    await visionServer.start();
    const visionClient = api.createRuntime({outbounds:[{protocol:'vless',users:[{id,flow,encryption:'none'}],networks:[{address:'127.0.0.1',port:visionServer.listenersInfo[0].address.port,option:{tls:{ca:cert,serverName:'js2ray.test'}}}]}]});
    await visionClient.start();
    const tunnel = await visionClient.dial({host:'127.0.0.1',port:tlsTarget.address().port});
    const inner = tls.connect({socket:tunnel,ca:cert,servername:'js2ray.test',minVersion:'TLSv1.3'});
    inner.on('error',()=>{}); await once(inner,'secureConnect');
    inner.write('packed-vision');
    const reply = []; let total = 0;
    for await (const chunk of inner) { reply.push(chunk); total += chunk.length; if(total >= 13) break; }
    assert.equal(Buffer.concat(reply).toString(),'packed-vision');
    assert.equal(visionClient.metrics.visionReadSwitches,1);
    assert.equal(visionClient.metrics.visionWriteSwitches,1);
    inner.destroy(); tunnel.destroy();
    await visionClient.close(); await visionServer.close();
    await new Promise(resolve => tlsTarget.close(resolve));
    const coverSockets = new Set();
    const cover = tls.createServer({cert,key,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ecdhCurve:'X25519'}, socket => socket.pipe(socket));
    cover.on('tlsClientError',()=>{});
    cover.on('connection',socket=>{coverSockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>coverSockets.delete(socket));});
    await new Promise(resolve=>cover.listen(0,'127.0.0.1',resolve));
    const crypto = require('node:crypto'), pair = crypto.generateKeyPairSync('x25519');
    const privateKey = pair.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('base64url');
    const publicKey = pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url');
    const realityTarget = tls.createServer({cert,key,minVersion:'TLSv1.3',allowHalfOpen:true},socket=>socket.pipe(socket));
    await new Promise(resolve=>realityTarget.listen(0,'127.0.0.1',resolve));
    const realityServer = api.createRuntime({inbounds:[{protocol:'vless',users:[{id,flow}],networks:[{port:0,option:{reality:{privateKey,serverNames:['js2ray.test'],shortIds:['abcd'],dest:'127.0.0.1:'+cover.address().port,maxTimeDiff:60000}}}]}]});
    await realityServer.start();
    const realityClient = api.createRuntime({outbounds:[{protocol:'vless',users:[{id,flow,encryption:'none'}],networks:[{address:'127.0.0.1',port:realityServer.listenersInfo[0].address.port,option:{reality:{publicKey,serverName:'js2ray.test',shortId:'abcd',fingerprint:'chrome120'}}}]}]});
    await realityClient.start();
    const realityTunnel = await realityClient.dial({host:'127.0.0.1',port:realityTarget.address().port});
    const realityInner = tls.connect({socket:realityTunnel,ca:cert,servername:'js2ray.test',minVersion:'TLSv1.3'});
    realityInner.on('error',()=>{}); await once(realityInner,'secureConnect');
    realityInner.write('packed-reality-vision');
    const realityReply = []; let realityTotal = 0;
    for await(const chunk of realityInner){realityReply.push(chunk);realityTotal+=chunk.length;if(realityTotal>=21)break;}
    assert.equal(Buffer.concat(realityReply).toString(),'packed-reality-vision');
    for(const instance of [realityClient,realityServer]){
      assert.equal(instance.metrics.visionReadSwitches,1);assert.equal(instance.metrics.visionWriteSwitches,1);
    }
    realityInner.destroy(); realityTunnel.destroy();
    await realityClient.close(); await realityServer.close();
    for(const socket of coverSockets)socket.destroy();
    await Promise.all([new Promise(resolve=>cover.close(resolve)),new Promise(resolve=>realityTarget.close(resolve))]);
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
