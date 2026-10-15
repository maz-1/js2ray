'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { createRuntime, createHttpAgent, createHttpsAgent } = require('../..');
const { listen } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const { portalConfig, bridgeConfig, waitFor } = require('../fixtures/reverse');
const cert = fs.readFileSync(require.resolve('../fixtures/tls/cert.pem'), 'utf8'),
  key = fs.readFileSync(require.resolve('../fixtures/tls/key.pem'), 'utf8');
for (const kind of ['v2ray', 'xray'])
  for (const role of ['bridge', 'portal'])
    for (const secure of [false, true]) {
      test(`${kind}: js2ray ${role} reverse ${secure ? 'HTTPS' : 'HTTP'} streaming`, async (t) => {
        const payload = Buffer.alloc(256 * 1024, 37);
        const handler = (_req, res) => {
          res.write(payload.subarray(0, 100));
          setImmediate(() => res.end(payload.subarray(100)));
        };
        const origin = secure
          ? https.createServer({ cert, key }, handler)
          : http.createServer(handler);
        const originPort = await listen(origin);
        t.after(
          () =>
            new Promise((resolve) => {
              origin.closeAllConnections();
              origin.close(resolve);
            }),
        );
        let runtime, url;
        if (role === 'bridge') {
          const port = await freePort(),
            businessPort = await freePort();
          await runCore(t, kind, portalConfig(port, businessPort), port);
          const bridge = createRuntime(bridgeConfig(port, { host: '127.0.0.1', port: originPort }));
          const events = [];
          bridge.on('reverse', (event) => events.push(event));
          await bridge.start();
          t.after(() => bridge.close());
          await waitFor(() => events.some((event) => event.state === 'active'));
          runtime = createRuntime();
          await runtime.start();
          url = `${secure ? 'https' : 'http'}://127.0.0.1:${businessPort}/stream`;
        } else {
          runtime = createRuntime(portalConfig(0));
          await runtime.start();
          const port = await freePort(),
            config = bridgeConfig(runtime.listenersInfo[0].address.port, {
              host: '127.0.0.1',
              port: originPort,
            });
          config.inbounds = [
            { listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } },
          ];
          await runCore(t, kind, config, port);
          await waitFor(() => runtime.stats.reverse[0].active > 0);
          url = `${secure ? 'https' : 'http'}://service.test:80/stream`;
        }
        t.after(() => runtime.close());
        const options = {
          ...(role === 'portal' ? { outboundTag: 'portal' } : {}),
          targetTls: { ca: cert, serverName: 'js2ray.test' },
        };
        const agent = secure
          ? createHttpsAgent(runtime, options)
          : createHttpAgent(runtime, options);
        t.after(() => agent.destroy());
        const body = await new Promise((resolve, reject) => {
          (secure ? https : http)
            .get(url, { agent }, (res) => {
              const chunks = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.once('error', reject);
              res.once('end', () => resolve(Buffer.concat(chunks)));
            })
            .once('error', reject);
        });
        assert.deepEqual(body, payload);
      });
    }
