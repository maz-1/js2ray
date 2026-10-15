'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { isIPv6 } = require('node:net');
const { failure } = require('../../runtime/errors');
const { settings, padding, transportError, XhttpStream, attachBody } = require('./common');
const { XmuxPool } = require('./xmux');

async function connect(network, limits, dial) {
  const config = settings(network.option, limits);
  const tls = config.tls;
  const ownPool = !limits.xhttpPool;
  const pool = limits.xhttpPool ?? new XmuxPool(network, limits, dial);
  let lease;
  try {
    lease = await pool.acquire(limits.signal);
  } catch (cause) {
    if (ownPool) pool.close();
    throw cause;
  }
  const entry = lease.entry;
  const version = entry.version;
  const mode = config.mode === 'auto' ? (version === '2' ? 'stream-up' : 'packet-up') : config.mode;
  const address = isIPv6(network.address) ? `[${network.address}]` : network.address;
  const authorityName = config.host ?? tls?.serverName ?? address;
  const authority = isIPv6(authorityName) ? `[${authorityName}]` : authorityName;
  const requests = new Set();
  const leases = new Set([lease]);
  const lifetime = new AbortController();
  const packetSignal = limits.signal
    ? AbortSignal.any([limits.signal, lifetime.signal])
    : lifetime.signal;
  let packetLease = lease,
    upload,
    downstream,
    sequence = 0;
  let closed = false,
    closeReason;
  let referenced = true;
  const fail = (cause) => stream.destroy(transportError(cause));
  const stream = new XhttpStream(config, {
    remoteAddress: entry.remoteAddress,
    control: (ref) => {
      referenced = ref;
      for (const value of leases) value.ref(ref);
    },
    send: (data, callback) => {
      if (mode !== 'packet-up') return upload.write(data, callback);
      (async () => {
        for (let offset = 0; offset < data.length; offset += config.maxPostBytes) {
          const part = data.subarray(offset, offset + config.maxPostBytes);
          if (!packetLease.entry.packetReusable()) {
            const previous = packetLease;
            packetLease = await pool.acquire(packetSignal, false);
            if (closed) {
              packetLease.release();
              throw closeReason ?? failure('ERR_CLOSED', 'XHTTP connection closed.', 'transport');
            }
            leases.add(packetLease);
            packetLease.ref(referenced);
            if (previous !== lease) {
              leases.delete(previous);
              previous.release();
            }
          }
          const pending = request('POST', `${id}/${sequence++}`, part.length, packetLease.entry);
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
      lifetime.abort();
      limits.signal?.removeEventListener('abort', abort);
      for (const req of requests) req.destroy(cause);
      for (const value of leases) value.release();
      leases.clear();
      if (ownPool) pool.close();
    },
  });
  const abort = () =>
    stream.destroy(
      failure('ERR_CANCELLED', 'XHTTP dial was cancelled.', 'transport', limits.signal.reason),
    );
  limits.signal?.addEventListener('abort', abort, { once: true });
  const id = randomUUID();
  function request(method, suffix, length, owner = entry) {
    if (closed) throw closeReason ?? failure('ERR_CLOSED', 'XHTTP connection closed.', 'transport');
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
      owner.version === '2'
        ? owner.session.request(
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
            agent: owner.agent,
            headers: { ...headers, host: authority },
          });
    requests.add(req);
    owner.countRequest(req);
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
        const body = owner.version === '2' ? req : value;
        const status = owner.version === '2' ? value[':status'] : value.statusCode;
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
    if (owner.version === '1.1') {
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
