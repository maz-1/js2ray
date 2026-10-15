'use strict';
const dgram = require('node:dgram');
const net = require('node:net');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { listen } = require('../helpers');
const { iptoBuffer } = require('../../core/utils');
const { name, ecs } = require('../../dns/wire');
const cert = fs.readFileSync(path.join(__dirname, 'tls/cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'tls/key.pem'));
function answer(
  request,
  addresses = ['127.0.0.1', '::1'],
  { truncate = false, ttl = 60, rcode = 0 } = {},
) {
  const question = name(request, 12),
    type = request.readUInt16BE(question.end);
  const selected = addresses.filter((address) => net.isIP(address) === (type === 1 ? 4 : 6));
  const header = Buffer.from(request.subarray(0, 12));
  header.writeUInt16BE((truncate ? 0x8380 : 0x8180) | rcode, 2);
  header.writeUInt16BE(truncate || rcode ? 0 : selected.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([
    header,
    request.subarray(12, question.end + 4),
    ...(truncate || rcode
      ? []
      : selected.map((address) => {
          const payload = iptoBuffer(address),
            entry = Buffer.alloc(12);
          entry.writeUInt16BE(0xc00c);
          entry.writeUInt16BE(type, 2);
          entry.writeUInt16BE(1, 4);
          entry.writeUInt32BE(ttl, 6);
          entry.writeUInt16BE(payload.length, 10);
          return Buffer.concat([entry, payload]);
        })),
  ]);
}
async function dnsServer(t, options = {}) {
  const calls = [],
    sockets = new Set();
  const respond = (request, transport) => {
    calls.push({
      host: name(request, 12).value,
      type: request.readUInt16BE(name(request, 12).end),
      transport,
      ecs: ecs(request),
    });
    if (options.silent) return undefined;
    return answer(request, options.addresses, {
      truncate: options.truncate && transport === 'udp',
      ttl: options.ttl,
      rcode: options.rcode,
    });
  };
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2 || buffer.length < 2 + buffer.readUInt16BE()) return;
      const result = respond(buffer.subarray(2, 2 + buffer.readUInt16BE()), 'tcp');
      if (result) {
        const size = Buffer.alloc(2);
        size.writeUInt16BE(result.length);
        socket.end(Buffer.concat([size, result]));
      }
    });
  });
  const port = await require('../interop/helpers').freePort(true);
  tcp.listen(port, '127.0.0.1');
  await once(tcp, 'listening');
  const udp = dgram.createSocket('udp4');
  udp.bind(port, '127.0.0.1');
  await once(udp, 'listening');
  udp.on('message', (request, remote) => {
    const result = respond(request, 'udp');
    if (result) udp.send(result, remote.port, remote.address);
  });
  const doh = https.createServer({ cert, key }, (req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      const result = respond(Buffer.concat(parts), 'https');
      if (result) {
        res.setHeader('Content-Type', 'application/dns-message');
        res.end(result);
      }
    });
  });
  const dohPort = await listen(doh);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    doh.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => tcp.close(resolve)),
      new Promise((resolve) => udp.close(resolve)),
      new Promise((resolve) => doh.close(resolve)),
    ]);
  });
  return { port, dohPort, calls, cert: cert.toString(), address: '127.0.0.1' };
}
module.exports = { dnsServer, answer };
