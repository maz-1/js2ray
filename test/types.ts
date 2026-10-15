import api, { createRuntime, DatagramMessage, checkConfig } from '..';
import { Agent, fetch } from 'undici';
const runtime = createRuntime({ inbounds: [], outbounds: [{ protocol: 'freedom' }] });
const xhttp = createRuntime({
  outbounds: [
    {
      protocol: 'vless',
      users: [{ id: '5945fc2c-45b7-48cc-a19c-4cd28dbd6237', encryption: 'none' }],
      networks: [
        {
          type: 'xhttp',
          address: '127.0.0.1',
          port: 10080,
          option: {
            mode: 'stream-up',
            httpVersion: '2',
            host: 'synthetic.test',
            xPaddingBytes: '100-200',
            xmux: {
              maxConcurrency: '2-4',
              cMaxReuseTimes: 8,
              hMaxRequestTimes: '600-900',
              hMaxReusableSecs: 1800,
              hKeepAlivePeriod: -1,
            },
          },
        },
      ],
    },
  ],
});
void xhttp;
import { RealityClientOptions, RealityServerOptions } from '..';
const reality: RealityClientOptions = {
  publicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
  serverName: 'synthetic.test',
  shortId: 'abcd',
  fingerprint: 'chrome120',
};
const realityServer: RealityServerOptions = {
  privateKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  shortIds: ['abcd'],
  serverNames: ['synthetic.test'],
  dest: 'cover.test:443',
  maxTimeDiff: 60000,
  xver: 0,
};
void createRuntime({
  outbounds: [
    {
      protocol: 'vless',
      users: [{ id: '5945fc2c-45b7-48cc-a19c-4cd28dbd6237', flow: 'xtls-rprx-vision' }],
      networks: [{ port: 443, option: { reality } }],
    },
  ],
});
void realityServer;
async function example() {
  await runtime.start();
  const stream = await runtime.dial({ host: 'example.test', port: 443 });
  stream.setNoDelay().setTimeout(1000).end('test');
  const session = await runtime.openDatagram({ host: '127.0.0.1', port: 53, network: 'udp' });
  for await (const message of session) {
    const datagram: DatagramMessage = message;
    await session.send(datagram.data);
    break;
  }
  await runtime.close();
  checkConfig({ outbounds: [] });
  api.config({}).stop();
  const connector = api.createUndiciConnector(runtime);
  const pool = new Agent({ connect: connector });
  const dispatcher = api.createUndiciDispatcher(runtime, { undici: { Agent }, connections: 2 });
  await fetch('http://example.test', { dispatcher });
  await pool.close();
  await dispatcher.close();
  api.createHttpAgent(runtime).destroy();
  api.createHttpsAgent(runtime, { targetTls: { ca: 'PEM' } }).destroy();
}
void example;

import { createRuntimeManager, createWebSocket } from '../index.js';
async function managed() {
  const manager = createRuntimeManager();
  await manager.start();
  api.createHttpAgent(manager);
  const websocket = createWebSocket(manager, 'wss://example.test');
  websocket.send('text');
  const result = await manager.rotate(
    { routing: { domainStrategy: 'IPOnDemand' } },
    {
      ready: async (candidate, signal) => {
        await candidate.resolve('localhost', { signal });
      },
    },
  );
  await result.drained;
  manager.metrics[0]?.metrics.mux.businessSessions;
  await manager.close();
}
void managed;
