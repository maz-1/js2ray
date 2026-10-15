'use strict';
const http = require('node:http');
const http2 = require('node:http2');
const { randomUUID } = require('node:crypto');
const { isIPv6 } = require('node:net');
const { failure } = require('../../runtime/errors');
const { settings, padding, transportError, XhttpStream, attachBody } = require('./common');

async function connect(network, limits, dial) {
  const config = settings(network.option, limits);
  const tls = config.tls;
  const alpn =
    config.httpVersion === '1.1'
      ? ['http/1.1']
      : config.httpVersion === '2'
        ? ['h2']
        : ['h2', 'http/1.1'];
  const rawNetwork = {
    ...network,
    type: 'tcp',
    option: { tls: tls ? { ...tls, alpn } : undefined },
  };
  const raw = await dial(rawNetwork, limits);
  const version =
    config.httpVersion === 'auto' ? (raw.alpnProtocol === 'h2' ? '2' : '1.1') : config.httpVersion;
  if (tls && version === '2' && raw.alpnProtocol !== 'h2') {
    raw.destroy();
    throw failure('ERR_TRANSPORT', 'XHTTP peer did not negotiate HTTP/2.', 'transport');
  }
  const mode = config.mode === 'auto' ? (version === '2' ? 'stream-up' : 'packet-up') : config.mode;
  const address = isIPv6(network.address) ? `[${network.address}]` : network.address;
  const authorityName = config.host ?? tls?.serverName ?? address;
  const authority = isIPv6(authorityName) ? `[${authorityName}]` : authorityName;
  const origin = `${tls ? 'https' : 'http'}://${address}:${network.port}`;
  const requests = new Set(),
    sockets = new Set([raw]);
  let first = raw,
    agent,
    session,
    upload,
    downstream,
    sequence = 0;
  let closed = false,
    closeReason;
  const fail = (cause) => stream.destroy(transportError(cause));
  const stream = new XhttpStream(config, {
    remoteAddress: raw.remoteAddress,
    control: (ref) => {
      for (const socket of sockets) socket[ref ? 'ref' : 'unref']();
    },
    resume: () => downstream?.resume(),
    send: (data, callback) => {
      if (mode !== 'packet-up') return upload.write(data, callback);
      (async () => {
        for (let offset = 0; offset < data.length; offset += config.maxPostBytes) {
          const part = data.subarray(offset, offset + config.maxPostBytes);
          const pending = request('POST', `${id}/${sequence++}`, part.length);
          pending.req.end(part);
          const body = await pending.response;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              const cause = failure(
                'ERR_TIMEOUT',
                'XHTTP packet acknowledgement timed out.',
                'transport',
              );
              stream.destroy(cause);
              reject(cause);
            }, config.timeout);
            const settle = (cause) => {
              clearTimeout(timer);
              cause ? reject(cause) : resolve();
            };
            body.once('end', () => settle());
            body.once('error', settle);
            body.once('aborted', () =>
              settle(failure('ERR_CLOSED', 'XHTTP upload response was aborted.', 'transport')),
            );
            body.resume();
          });
        }
      })().then(
        () => callback(),
        (cause) => callback(closeReason ?? cause),
      );
    },
    finish: (callback) => {
      if (mode === 'packet-up') {
        callback();
        queueMicrotask(() => stream.destroy());
      } else upload.end(callback);
    },
    dispose: (cause) => {
      closed = true;
      closeReason = cause;
      limits.signal?.removeEventListener('abort', abort);
      for (const req of requests) req.destroy(cause);
      for (const socket of sockets) socket.destroy();
      agent?.destroy();
      session?.destroy();
    },
  });
  const abort = () =>
    stream.destroy(
      failure('ERR_CANCELLED', 'XHTTP dial was cancelled.', 'transport', limits.signal.reason),
    );
  limits.signal?.addEventListener('abort', abort, { once: true });
  const id = randomUUID();
  if (version === '2') {
    session = http2.connect(origin, {
      createConnection: () => raw,
      maxSessionMemory: 4,
      maxHeaderListPairs: 64,
      settings: {
        enablePush: false,
        maxHeaderListSize: 8192,
        initialWindowSize: Math.min(config.maxBytes, 65535),
      },
    });
    first = undefined;
    session.on('error', fail);
    session.on('goaway', () =>
      fail(failure('ERR_CLOSED', 'XHTTP HTTP/2 connection received GOAWAY.', 'transport')),
    );
    session.once('close', () => {
      if (!closed) fail(failure('ERR_CLOSED', 'XHTTP HTTP/2 connection closed.', 'transport'));
    });
  } else {
    // Each logical connection owns its pool. No global agents, retries, or cross-generation reuse.
    agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1 });
    agent.createConnection = (_options, callback) => {
      if (first) {
        const value = first;
        first = undefined;
        callback(null, value);
        return;
      }
      dial(rawNetwork, limits).then((socket) => {
        if (closed) {
          socket.destroy();
          callback(failure('ERR_CLOSED', 'XHTTP connection closed.', 'transport'));
          return;
        }
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        callback(null, socket);
      }, callback);
    };
  }
  function request(method, suffix, length) {
    const path = config.path + suffix + (config.query ? '?' + config.query : '');
    const headers = Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    headers.referer = `${tls ? 'https' : 'http'}://${authority}${config.path}${suffix}?x_padding=${padding(config)}`;
    if (method === 'POST' && length === undefined && !config.noGRPCHeader)
      headers['content-type'] = 'application/grpc';
    // Go's HTTP/1 server otherwise drains the unfinished request body before
    // flushing response headers. A streaming POST owns this socket until close.
    if (version === '1.1' && method === 'POST' && length === undefined)
      headers.connection = 'close';
    if (length !== undefined) headers['content-length'] = String(length);
    const req =
      version === '2'
        ? session.request(
            {
              ...headers,
              ':method': method,
              ':path': path,
              ':scheme': tls ? 'https' : 'http',
              ':authority': authority,
            },
            { endStream: method === 'GET' },
          )
        : http.request({
            host: network.address,
            port: network.port,
            method,
            path,
            agent,
            headers: { ...headers, host: authority },
          });
    requests.add(req);
    req.once('close', () => requests.delete(req));
    req.on('error', fail);
    const response = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (cause, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause) reject(cause);
        else resolve(body);
      };
      const timer = setTimeout(() => {
        const cause = failure('ERR_TIMEOUT', 'XHTTP response headers timed out.', 'transport');
        finish(cause);
        stream.destroy(cause);
      }, config.timeout);
      req.once('error', (cause) => finish(transportError(cause)));
      req.once('close', () =>
        finish(failure('ERR_CLOSED', 'XHTTP request closed before response headers.', 'transport')),
      );
      req.once('response', (value) => {
        const body = version === '2' ? req : value;
        const status = version === '2' ? value[':status'] : value.statusCode;
        if (status !== 200) {
          const cause = failure('ERR_TRANSPORT', 'XHTTP peer rejected the request.', 'transport');
          cause.context.status = status;
          finish(cause);
          stream.destroy(cause);
        } else finish(undefined, body);
      });
    });
    // Some requests start before connect() returns; rejection must always have an owner.
    response.catch(fail);
    if (version === '1.1') {
      if (method === 'GET') req.end();
      else req.flushHeaders();
    }
    return { req, response };
  }
  try {
    if (limits.signal?.aborted) abort();
    const down = request(mode === 'stream-one' ? 'POST' : 'GET', mode === 'stream-one' ? '' : id);
    if (mode === 'stream-one') upload = down.req;
    if (mode === 'stream-up') {
      const up = request('POST', id);
      upload = up.req;
      up.response.then((body) => body.resume(), fail);
    }
    downstream = await down.response;
    attachBody(downstream, stream);
    if (stream.destroyed) throw failure('ERR_CLOSED', 'XHTTP closed during setup.', 'transport');
    return stream;
  } catch (cause) {
    stream.destroy();
    throw closeReason ? transportError(closeReason) : transportError(cause);
  }
}
module.exports = { connect };
