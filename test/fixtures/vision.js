'use strict';
const tls = require('node:tls');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { listen, readBytes } = require('../helpers');
const { write } = require('../../runtime/streams');
const id = '5945fc2c-45b7-48cc-a19c-4cd28dbd6237';
const flow = 'xtls-rprx-vision';
const certFile = path.resolve(__dirname, 'tls/cert.pem');
const keyFile = path.resolve(__dirname, 'tls/key.pem');
const cert = fs.readFileSync(certFile, 'utf8');
const key = fs.readFileSync(keyFile, 'utf8');
function network(port, server = false) {
  return {
    type: 'tcp',
    address: '127.0.0.1',
    port,
    option: { tls: server ? { cert, key } : { ca: cert, serverName: 'js2ray.test' } },
  };
}
function bound(port, server = false, userId = id) {
  return {
    protocol: 'vless',
    tag: 'vision',
    users: [{ id: userId, flow, encryption: 'none' }],
    networks: [network(port, server)],
  };
}
async function tlsEcho(t, version) {
  const sockets = new Set();
  const server = tls.createServer(
    { cert, key, minVersion: version, maxVersion: version, allowHalfOpen: true },
    (socket) => {
      socket.on('error', () => {});
      socket.pipe(socket);
    },
  );
  server.on('tlsClientError', () => {});
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return { host: '127.0.0.1', port };
}
async function transfer(runtime, destination, version) {
  const tunnel = await runtime.dial(destination);
  let stream = tunnel;
  if (version) {
    stream = tls.connect({
      socket: tunnel,
      ca: cert,
      servername: 'js2ray.test',
      minVersion: version,
      maxVersion: version,
      allowHalfOpen: true,
    });
    stream.on('error', () => {});
    await once(stream, 'secureConnect');
  }
  try {
    for (const size of [17, 65539, 524307]) {
      const body = randomBytes(size);
      const reply = readBytes(stream, size);
      for (let offset = 0; offset < size; offset += 8191)
        await write(stream, body.subarray(offset, offset + 8191));
      assert.deepEqual(await reply, body);
    }
  } finally {
    stream.destroy();
    tunnel.destroy();
  }
}
async function udpEcho(t) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, peer) => socket.send(data, peer.port, peer.address));
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  return { host: '127.0.0.1', port: socket.address().port };
}
async function datagrams(runtime, target, maxSize = 8193) {
  const session = await runtime.openDatagram(target);
  try {
    // Xray's XUDP writer discards empty datagrams; retain its documented scope.
    for (const data of [Buffer.from([0, 255, 1]), randomBytes(maxSize)]) {
      await session.send(data);
      assert.deepEqual((await session.next()).value.data, data);
    }
  } finally {
    session.destroy();
  }
}
module.exports = {
  id,
  flow,
  certFile,
  keyFile,
  cert,
  key,
  network,
  bound,
  tlsEcho,
  transfer,
  udpEcho,
  datagrams,
};
