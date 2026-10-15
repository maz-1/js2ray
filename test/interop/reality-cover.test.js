'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../..');
const { runCore, freePort } = require('./helpers');
const fixture = require('../fixtures/reality');
const { id, flow, certFile, keyFile, cert, tlsEcho, transfer } = require('../fixtures/vision');
const { inspectCover } = require('../../transports/reality');
for (const role of ['client', 'server'])
  test(`REALITY js2ray ${role} / Xray 25.3.6 with independent pinned Go TLS cover and Vision`, async (t) => {
    const coverPort = await freePort();
    await runCore(
      t,
      'xray',
      {
        inbounds: [
          {
            listen: '127.0.0.1',
            port: coverPort,
            protocol: 'vless',
            settings: { decryption: 'none', clients: [{ id }] },
            streamSettings: {
              network: 'tcp',
              security: 'tls',
              tlsSettings: {
                minVersion: '1.3',
                maxVersion: '1.3',
                certificates: [{ certificateFile: certFile, keyFile }],
              },
            },
          },
        ],
        outbounds: [{ protocol: 'freedom' }],
      },
      coverPort,
      { profile: 'xray-xhttp' },
    );
    const cover = { port: coverPort },
      target = await tlsEcho(t, 'TLSv1.3');
    const report = await inspectCover({ ...fixture.server, dest: `127.0.0.1:${coverPort}` });
    assert.equal(report[0].layout, 'four');
    let runtime, measured;
    const port = await freePort();
    if (role === 'client') {
      await runCore(
        t,
        'xray',
        {
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vless',
              settings: { decryption: 'none', clients: [{ id, flow }] },
              streamSettings: {
                network: 'tcp',
                security: 'reality',
                realitySettings: { ...fixture.server, dest: `127.0.0.1:${coverPort}`, xver: 0 },
              },
            },
          ],
          outbounds: [{ protocol: 'freedom' }],
        },
        port,
        { profile: 'xray-xhttp' },
      );
      runtime = createRuntime({ outbounds: [fixture.bound(port, undefined, flow)] });
      measured = runtime;
    } else {
      measured = createRuntime({ inbounds: [fixture.bound(0, cover, flow)] });
      await measured.start();
      t.after(() => measured.close());
      await runCore(
        t,
        'xray',
        {
          inbounds: [
            { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
          ],
          outbounds: [
            {
              protocol: 'vless',
              settings: {
                vnext: [
                  {
                    address: '127.0.0.1',
                    port: measured.listenersInfo[0].address.port,
                    users: [{ id, flow, encryption: 'none' }],
                  },
                ],
              },
              streamSettings: {
                network: 'tcp',
                security: 'reality',
                realitySettings: { ...fixture.client, fingerprint: 'chrome' },
              },
            },
          ],
        },
        port,
        { profile: 'xray-xhttp' },
      );
      runtime = createRuntime({
        outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
      });
    }
    await runtime.start();
    t.after(() => runtime.close());
    await transfer(runtime, target, 'TLSv1.3');
    assert.equal(measured.metrics.visionReadSwitches, 1);
    assert.equal(measured.metrics.visionWriteSwitches, 1);
    assert.ok(cert.includes('CERTIFICATE'));
  });
