'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { Duplex } = require('node:stream');
const { StreamReader } = require('../../runtime/reader');
const { write } = require('../../runtime/streams');
const { failure } = require('../../runtime/errors');
const utils = require('../../core/utils');
const { FLOW, VisionStream, padding } = require('./vision');

function encodeRequest(user, target, command = 1) {
  const flow = user.flow?.startsWith(FLOW) ? FLOW : '';
  const addons = flow
    ? Buffer.concat([Buffer.from([10, flow.length]), Buffer.from(flow)])
    : Buffer.alloc(0);
  const header = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(user.id.replaceAll('-', ''), 'hex'),
    Buffer.from([addons.length]),
    addons,
    Buffer.from([command]),
  ]);
  if (command === 3) return header;
  const name = Buffer.from(target.host);
  const family = net.isIP(target.host);
  const address = family
    ? utils.iptoBuffer(target.host)
    : Buffer.concat([Buffer.from([name.length]), name]);
  const prefix = Buffer.alloc(3);
  prefix.writeUInt16BE(target.port, 0);
  prefix[2] = family === 4 ? 1 : family === 6 ? 3 : 2;
  return Buffer.concat([header, prefix, address]);
}

async function readRequest(socket, bound, options) {
  const reader = new StreamReader(socket, options);
  const prefix = await reader.read(18);
  if (prefix[0] !== 0) throw failure('ERR_PROTOCOL', 'Unsupported VLESS version.', 'protocol');
  const authenticated = bound.users.find((user) =>
    crypto.timingSafeEqual(Buffer.from(user.id.replaceAll('-', ''), 'hex'), prefix.subarray(1, 17)),
  );
  if (!authenticated) throw failure('ERR_AUTH', 'VLESS authentication rejected.', 'authentication');
  let flow = '';
  if (prefix[17] !== 0) {
    const addons = await reader.read(prefix[17]);
    if (addons.length < 2 || addons[0] !== 10 || addons[1] !== addons.length - 2)
      throw failure('ERR_PROTOCOL', 'Invalid or unsupported VLESS addons.', 'protocol');
    flow = addons.subarray(2).toString('utf8');
    if (flow !== FLOW) throw failure('ERR_UNSUPPORTED', 'Unsupported VLESS flow.', 'protocol');
  }
  const command = (await reader.read(1))[0];
  if (flow !== (authenticated.flow ?? ''))
    throw failure('ERR_AUTH', 'VLESS flow does not match this user.', 'authentication');
  if (flow && command === 2)
    throw failure('ERR_UNSUPPORTED', 'Vision UDP requires XUDP.', 'protocol');
  if (flow && socket.getProtocol?.() !== 'TLSv1.3')
    throw failure('ERR_TLS', 'Vision requires outer TLS 1.3.', 'tls');
  if (!flow) socket.releaseTLS?.();
  if (command === 3) return { command: 3, host: 'v1.mux.cool', port: 0, flow, user: authenticated };
  const rest = Buffer.concat([Buffer.from([command]), await reader.read(3)]);
  if (![1, 2].includes(rest[0]))
    throw failure(
      'ERR_UNSUPPORTED',
      'VLESS supports TCP and traditional UDP commands in this stage.',
      'protocol',
    );
  const port = rest.readUInt16BE(1);
  let host;
  if (rest[3] === 1 || rest[3] === 3)
    host = utils.iptoString(await reader.read(rest[3] === 1 ? 4 : 16));
  else if (rest[3] === 2) {
    const length = (await reader.read(1))[0];
    if (!length) throw failure('ERR_PROTOCOL', 'VLESS domain cannot be empty.', 'protocol');
    host = (await reader.read(length)).toString('utf8');
  } else throw failure('ERR_PROTOCOL', 'Invalid VLESS address type.', 'protocol');
  return { host, port, command: rest[0], flow, user: authenticated };
}

// A response header may be split anywhere, or arrive together with application bytes.
function responseStream(socket, maxBufferBytes) {
  let prefix = Buffer.alloc(0);
  let headerRead = false;
  const stream = new Duplex({
    allowHalfOpen: true,
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      if (!socket.closed) socket.once('close', () => callback(error));
      else {
        callback(error);
        return;
      }
      socket.destroy();
    },
  });
  stream.on('error', () => {});
  socket.on('data', (chunk) => {
    if (!headerRead) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix[0] !== 0)
        return stream.destroy(
          failure('ERR_PROTOCOL', 'Invalid VLESS response version.', 'protocol'),
        );
      if (prefix.length < 2 || prefix.length < 2 + prefix[1]) return;
      chunk = prefix.subarray(2 + prefix[1]);
      headerRead = true;
      prefix = undefined;
    }
    if (stream.readableLength + chunk.length > maxBufferBytes)
      return stream.destroy(
        failure('ERR_LIMIT', 'VLESS receive queue exceeded its limit.', 'protocol'),
      );
    if (chunk.length && !stream.push(chunk)) socket.pause();
  });
  socket.once('end', () => {
    if (!headerRead)
      stream.destroy(failure('ERR_PROTOCOL', 'Truncated VLESS response header.', 'protocol'));
    else stream.push(null);
  });
  socket.once('error', (cause) =>
    stream.destroy(failure('ERR_TRANSPORT', 'VLESS transport failed.', 'transport', cause)),
  );
  socket.on('timeout', () => stream.emit('timeout'));
  socket.once('close', () => {
    if (!stream.destroyed && !socket.readableEnded)
      stream.destroy(failure('ERR_TRANSPORT', 'VLESS transport closed.', 'transport'));
  });
  stream.setTimeout = (milliseconds, callback) => {
    if (callback) stream.once('timeout', callback);
    socket.setTimeout(milliseconds);
    return stream;
  };
  for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    stream[method] = (...args) => {
      socket[method]?.(...args);
      return stream;
    };
  return stream;
}

async function client(socket, bound, target, options, command = 1) {
  const user = bound.users[0];
  if (!user.flow) socket.releaseTLS?.();
  const uuid = Buffer.from(user.id.replaceAll('-', ''), 'hex');
  const vision = user.flow?.startsWith(FLOW);
  await write(
    socket,
    Buffer.concat([
      encodeRequest(user, target, command),
      vision ? padding(uuid, Buffer.alloc(0), 0, true) : Buffer.alloc(0),
    ]),
  );
  if (vision)
    return new VisionStream(socket, uuid, {
      ...options,
      responseHeader: true,
      initialPaddingWritten: true,
    });
  return responseStream(socket, options.maxBufferBytes);
}

function visionResponse(user) {
  return Buffer.concat([
    Buffer.from([0, 0]),
    padding(Buffer.from(user.id.replaceAll('-', ''), 'hex'), Buffer.alloc(0), 0, true),
  ]);
}
module.exports = {
  encodeRequest,
  readRequest,
  responseStream,
  client,
  VisionStream,
  visionResponse,
};
