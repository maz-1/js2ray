'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../..');
const { echo } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const {
  id,
  flow,
  certFile,
  keyFile,
  bound,
  tlsEcho,
  transfer,
  udpEcho,
  datagrams,
} = require('../fixtures/vision');
function transport(server) {
  return {
    network: 'tcp',
    security: 'tls',
    tlsSettings: {
      minVersion: '1.3',
      maxVersion: '1.3',
      ...(server
        ? { certificates: [{ certificateFile: certFile, keyFile }] }
        : {
            serverName: 'js2ray.test',
            disableSystemRoot: true,
            certificates: [{ usage: 'verify', certificateFile: certFile }],
          }),
    },
  };
}
for (const direction of ['client', 'server']) {
  test(`Vision ${direction}: Xray 25.3.6 XUDP boundaries over the padded TLS stream`, async (t) => {
    const target = await udpEcho(t);
    let runtime;
    const port = await freePort(direction === 'server');
    if (direction === 'client') {
      await runCore(
        t,
        'xray',
        {
          log: { loglevel: 'debug' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vless',
              settings: { clients: [{ id, flow }], decryption: 'none' },
              streamSettings: transport(true),
            },
          ],
          outbounds: [{ protocol: 'freedom' }],
        },
        port,
        { profile: 'xray-xhttp' },
      );
      runtime = createRuntime({ outbounds: [bound(port)] });
    } else {
      const server = createRuntime({ inbounds: [bound(0, true)] });
      await server.start();
      t.after(() => server.close());
      await runCore(
        t,
        'xray',
        {
          log: { loglevel: 'debug' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'socks',
              settings: { auth: 'noauth', udp: true },
            },
          ],
          outbounds: [
            {
              protocol: 'vless',
              settings: {
                vnext: [
                  {
                    address: '127.0.0.1',
                    port: server.listenersInfo[0].address.port,
                    users: [{ id, encryption: 'none', flow }],
                  },
                ],
              },
              streamSettings: transport(false),
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
    await datagrams(runtime, target, 1400);
    if (direction === 'client') {
      const session = await runtime.openDatagram(target);
      const rejected = assert.rejects(session.next(), { code: 'ERR_MUX_SESSION' });
      await session.send(Buffer.alloc(8193));
      await rejected;
      session.destroy();
    }
  });
}
for (const version of [undefined, 'TLSv1.2', 'TLSv1.3']) {
  test(`Vision js2ray -> Xray 25.3.6 ${version ?? 'ordinary TCP'} including Direct proof`, async (t) => {
    const target = version ? await tlsEcho(t, version) : await echo(t);
    const port = await freePort();
    await runCore(
      t,
      'xray',
      {
        inbounds: [
          {
            listen: '127.0.0.1',
            port,
            protocol: 'vless',
            settings: { clients: [{ id, flow }], decryption: 'none' },
            streamSettings: transport(true),
          },
        ],
        outbounds: [{ protocol: 'freedom' }],
      },
      port,
      { profile: 'xray-xhttp' },
    );
    const client = createRuntime({ outbounds: [bound(port)] });
    await client.start();
    t.after(() => client.close());
    await transfer(client, target, version);
    assert.equal(client.metrics.visionReadSwitches, version === 'TLSv1.3' ? 1 : 0);
    assert.equal(client.metrics.visionWriteSwitches, version === 'TLSv1.3' ? 1 : 0);
  });
  test(`Vision Xray 25.3.6 -> js2ray ${version ?? 'ordinary TCP'} including Direct proof`, async (t) => {
    const target = version ? await tlsEcho(t, version) : await echo(t);
    const server = createRuntime({ inbounds: [bound(0, true)] });
    await server.start();
    t.after(() => server.close());
    const port = await freePort();
    await runCore(
      t,
      'xray',
      {
        inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } }],
        outbounds: [
          {
            protocol: 'vless',
            settings: {
              vnext: [
                {
                  address: '127.0.0.1',
                  port: server.listenersInfo[0].address.port,
                  users: [{ id, encryption: 'none', flow }],
                },
              ],
            },
            streamSettings: transport(false),
          },
        ],
      },
      port,
      { profile: 'xray-xhttp' },
    );
    const client = createRuntime({
      outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    });
    await client.start();
    t.after(() => client.close());
    await transfer(client, target, version);
    assert.equal(server.metrics.visionReadSwitches, version === 'TLSv1.3' ? 1 : 0);
    assert.equal(server.metrics.visionWriteSwitches, version === 'TLSv1.3' ? 1 : 0);
  });
}
