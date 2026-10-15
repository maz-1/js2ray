'use strict';

const net = require('node:net');
const { StreamReader } = require('../../runtime/reader');
const { write } = require('../../runtime/streams');
const { failure } = require('../../runtime/errors');
const utils = require('../../core/utils');

function encodeAddress(host, port) {
  const type = net.isIP(host);
  let address;
  if (type) address = Buffer.concat([Buffer.from([type === 4 ? 1 : 4]), utils.iptoBuffer(host)]);
  else {
    const name = Buffer.from(host);
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const suffix = Buffer.alloc(2);
  suffix.writeUInt16BE(port);
  return Buffer.concat([address, suffix]);
}

async function readAddress(reader, type) {
  let host;
  if (type === 1 || type === 4) host = utils.iptoString(await reader.read(type === 1 ? 4 : 16));
  else if (type === 3) {
    const length = (await reader.read(1))[0];
    if (!length) throw failure('ERR_PROTOCOL', 'Empty SOCKS domain.', 'protocol');
    host = (await reader.read(length)).toString('utf8');
  } else throw failure('ERR_PROTOCOL', 'Unknown SOCKS address type.', 'protocol');
  return { host, port: (await reader.read(2)).readUInt16BE() };
}

async function client(socket, bound, target, options, command = 1) {
  const reader = new StreamReader(socket, options);
  const user = bound.users[0];
  await write(socket, Buffer.from([5, 1, user ? 2 : 0]));
  const method = await reader.read(2);
  if (method[0] !== 5 || method[1] !== (user ? 2 : 0))
    throw failure('ERR_AUTH', 'SOCKS authentication method rejected.', 'authentication');
  if (user) {
    const username = Buffer.from(user.user);
    const password = Buffer.from(user.pass);
    await write(
      socket,
      Buffer.concat([
        Buffer.from([1, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const reply = await reader.read(2);
    if (reply[0] !== 1 || reply[1] !== 0)
      throw failure('ERR_AUTH', 'SOCKS authentication rejected.', 'authentication');
  }
  await write(
    socket,
    Buffer.concat([Buffer.from([5, command, 0]), encodeAddress(target.host, target.port)]),
  );
  const reply = await reader.read(4);
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0)
    throw failure('ERR_PROTOCOL', 'SOCKS connection rejected.', 'protocol');
  const endpoint = await readAddress(reader, reply[3]);
  return command === 3 ? endpoint : socket;
}

async function server(socket, bound, dial, options) {
  const reader = new StreamReader(socket, options);
  const greeting = await reader.read(2);
  if (greeting[0] === 4) {
    if (bound.users.length)
      throw failure(
        'ERR_AUTH',
        'SOCKS4 cannot satisfy configured authentication.',
        'authentication',
      );
    if (greeting[1] !== 1)
      throw failure('ERR_PROTOCOL', 'Only SOCKS4 CONNECT is supported.', 'protocol');
    const dest = await reader.read(6);
    let host = utils.iptoString(dest.subarray(2));
    const terminated = async () => {
      const parts = [];
      for (let i = 0; i < 255; i++) {
        const byte = (await reader.read(1))[0];
        if (!byte) return Buffer.from(parts).toString();
        parts.push(byte);
      }
      throw failure('ERR_LIMIT', 'SOCKS4 string exceeds its limit.', 'protocol');
    };
    await terminated();
    if (dest[2] === 0 && dest[3] === 0 && dest[4] === 0 && dest[5] !== 0) host = await terminated();
    if (options.earlyReply) await write(socket, Buffer.from([0, 90, ...dest]));
    const remote = await dial({ host, port: dest.readUInt16BE() });
    if (!options.earlyReply) await write(socket, Buffer.from([0, 90, ...dest]));
    return remote;
  }
  if (greeting[0] !== 5 || !greeting[1])
    throw failure('ERR_PROTOCOL', 'Invalid SOCKS greeting.', 'protocol');
  const methods = await reader.read(greeting[1]);
  const method = bound.users.length ? 2 : 0;
  await write(socket, Buffer.from([5, methods.includes(method) ? method : 255]));
  if (!methods.includes(method))
    throw failure('ERR_AUTH', 'SOCKS authentication method unavailable.', 'authentication');
  if (method === 2) {
    const head = await reader.read(2);
    if (head[0] !== 1 || !head[1])
      throw failure('ERR_AUTH', 'Invalid SOCKS credentials.', 'authentication');
    const username = (await reader.read(head[1])).toString();
    const password = (await reader.read((await reader.read(1))[0])).toString();
    const accepted = bound.users.some((user) => user.user === username && user.pass === password);
    await write(socket, Buffer.from([1, accepted ? 0 : 1]));
    if (!accepted) throw failure('ERR_AUTH', 'SOCKS credentials rejected.', 'authentication');
  }
  const request = await reader.read(4);
  if (
    request[0] !== 5 ||
    request[2] !== 0 ||
    ![1, 3].includes(request[1]) ||
    (request[1] === 3 && !options.associate)
  ) {
    await write(socket, Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
    throw failure('ERR_UNSUPPORTED', 'Only SOCKS CONNECT is supported in this stage.', 'protocol');
  }
  const target = await readAddress(reader, request[3]);
  if (request[1] === 3) {
    await options.associate(target);
    return;
  }
  if (options.earlyReply) await write(socket, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  let remote;
  try {
    remote = await dial(target);
  } catch (error) {
    if (!options.earlyReply) await write(socket, Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
    throw error;
  }
  if (!options.earlyReply) await write(socket, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  return remote;
}

module.exports = { client, server, encodeAddress, readAddress };
