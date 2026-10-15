'use strict';
const dgram = require('node:dgram');
const net = require('node:net');
const { DatagramSession, directDatagram } = require('../../runtime/datagram');
const { failure } = require('../../runtime/errors');
const { client, encodeAddress } = require('./stream');
const { write } = require('../../runtime/streams');
const { iptoString, iptoBuffer } = require('../../core/utils');
const { host: validHost } = require('../../config');
const address = (ip) => ip?.replace(/^::ffff:/, '');
function decodePacket(packet) {
  if (packet.length < 4 || packet[0] || packet[1] || packet[2]) return;
  const type = packet[3];
  let host, end;
  if (type === 1 || type === 4) {
    end = type === 1 ? 8 : 20;
    if (packet.length < end + 2) return;
    host = iptoString(packet.subarray(4, end));
  } else if (type === 3) {
    end = 5 + packet[4];
    if (!packet[4] || packet.length < end + 2) return;
    host = packet.subarray(5, end).toString();
  } else return;
  const port = packet.readUInt16BE(end);
  if (!validHost(host) || !port) return;
  return { host, port, data: packet.subarray(end + 2) };
}
function encodePacket(data, target) {
  return Buffer.concat([Buffer.alloc(3), encodeAddress(target.host, target.port), data]);
}

async function association(control, _target, options) {
  const bindAddress = address(control.localAddress);
  const socket = dgram.createSocket(net.isIP(bindAddress) === 6 ? 'udp6' : 'udp4');
  const local = new DatagramSession({ host: bindAddress, port: 0 }, options.maxBufferBytes);
  local.multiTarget = true;
  let peer,
    pendingBytes = 0;
  const remoteIP = address(control.remoteAddress);
  socket.on('message', (packet, info) => {
    if (address(info.address) !== remoteIP || (peer && peer.port !== info.port)) return;
    const message = decodePacket(packet);
    if (!message) return;
    peer ??= info;
    local.receive(message.data, message);
  });
  socket.on('error', (error) => local.destroy(error));
  socket.once('close', () => local.finish());
  local.dispose = () => {
    control.destroy();
    try {
      socket.close();
    } catch {
      local.finish();
    }
  };
  control.once('close', () => local.destroy());
  control.once('end', () => local.destroy());
  control.setTimeout?.(0);
  control.resume();
  local.send = async (data, destination) => {
    local.validate(data, destination);
    if (!peer) throw failure('ERR_STATE', 'SOCKS UDP peer is not established.', 'protocol');
    const packet = encodePacket(data, destination);
    if (packet.length > 65507)
      throw failure('ERR_TARGET', 'SOCKS UDP packet exceeds 65507 bytes.', 'protocol');
    if (pendingBytes + packet.length > options.maxBufferBytes)
      throw failure('ERR_LIMIT', 'SOCKS UDP send queue exceeded its limit.', 'protocol');
    pendingBytes += packet.length;
    try {
      await new Promise((resolve, reject) =>
        socket.send(packet, peer.port, peer.address, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    } finally {
      pendingBytes -= packet.length;
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeListener('error', failed);
        socket.removeListener('close', closed);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const closed = () =>
        failed(failure('ERR_CANCELLED', 'SOCKS association cancelled.', 'protocol'));
      socket.once('error', failed);
      socket.once('close', closed);
      socket.bind(0, bindAddress, () => {
        cleanup();
        resolve();
      });
    });
    if (control.destroyed)
      throw failure('ERR_CANCELLED', 'SOCKS association cancelled.', 'protocol');
    const endpoint = socket.address();
    await write(
      control,
      Buffer.concat([Buffer.from([5, 0, 0]), encodeAddress(endpoint.address, endpoint.port)]),
    );
    return local;
  } catch (error) {
    local.destroy(error);
    throw error;
  }
}
async function clientDatagram(control, bound, target, options) {
  const endpoint = await client(control, bound, { host: '0.0.0.0', port: 0 }, options, 3);
  if (['0.0.0.0', '::'].includes(endpoint.host)) endpoint.host = address(control.remoteAddress);
  const relay = await directDatagram(endpoint, options);
  const session = new DatagramSession(target, options.maxBufferBytes);
  session.dispose = () => {
    relay.destroy();
    control.destroy();
    session.finish();
  };
  relay.on('message', (packet) => {
    const message = decodePacket(packet);
    if (
      message &&
      message.port === target.port &&
      (!net.isIP(target.host) ||
        (net.isIP(message.host) && iptoBuffer(message.host).equals(iptoBuffer(target.host))))
    )
      session.receive(message.data);
  });
  relay.once('error', (error) => session.destroy(error));
  relay.once('close', () => session.destroy());
  control.once('error', (error) => session.destroy(error));
  control.once('close', () => session.destroy());
  control.once('end', () => session.destroy());
  control.setTimeout?.(0);
  control.resume();
  session.send = async (data, destination) => {
    session.validate(data, destination);
    const packet = encodePacket(data, target);
    await relay.send(packet);
  };
  return session;
}
module.exports = { association, clientDatagram, decodePacket, encodePacket };
