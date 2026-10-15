'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const certFile = path.resolve(__dirname, '../fixtures/tls/cert.pem');
const keyFile = path.resolve(__dirname, '../fixtures/tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const { once } = require('node:events');
const { createRuntime } = require('../..');
const { runCore, freePort } = require('./helpers');
const { id, portalConfig, bridgeConfig, waitFor } = require('../fixtures/reverse');

async function echo(t) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, peer) => socket.send(data, peer.port, peer.address));
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  return { host: '127.0.0.1', port: socket.address().port };
}
for (const kind of ['v2ray', 'xray']) {
  for (const role of ['bridge', 'portal']) {
    test(`${kind}: js2ray ${role} reverse UDP cross-core business`, async (t) => {
      const target = await echo(t);
      let runtime, client;
      if (role === 'bridge') {
        const entry = await freePort(),
          business = await freePort(true);
        const config = portalConfig(entry);
        config.inbounds.push({
          tag: 'business',
          listen: '127.0.0.1',
          port: business,
          protocol: 'socks',
          settings: { auth: 'noauth', udp: true },
        });
        config.routing.rules.push({
          type: 'field',
          inboundTag: ['business'],
          outboundTag: 'portal',
        });
        await runCore(t, kind, config, entry);
        runtime = createRuntime(bridgeConfig(entry, target));
        client = createRuntime({
          outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port: business }] }],
        });
        await Promise.all([runtime.start(), client.start()]);
        await waitFor(() => runtime.stats.reverse[0].active > 0);
      } else {
        runtime = createRuntime(portalConfig(0));
        await runtime.start();
        await runCore(t, kind, bridgeConfig(runtime.listenersInfo[0].address.port, target));
        client = runtime;
        await waitFor(() => runtime.stats.reverse[0].active > 0);
      }
      t.after(() => Promise.all([runtime.close(), client.close()]));
      const session = await client.openDatagram({
        host: 'service.test',
        port: 80,
        ...(role === 'portal' ? { outboundTag: 'portal' } : {}),
      });
      for (const data of [Buffer.from('reverse UDP'), Buffer.alloc(1024, 0xab)]) {
        await session.send(data);
        assert.deepEqual((await session.next()).value.data, data);
      }
      session.destroy();
    });
  }
  for (const mode of [
    'socks',
    'vmess-none',
    'vmess-aes-128-gcm',
    'vmess-chacha20-poly1305',
    'mux',
    'mux-wss',
    ...(kind === 'xray' ? ['xudp', 'xudp-wss'] : []),
  ]) {
    const protocol = mode.startsWith('vmess') ? 'vmess' : mode === 'socks' ? 'socks' : 'vless';
    const security = mode.slice(6);
    const secure = mode.endsWith('-wss');
    const native = (port, server) => ({
      address: '127.0.0.1',
      port,
      ...(secure
        ? {
            type: 'ws',
            option: {
              path: '/udp',
              tls: server ? { certFile, keyFile } : { ca: cert, serverName: 'js2ray.test' },
            },
          }
        : {}),
    });
    const reference = (server) =>
      secure
        ? {
            streamSettings: {
              network: 'ws',
              security: 'tls',
              wsSettings: { path: '/udp' },
              tlsSettings: server
                ? { certificates: [{ certificateFile: certFile, keyFile }] }
                : {
                    serverName: 'js2ray.test',
                    disableSystemRoot: true,
                    certificates: [{ usage: 'verify', certificateFile: certFile }],
                  },
            },
          }
        : {};
    const users =
      protocol === 'socks'
        ? [{ user: 'synthetic', pass: 'test-password' }]
        : [{ id, ...(protocol === 'vmess' ? { security } : { encryption: 'none' }) }];
    for (const direction of ['client', 'server']) {
      test(`${kind}: js2ray ${direction} ${mode} datagrams preserve packet boundaries`, async (t) => {
        const target = await echo(t);
        let runtime;
        if (direction === 'client') {
          const port = await freePort(true);
          await runCore(
            t,
            kind,
            {
              log: { loglevel: 'warning' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port,
                  protocol,
                  ...reference(true),
                  settings:
                    protocol === 'socks'
                      ? { auth: 'password', accounts: users, udp: true }
                      : {
                          clients: [{ id }],
                          ...(protocol === 'vless' ? { decryption: 'none' } : {}),
                        },
                },
              ],
              outbounds: [{ protocol: 'freedom' }],
            },
            port,
          );
          runtime = createRuntime({
            outbounds: [
              {
                protocol,
                users,
                networks: [native(port, false)],
                ...(mode.startsWith('mux') ? { mux: { enabled: true } } : {}),
                ...(mode.startsWith('xudp') ? { packetEncoding: 'xudp' } : {}),
              },
            ],
          });
        } else {
          const server = createRuntime({
            inbounds: [
              {
                protocol,
                users: protocol === 'socks' ? users : [{ id }],
                ...(protocol === 'socks' ? { udp: true } : {}),
                networks: [native(0, true)],
              },
            ],
          });
          await server.start();
          t.after(() => server.close());
          const nodePort = server.listenersInfo[0].address.port;
          const port = await freePort(true);
          await runCore(
            t,
            kind,
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
                  protocol,
                  ...reference(false),
                  settings: {
                    [protocol === 'socks' ? 'servers' : 'vnext']: [
                      { address: '127.0.0.1', port: nodePort, users },
                    ],
                  },
                  ...(mode.startsWith('mux')
                    ? { mux: { enabled: true, concurrency: 8 } }
                    : { mux: { enabled: false } }),
                },
              ],
            },
            port,
            { cone: mode.startsWith('xudp') },
          );
          runtime = createRuntime({
            outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
          });
        }
        await runtime.start();
        t.after(() => runtime.close());
        const session = await runtime.openDatagram(target);
        for (const data of [
          Buffer.from([0, 255, 1]),
          Buffer.alloc(kind === 'v2ray' ? 1024 : 1400, 42),
          Buffer.from('last packet'),
        ]) {
          await session.send(data);
          assert.deepEqual((await session.next()).value.data, data);
        }
        session.close();
      });
    }
  }
}
