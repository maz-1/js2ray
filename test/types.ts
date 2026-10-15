import api, { createRuntime, DatagramMessage, checkConfig } from '..';
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
}
void example;
