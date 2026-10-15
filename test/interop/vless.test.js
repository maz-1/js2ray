'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { createRuntime } = require('../..');
const { StreamReader } = require('../../runtime/reader');
const { encodeAddress, readAddress } = require('../../protocols/socks/stream');
const { echo, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
function nativeNetwork(type, port, server) {
  const ws = ['ws', 'wss'].includes(type),
    secure = ['tls', 'wss'].includes(type);
  return {
    type: ws ? 'ws' : 'tcp',
    address: '127.0.0.1',
    port,
    option: {
      ...(ws ? { path: '/interop' } : {}),
      ...(secure
        ? { tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' } }
        : {}),
    },
  };
}
function referenceTransport(type, server) {
  const ws = ['ws', 'wss'].includes(type),
    secure = ['tls', 'wss'].includes(type);
  return {
    network: ws ? 'ws' : 'tcp',
    security: secure ? 'tls' : 'none',
    ...(ws ? { wsSettings: { path: '/interop' } } : {}),
    ...(secure
      ? {
          tlsSettings: server
            ? { certificates: [{ certificateFile: certFile, keyFile }] }
            : {
                serverName: 'js2ray.test',
                disableSystemRoot: true,
                certificates: [{ usage: 'verify', certificateFile: certFile }],
              },
        }
      : {}),
  };
}

for (const core of ['xray', 'v2ray']) {
  for (const type of ['tcp', 'tls', 'ws', 'wss']) {
    test(`js2ray VLESS client -> ${core} ${type} server`, { timeout: 10000 }, async (t) => {
      const target = await echo(t);
      const port = await freePort();
      const streamSettings = referenceTransport(type, true);
      await runCore(
        t,
        core,
        {
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vless',
              settings: { clients: [{ id }], decryption: 'none' },
              streamSettings,
            },
          ],
          outbounds: [{ protocol: 'freedom' }],
        },
        port,
      );
      const runtime = createRuntime({
        outbounds: [
          {
            protocol: 'vless',
            users: [{ id, encryption: 'none' }],
            networks: [nativeNetwork(type, port, false)],
          },
        ],
      });
      t.after(() => runtime.close());
      await runtime.start();
      const body = Buffer.from('official-peer\0'.repeat(10000));
      const targets =
        type === 'tcp'
          ? [target, { ...target, host: 'localhost' }, await echo(t, '::1')]
          : [target];
      for (const destination of targets) {
        const stream = await runtime.dial(destination);
        stream.write(body);
        assert.deepEqual(await readBytes(stream, body.length), body);
        stream.destroy();
      }
    });

    test(`${core} VLESS client -> js2ray ${type} server`, { timeout: 10000 }, async (t) => {
      const target = await echo(t);
      const network = nativeNetwork(type, 0, true);
      const server = createRuntime({
        inbounds: [{ protocol: 'vless', users: [{ id }], networks: [network] }],
      });
      await server.start();
      t.after(() => server.close());
      const port = await freePort();
      const streamSettings = referenceTransport(type, false);
      await runCore(
        t,
        core,
        {
          log: { loglevel: 'warning' },
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
                    port: server.listenersInfo[0].address.port,
                    users: [{ id, encryption: 'none' }],
                  },
                ],
              },
              streamSettings,
            },
          ],
        },
        port,
      );
      const client = createRuntime({
        outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
      });
      t.after(() => client.close());
      await client.start();
      const targets =
        type === 'tcp'
          ? [target, { ...target, host: 'localhost' }, await echo(t, '::1')]
          : [target];
      for (const destination of targets) {
        const stream = await client.dial(destination);
        stream.write('official-client');
        assert.equal((await readBytes(stream, 15)).toString(), 'official-client');
        stream.destroy();
      }
    });
  }

  for (const type of ['tcp', 'tls', 'ws', 'wss']) {
    test(`js2ray traditional VLESS UDP over ${type} -> ${core}`, { timeout: 10000 }, async (t) => {
      const udp = dgram.createSocket('udp4');
      udp.on('message', (data, info) => udp.send(data, info.port, info.address));
      udp.bind(0, '127.0.0.1');
      await once(udp, 'listening');
      t.after(() => new Promise((resolve) => udp.close(resolve)));
      const port = await freePort();
      await runCore(
        t,
        core,
        {
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vless',
              settings: { clients: [{ id }], decryption: 'none' },
              streamSettings: referenceTransport(type, true),
            },
          ],
          outbounds: [{ protocol: 'freedom' }],
        },
        port,
      );
      const runtime = createRuntime({
        outbounds: [
          {
            protocol: 'vless',
            users: [{ id, encryption: 'none' }],
            networks: [nativeNetwork(type, port, false)],
          },
        ],
      });
      t.after(() => runtime.close());
      await runtime.start();
      const session = await runtime.openDatagram({ host: '127.0.0.1', port: udp.address().port });
      for (const message of [
        Buffer.from([0, 1, 2, 255]),
        Buffer.alloc(core === 'v2ray' ? 2046 : 4096, 0xaa),
      ]) {
        await session.send(message);
        assert.deepEqual((await session.next()).value.data, message);
      }
    });

    test(
      `${core} traditional VLESS UDP over ${type} -> js2ray server`,
      { timeout: 10000 },
      async (t) => {
        const udpEcho = dgram.createSocket('udp4');
        udpEcho.on('message', (data, info) => udpEcho.send(data, info.port, info.address));
        udpEcho.bind(0, '127.0.0.1');
        await once(udpEcho, 'listening');
        t.after(() => new Promise((resolve) => udpEcho.close(resolve)));
        const server = createRuntime({
          inbounds: [
            { protocol: 'vless', users: [{ id }], networks: [nativeNetwork(type, 0, true)] },
          ],
        });
        server.on('diagnostic', (error) => t.diagnostic(JSON.stringify(error)));
        await server.start();
        t.after(() => server.close());
        const port = await freePort(true);
        await runCore(
          t,
          core,
          {
            log: { loglevel: 'warning' },
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
                      users: [{ id, encryption: 'none' }],
                    },
                  ],
                },
                mux: { enabled: false },
                streamSettings: referenceTransport(type, false),
              },
            ],
          },
          port,
        );
        const control = require('node:net').connect(port, '127.0.0.1');
        control.on('error', () => {});
        t.after(() => control.destroy());
        await once(control, 'connect');
        const reader = new StreamReader(control);
        control.write(Buffer.from([5, 1, 0]));
        assert.deepEqual(await reader.read(2), Buffer.from([5, 0]));
        control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
        const response = await reader.read(4);
        assert.equal(response[1], 0);
        const relay = await readAddress(reader, response[3]);
        const socket = dgram.createSocket('udp4');
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        t.after(() => new Promise((resolve) => socket.close(resolve)));
        for (const data of [Buffer.from([0, 255, 1]), Buffer.alloc(1200, 0xab)]) {
          const received = once(socket, 'message');
          socket.send(
            Buffer.concat([
              Buffer.from([0, 0, 0]),
              encodeAddress('127.0.0.1', udpEcho.address().port),
              data,
            ]),
            relay.port,
            '127.0.0.1',
          );
          const [reply] = await received;
          const size = reply[3] === 1 ? 10 : reply[3] === 4 ? 22 : 7 + reply[4];
          assert.deepEqual(reply.subarray(size), data);
        }
      },
    );
  }
}
