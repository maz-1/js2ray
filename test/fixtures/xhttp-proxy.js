'use strict';
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const fs = require('node:fs');
const path = require('node:path');
const { listen } = require('../helpers');
const certFile = path.join(__dirname, 'tls/cert.pem');
const keyFile = path.join(__dirname, 'tls/key.pem');
const ca = fs.readFileSync(certFile, 'utf8');
const identity = { cert: ca, key: fs.readFileSync(keyFile) };
const clean = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !name.startsWith(':') &&
        !/^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection|http2-settings|te)$/i.test(
          name,
        ),
    ),
  );

// Real HTTP requests terminate here and are forwarded to one shared backend.
// Two independently configured frontends can rewrite different paths/hosts.
async function proxy(t, options) {
  const {
    target,
    version = '1.1',
    secure = true,
    prefix = '/',
    backendPath = '/shared/',
    method,
    host,
    upstreamVersion = '1.1',
  } = options;
  const sockets = new Set(),
    sessions = new Set(),
    pending = new Set(),
    requests = [];
  let fault = options.fault;
  const handler = (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const authority = req.headers[':authority'] ?? req.headers.host;
    const activeFault =
      !options.faultMethod || options.faultMethod === req.method ? fault : undefined;
    requests.push({ method: req.method, url: req.url, host: authority, version: req.httpVersion });
    if (requests.length > (options.maxRecords ?? 4096)) requests.shift();
    if (
      !req.url.startsWith(prefix) ||
      (method && req.method !== method) ||
      (host && authority !== host)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (activeFault === 'reject' || activeFault === 'redirect') {
      res.writeHead(activeFault === 'redirect' ? 302 : 503, { location: '/never-replay' });
      res.end();
      return;
    }
    if (activeFault === 'headers') return;
    const headers = { ...clean(req.headers), host: 'backend.test' };
    const url = backendPath + req.url.slice(prefix.length);
    let upstream, session;
    if (upstreamVersion === '2') {
      session = http2.connect(`http://${target.host ?? '127.0.0.1'}:${target.port}`);
      sessions.add(session);
      session.on('error', () => {});
      session.once('close', () => sessions.delete(session));
      upstream = session.request({
        ...headers,
        ':method': req.method,
        ':path': url,
        ':authority': 'backend.test',
      });
    } else
      upstream = http.request({
        host: target.host ?? '127.0.0.1',
        port: target.port,
        method: req.method,
        path: url,
        headers,
        agent: false,
      });
    pending.add(upstream);
    upstream.once('close', () => {
      pending.delete(upstream);
      session?.close();
    });
    upstream.on('error', () => res.destroy());
    upstream.once('response', (value) => {
      const body = session ? upstream : value;
      body.on('error', () => res.destroy());
      res.writeHead(
        session ? value[':status'] : value.statusCode,
        clean(session ? value : value.headers),
      );
      res.flushHeaders();
      body.pipe(res);
      res.once('close', () => body.destroy());
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    if (activeFault === 'buffer') {
      // Deliberate finite request buffering models a misconfigured reverse proxy.
      const chunks = [];
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => upstream.end(Buffer.concat(chunks)));
    } else {
      upstream.flushHeaders?.();
      req.pipe(upstream);
    }
  };
  const server =
    version === '2'
      ? secure
        ? http2.createSecureServer({ ...identity, allowHTTP1: true }, handler)
        : http2.createServer(handler)
      : secure
        ? https.createServer(identity, handler)
        : http.createServer(handler);
  // A streaming POST is intentionally open for the connection's lifetime.
  // Node HTTP/1 defaults to a five-minute whole-request deadline, even while
  // bytes continue to arrive. Logical handshake/idle limits own this budget.
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => sessions.delete(session));
  });
  const port = await listen(server);
  const close = () => {
    for (const req of pending) req.destroy();
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
  };
  t.after(async () => {
    close();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    port,
    server,
    requests,
    sockets,
    sessions,
    pending,
    break: close,
    setFault: (value) => {
      fault = value;
    },
    network: {
      type: 'xhttp',
      address: '127.0.0.1',
      port,
      option: {
        path: prefix,
        host: host ?? 'front.test',
        httpVersion: version,
        ...(secure ? { tls: { ca, serverName: 'js2ray.test' } } : {}),
      },
    },
  };
}
module.exports = { proxy, ca, certFile, keyFile };
