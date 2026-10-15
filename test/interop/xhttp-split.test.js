'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createRuntime } = require('../..');
const { echo, readBytes } = require('../helpers');
const { proxy, certFile } = require('../fixtures/xhttp-proxy');
const { runCore, freePort } = require('./helpers');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const xmux = { maxConcurrency: 4, hMaxRequestTimes: 8, hMaxReusableSecs: 1, hKeepAlivePeriod: -1 };
async function fronts(t, port, upVersion, downVersion, deployment) {
  if (deployment === 'caddy') {
    const value = await require('../fixtures/caddy').caddy(t, { port }, { upVersion, downVersion });
    value.up.network.option.httpVersion = upVersion;
    value.down.network.option.httpVersion = downVersion;
    value.up.network.option.xmux = xmux;
    value.down.network.option.xmux = { maxConcurrency: 4, hKeepAlivePeriod: -1 };
    return value;
  }
  const up = await proxy(t, {
    target: { port },
    version: upVersion,
    prefix: '/up/',
    method: 'POST',
    host: 'up.test',
  });
  const down = await proxy(t, {
    target: { port },
    version: downVersion,
    prefix: '/down/',
    method: 'GET',
    host: 'down.test',
  });
  up.network.option.xmux = xmux;
  down.network.option.xmux = { maxConcurrency: 4, hKeepAlivePeriod: -1 };
  return { up, down };
}
function reference(network) {
  return {
    address: network.address,
    port: network.port,
    network: 'xhttp',
    security: 'tls',
    tlsSettings: {
      serverName: 'js2ray.test',
      alpn: [network.option.httpVersion === '2' ? 'h2' : 'http/1.1'],
      disableSystemRoot: true,
      certificates: [{ usage: 'verify', certificateFile: certFile }],
    },
    xhttpSettings: {
      path: network.option.path,
      host: network.option.host,
      mode: network.option.mode ?? 'auto',
      extra: { xmux: network.option.xmux, scMaxEachPostBytes: 16384 },
    },
  };
}
async function exercise(client, target, up, down) {
  const streams = await Promise.all([client.dial(target), client.dial(target)]);
  async function transfer(stream) {
    const data = randomBytes(98321),
      reading = readBytes(stream, data.length);
    for (let n = 0; n < data.length; n += 8192)
      await new Promise((resolve, reject) =>
        stream.write(data.subarray(n, n + 8192), (e) => (e ? reject(e) : resolve())),
      );
    assert.deepEqual(await reading, data);
  }
  try {
    await Promise.all(streams.map(transfer));
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await Promise.all(streams.map(transfer));
    streams[0].destroy();
    await transfer(streams[1]);
    if (up.requests) {
      assert.ok(up.requests.length > 0 && up.requests.every((r) => r.method === 'POST'));
      assert.equal(down.requests.length, 2);
      assert.ok(down.requests.every((r) => r.method === 'GET'));
    }
  } finally {
    streams.forEach((stream) => stream.destroy());
  }
}
for (const deployment of ['node', 'caddy'])
  for (const mode of ['packet-up', 'stream-up'])
    for (const [upVersion, downVersion] of [
      ['1.1', '1.1'],
      ['1.1', '2'],
      ['2', '1.1'],
      ['2', '2'],
    ]) {
      test(
        `XHTTP split ${deployment} js2ray -> Xray 25.3.6 ${mode} TLS HTTP/${upVersion}+${downVersion}`,
        { timeout: 12000 },
        async (t) => {
          const target = await echo(t),
            port = await freePort();
          await runCore(
            t,
            'xray',
            {
              log: { loglevel: process.env.JS2RAY_INTEROP_VERBOSE ? 'debug' : 'warning' },
              inbounds: [
                {
                  listen: '127.0.0.1',
                  port,
                  protocol: 'vless',
                  settings: { clients: [{ id }], decryption: 'none' },
                  streamSettings: {
                    network: 'xhttp',
                    xhttpSettings: { path: '/shared/', mode: 'auto', scMaxEachPostBytes: 16384 },
                  },
                },
              ],
              outbounds: [{ protocol: 'freedom' }],
            },
            port,
            { profile: 'xray-xhttp' },
          );
          const { up, down } = await fronts(t, port, upVersion, downVersion, deployment);
          const network = structuredClone(up.network);
          Object.assign(network.option, {
            mode,
            scMaxEachPostBytes: 16384,
            downloadSettings: down.network,
          });
          const client = createRuntime({
            outbounds: [
              { protocol: 'vless', users: [{ id, encryption: 'none' }], networks: [network] },
            ],
          });
          await client.start();
          t.after(() => client.close());
          await exercise(client, target, up, down);
          assert.equal(client.stats.listeners, 0);
          await client.close();
          assert.equal(client.metrics.xhttp.active, 0);
          assert.equal(client.metrics.xhttp.clients, 0);
        },
      );
      test(
        `XHTTP split ${deployment} Xray 25.3.6 -> js2ray ${mode} TLS HTTP/${upVersion}+${downVersion}`,
        { timeout: 12000 },
        async (t) => {
          const target = await echo(t);
          const server = createRuntime({
            inbounds: [
              {
                protocol: 'vless',
                users: [{ id }],
                networks: [
                  {
                    type: 'xhttp',
                    address: '127.0.0.1',
                    port: 0,
                    option: { path: '/shared/', mode: 'auto', httpVersion: '1.1' },
                  },
                ],
              },
            ],
          });
          await server.start();
          t.after(() => server.close());
          const { up, down } = await fronts(
            t,
            server.listenersInfo[0].address.port,
            upVersion,
            downVersion,
            deployment,
          );
          const transport = reference(up.network);
          delete transport.address;
          delete transport.port;
          transport.xhttpSettings.mode = mode;
          transport.xhttpSettings.extra.downloadSettings = reference(down.network);
          const port = await freePort();
          await runCore(
            t,
            'xray',
            {
              log: { loglevel: process.env.JS2RAY_INTEROP_VERBOSE ? 'debug' : 'warning' },
              inbounds: [
                { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
              ],
              outbounds: [
                {
                  protocol: 'vless',
                  settings: {
                    vnext: [
                      { address: '127.0.0.1', port: up.port, users: [{ id, encryption: 'none' }] },
                    ],
                  },
                  streamSettings: transport,
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
          await exercise(client, target, up, down);
        },
      );
    }
