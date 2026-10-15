'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('..');
const fixture = require('./fixtures/reality');
const { controlled } = require('./fixtures/reality-flight');
const { inspectCover } = require('../transports/reality');
const { flow, transfer, tlsEcho } = require('./fixtures/vision');
const handshake = require('../transports/reality/handshake');
const keys = require('../transports/reality/crypto');
const { listen } = require('./helpers');
const { write } = require('../runtime/streams');
for (const layout of ['single', 'four'])
  for (const suite of [0x1301, 0x1302, 0x1303])
    test(`REALITY cover ${layout} layout suite ${suite.toString(16)} mirrors and supports Vision Direct`, async (t) => {
      const cover = await controlled(t, { layout, suite }),
        target = await tlsEcho(t, 'TLSv1.3');
      const settings = { ...fixture.server, dest: `127.0.0.1:${cover.port}` };
      const report = await inspectCover(settings);
      assert.equal(report[0].layout, layout);
      assert.equal(report[0].suite, keys.suites[suite].algorithm);
      assert.equal(report[0].recordLengths.length, layout === 'single' ? 1 : 4);
      const server = createRuntime({ inbounds: [fixture.bound(0, cover, flow)] });
      await server.start();
      t.after(() => server.close());
      const client = createRuntime({
        outbounds: [fixture.bound(server.listenersInfo[0].address.port, undefined, flow)],
      });
      await client.start();
      t.after(() => client.close());
      await transfer(client, target, 'TLSv1.3');
      for (const runtime of [client, server]) {
        assert.equal(runtime.metrics.visionReadSwitches, 1);
        assert.equal(runtime.metrics.visionWriteSwitches, 1);
      }
    });
for (const fault of ['hrr', 'ccs', 'space', 'disconnect'])
  test(`REALITY cover ${fault} is rejected by preflight and Runtime without business disclosure`, async (t) => {
    const cover = await controlled(t, { fault, layout: fault === 'space' ? 'four' : 'single' }),
      settings = { ...fixture.server, dest: `127.0.0.1:${cover.port}` };
    await assert.rejects(inspectCover(settings, { handshakeTimeoutMs: 200 }), (error) =>
      ['ERR_TLS', 'ERR_PROTOCOL', 'ERR_TIMEOUT'].includes(error.code),
    );
    const server = createRuntime({
      inbounds: [fixture.bound(0, cover)],
      limits: { handshakeTimeoutMs: 200 },
    });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [fixture.bound(server.listenersInfo[0].address.port)],
      limits: { handshakeTimeoutMs: 300 },
    });
    await client.start();
    t.after(() => client.close());
    await assert.rejects(client.dial({ host: 'must-not-resolve.test', port: 80 }));
    assert.equal(server.metrics.inbound.succeeded, 0);
    assert.equal(server.metrics.inbound.failed, 1);
  });
test('REALITY mirrors exactly the selected cover record lengths in both layouts', async (t) => {
  for (const layout of ['single', 'four']) {
    const cover = await controlled(t, { layout }),
      sockets = new Set();
    let resolve, reject;
    const checked = new Promise((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const server = require('node:net').createServer({ allowHalfOpen: true }, async (raw) => {
      sockets.add(raw);
      raw.on('error', () => {});
      let target, result;
      try {
        target = await fixture.tcp(cover.port);
        sockets.add(target);
        result = await handshake.server(raw, fixture.server, target);
        resolve(result.mirroredLengths);
      } catch (error) {
        reject(error);
      } finally {
        result?.tx?.destroy();
        result?.rx?.destroy();
        target?.destroy();
      }
    });
    const port = await listen(server);
    t.after(() => {
      for (const raw of sockets) raw.destroy();
      return new Promise((done) => server.close(done));
    });
    const raw = await fixture.tcp(port);
    sockets.add(raw);
    const result = await handshake.client(raw, { ...fixture.client, fingerprint: 'chrome120' });
    assert.deepEqual((await checked).slice(2), cover.evidence.recordLengths);
    result.tx.destroy();
    result.rx.destroy();
    raw.destroy();
  }
});
test('REALITY check-cover CLI creates no inbound listener and prints no destinations or credentials', async (t) => {
  const cover = await fixture.cover(t),
    fs = require('node:fs'),
    path = require('node:path');
  const tempRoot = path.resolve(require('node:os').tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'js2ray-cover-')),
    filename = path.join(directory, 'config.json');
  t.after(() => {
    assert.equal(path.dirname(directory), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Bind the configured listener first: preflight must not try to open it.
  const occupied = require('node:net').createServer();
  const port = await listen(occupied);
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  fs.writeFileSync(filename, JSON.stringify({ inbounds: [fixture.bound(port, cover)] }));
  const child = require('node:child_process').spawn(
    process.execPath,
    ['cli/index.js', 'check-cover', filename],
    { windowsHide: true },
  );
  let output = '',
    error = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (error += data));
  assert.equal((await require('node:events').once(child, 'exit'))[0], 0, error);
  assert.equal(JSON.parse(output).covers[0].ok, true);
  for (const value of [fixture.privateKey, fixture.shortId, '127.0.0.1', 'js2ray.test'])
    assert.equal(output.includes(value), false);
});
