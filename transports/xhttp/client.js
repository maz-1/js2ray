'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { isIPv6 } = require('node:net');
const { failure } = require('../../runtime/errors');
const { settings, padding, transportError, XhttpStream, attachBody } = require('./common');
const { XmuxPool } = require('./xmux');

async function connect(network, limits, dial) {
  const config = settings(network.option, limits);
  const download = config.downloadSettings;
  const downloadConfig = download ? settings(download.option, limits) : config;
  const ownedPools = new Set();
  const makePool = (network, slots) => {
    const value = new XmuxPool(network, { ...limits, xhttpSlots: slots }, dial);
    ownedPools.add(value);
    return value;
  };
  const pool = limits.xhttpPool ?? makePool(network, download ? 1 : undefined);
  const downPool = download ? (limits.xhttpDownloadPool ?? makePool(download, 1)) : pool;
  let lease, downLease;
  try {
    lease = await pool.acquire(limits.signal);
    downLease = download ? await downPool.acquire(limits.signal) : lease;
  } catch (cause) {
    lease?.release();
    for (const value of ownedPools) value.close();
    throw cause;
  }
  const entry = lease.entry;
  const version = entry.version;
  const mode = config.mode === 'auto' ? (version === '2' ? 'stream-up' : 'packet-up') : config.mode;
  const requests = new Set();
  const leases = new Set([lease, downLease]);
  const observers = new Map();
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
    remoteAddress: downLease.entry.remoteAddress,
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
            packetLease = await pool.acquire(packetSignal, Boolean(download));
            if (closed) {
              packetLease.release();
              throw closeReason ?? failure('ERR_CLOSED', 'XHTTP connection closed.', 'transport');
            }
            leases.add(packetLease);
            observe(packetLease);
            packetLease.ref(referenced);
            if (previous !== lease || download) {
              leases.delete(previous);
              unobserve(previous);
              previous.release();
            }
          }
          const pending = request('POST', `${id}/${sequence++}`, part.length, packetLease.entry);
          pending.req.end(part);
          const body = await pending.response;
          await new Promise((resolve, reject) => {
            // Empty HTTP/2 acknowledgements can reach EOF before this Promise
            // continuation runs. Waiting only for a future end loses that EOF.
            if (body.readableEnded) return resolve();
            if (body.destroyed)
              return reject(
                failure('ERR_CLOSED', 'XHTTP upload response closed before EOF.', 'transport'),
              );
            let settled = false;
            const timer = setTimeout(() => {
              const cause = failure(
                'ERR_TIMEOUT',
                'XHTTP packet acknowledgement timed out.',
                'transport',
              );
              settle(cause);
              stream.destroy(cause);
            }, config.timeout);
            const settle = (cause) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              body.removeListener('end', ended);
              body.removeListener('error', failed);
              body.removeListener('aborted', aborted);
              body.removeListener('close', closedBody);
              cause ? reject(cause) : resolve();
            };
            const ended = () => settle(),
              failed = (cause) => settle(cause);
            const aborted = () =>
              settle(failure('ERR_CLOSED', 'XHTTP upload response was aborted.', 'transport'));
            const closedBody = () =>
              body.readableEnded
                ? settle()
                : settle(
                    failure('ERR_CLOSED', 'XHTTP upload response closed before EOF.', 'transport'),
                  );
            body.once('end', ended);
            body.once('error', failed);
            body.once('aborted', aborted);
            body.once('close', closedBody);
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
      // An HTTP/2 body callback can run while nghttp2 is receiving a frame.
      // Node 24 can free that frame's stream if destroy() sends RST_STREAM
      // reentrantly. Close the logical stream now and reset its requests after
      // the native receive stack has unwound (nextTick/microtasks are too early).
      const pending = [...requests];
      setImmediate(() => {
        for (const req of pending) req.destroy(cause);
      });
      for (const value of leases) {
        unobserve(value);
        value.release();
      }
      leases.clear();
      for (const value of ownedPools) value.close();
    },
  });
  function observe(value) {
    const callback = () => {
      if (!closed) stream.destroy(transportError(value.entry.signal.reason));
    };
    observers.set(value, callback);
    value.entry.signal.addEventListener('abort', callback, { once: true });
    if (value.entry.signal.aborted) callback();
  }
  function unobserve(value) {
    value.entry.signal.removeEventListener('abort', observers.get(value));
    observers.delete(value);
  }
  const abort = () =>
    stream.destroy(
      failure('ERR_CANCELLED', 'XHTTP dial was cancelled.', 'transport', limits.signal.reason),
    );
  limits.signal?.addEventListener('abort', abort, { once: true });
  for (const value of leases) observe(value);
  const id = randomUUID();
  function request(method, suffix, length, owner = entry, selected = config, endpoint = network) {
    if (closed) throw closeReason ?? failure('ERR_CLOSED', 'XHTTP connection closed.', 'transport');
    const tls = selected.tls;
    const authorityName = selected.host ?? tls?.serverName ?? endpoint.address;
    const authority = isIPv6(authorityName) ? `[${authorityName}]` : authorityName;
    const path = selected.path + suffix + (selected.query ? '?' + selected.query : '');
    const headers = Object.fromEntries(
      Object.entries(selected.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    headers.referer = `${tls ? 'https' : 'http'}://${authority}${selected.path}${suffix}?x_padding=${padding(selected)}`;
    if (method === 'POST' && length === undefined && !selected.noGRPCHeader)
      headers['content-type'] = 'application/grpc';
    // Go's HTTP/1 server otherwise drains the unfinished request body before
    // flushing response headers. A streaming POST owns this socket until close.
    if (owner.version === '1.1' && method === 'POST' && length === undefined)
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
            host: endpoint.address,
            port: endpoint.port,
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
    const down = request(
      mode === 'stream-one' ? 'POST' : 'GET',
      mode === 'stream-one' ? '' : id,
      undefined,
      downLease.entry,
      downloadConfig,
      download ?? network,
    );
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
