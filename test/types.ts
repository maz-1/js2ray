import api, { createRuntime, DatagramMessage, checkConfig } from '..';
import { Agent, fetch } from 'undici';
const runtime = createRuntime({ inbounds: [], outbounds: [{ protocol: 'freedom' }] });
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
