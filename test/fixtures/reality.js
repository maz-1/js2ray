'use strict';
const crypto = require('node:crypto');
const tls = require('node:tls');
const { once } = require('node:events');
const { cert, key } = require('./vision');
const { listen } = require('../helpers');
const { privateKey: importPrivate } = require('../../transports/reality/crypto');
const privateBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const privateKey = privateBytes.toString('base64url');
const publicKey = crypto
  .createPublicKey(importPrivate(privateBytes))
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64url');
const shortId = '0123456789abcdef';
const client = { publicKey, shortId, serverName: 'js2ray.test' };
const server = {
  privateKey,
  shortIds: [shortId],
  serverNames: ['js2ray.test'],
  maxTimeDiff: 60000,
};
async function cover(t, host = '127.0.0.1') {
  const sockets = new Set();
  const server = tls.createServer(
    { cert, key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ecdhCurve: 'X25519' },
    (socket) => socket.pipe(socket),
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  const port = await listen(server, host);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return { host, port };
}
async function tcp(port) {
  const socket = require('node:net').connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}
function bound(port, target, flow = '') {
  return {
    protocol: 'vless',
    tag: 'reality',
    users: [{ id: require('./vision').id, encryption: 'none', flow }],
    networks: [
      {
        type: 'tcp',
        address: '127.0.0.1',
        port,
        option: {
          reality: target ? { ...server, dest: `127.0.0.1:${target.port}` } : { ...client },
        },
      },
    ],
  };
}
module.exports = { privateKey, publicKey, shortId, client, server, cover, tcp, bound };
