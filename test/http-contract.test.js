'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { createRuntime } = require('../');
const { listen } = require('./helpers');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/tls/cert.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/tls/key.pem'), 'utf8');
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

for (const protocol of ['freedom', 'vmess', 'vless']) {
  for (const secure of [false, true]) {
    test(
      `${protocol} stream works with Node ${secure ? 'HTTPS (inner TLS)' : 'HTTP'} Agent`,
      { timeout: 5000 },
      async (t) => {
        const handler = (req, res) => {
          res.end('HTTP contract verified');
        };
        const origin = secure
          ? https.createServer({ cert, key }, handler)
          : http.createServer(handler);
        const port = await listen(origin);
        t.after(
          () =>
            new Promise((resolve) => {
              origin.closeAllConnections();
              origin.close(resolve);
            }),
        );
        let peer;
        let outbounds;
        if (protocol !== 'freedom') {
          peer = createRuntime({
            inbounds: [
              {
                protocol,
                users: [{ id, security: protocol === 'vmess' ? 'auto' : undefined }].map((user) =>
                  protocol === 'vless' ? { id: user.id } : user,
                ),
                networks: [{ port: 0 }],
              },
            ],
          });
          await peer.start();
          outbounds = [
            {
              protocol,
              users:
                protocol === 'vless' ? [{ id, encryption: 'none' }] : [{ id, security: 'auto' }],
              networks: [{ address: '127.0.0.1', port: peer.listenersInfo[0].address.port }],
            },
          ];
        }
        const runtime = createRuntime({ inbounds: [], outbounds });
        await runtime.start();
        t.after(() => Promise.all([runtime.close(), peer?.close()]));
        const agent = secure
          ? new https.Agent({ keepAlive: true })
          : new http.Agent({ keepAlive: true });
        t.after(() => agent.destroy());
        agent.createConnection = (options, callback) => {
          runtime.dial({ host: options.host, port: Number(options.port) }).then((socket) => {
            if (!secure) return callback(null, socket);
            const inner = tls.connect({ socket, ca: cert, servername: 'js2ray.test' });
            const error = (cause) => callback(cause);
            inner.once('error', error);
            inner.once('secureConnect', () => {
              inner.removeListener('error', error);
              callback(null, inner);
            });
          }, callback);
        };
        const body = await new Promise((resolve, reject) => {
          (secure ? https : http)
            .get({ host: '127.0.0.1', port, agent }, (res) => {
              let body = '';
              res.on('data', (data) => {
                body += data;
              });
              res.once('end', () => resolve(body));
            })
            .once('error', reject);
        });
        assert.equal(body, 'HTTP contract verified');
      },
    );
  }
}
