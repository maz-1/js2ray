'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
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
    const received = [],
      socket = dgram.createSocket('udp4');
    socket.on('message', (data, peer) => {
      received.push(data.length);
      socket.send(data, peer.port, peer.address);
    });
    socket.bind(0, '127.0.0.1');
    await once(socket, 'listening');
    t.after(() => new Promise((resolve) => socket.close(resolve)));
    const target = { host: '127.0.0.1', port: socket.address().port };
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
      // Establish the response header and Mux session before provoking a peer
      // rejection; an oversized first packet may close before any response.
      await session.send(Buffer.from('established'));
      assert.equal((await session.next()).value.data.toString(), 'established');
      // The pinned core treats oversized Mux packet reads as a carrier failure.
      // Its response-writer goroutine may send error END before carrier EOF;
      // neither ordering is guaranteed across platforms (server.go run/handle).
      const refusal = (error) => ['ERR_MUX_SESSION', 'ERR_TRANSPORT'].includes(error.code);
      const rejected = assert.rejects(session.next(), refusal);
      await session.send(Buffer.alloc(8193)).catch((error) => assert.ok(refusal(error)));
      await rejected;
      assert.equal(session.destroyed, true);
      assert.equal(received.includes(8193), false, 'oversized packet reached the UDP target');
      session.destroy();
      await datagrams(runtime, target, 1400);
      await require('../fixtures/reverse').waitFor(() => runtime.metrics.mux.sessions === 0);
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
