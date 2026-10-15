'use strict';
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
async function echo(t, host = '127.0.0.1') {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const port = await listen(server, host);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port, host };
}
async function httpServer(t) {
  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    res.end('hello through runtime');
  });
  const port = await listen(server);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { server, port };
}
async function readBytes(stream, count) {
  const { StreamReader } = require('../runtime/reader');
  return new StreamReader(stream, { maxBytes: count }).read(count);
}
function largeDatagramSize() {
  if (process.platform !== 'darwin') return 60000;
  const limit = Number(
    require('node:child_process')
      .execFileSync('/usr/sbin/sysctl', ['-n', 'net.inet.udp.maxdgram'], { encoding: 'utf8' })
      .trim(),
  );
  if (!Number.isSafeInteger(limit) || limit < 512 || limit > 65535)
    throw Error('Unexpected kernel UDP payload limit.');
  // Reserve room for SOCKS address headers; do not modify a machine-wide sysctl.
  return Math.min(60000, limit - 64);
}
module.exports = { listen, echo, httpServer, readBytes, largeDatagramSize };
