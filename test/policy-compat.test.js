'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { checkConfig, createRuntime } = require('..');
const { Router } = require('../routing');
const { echo, readBytes } = require('./helpers');
const crypto = require('node:crypto');
const manifest = require('./fixtures/geodata/manifest.json');
const dgram = require('node:dgram');

for (const mode of ['vmess', 'vless', 'socks', 'mux', 'xudp'])
  test(`${mode}: UDP routing inherits only authenticated outer source and identity`, async (t) => {
    const target = dgram.createSocket('udp4');
    target.on('message', (bytes, peer) => target.send(bytes, peer.port, peer.address));
    target.bind(0, '127.0.0.1');
    await once(target, 'listening');
    t.after(() => new Promise((r) => target.close(r)));
    const id = crypto.randomUUID(),
      protocol = ['mux', 'xudp'].includes(mode) ? 'vless' : mode,
      users =
        protocol === 'socks'
          ? [{ user: 'udp@synthetic', pass: 'synthetic-password' }]
          : [
              {
                id,
                email: 'udp@synthetic',
                ...(protocol === 'vless' ? { encryption: 'none' } : { security: 'aes-128-gcm' }),
              },
            ];
    const server = createRuntime({
      inbounds: [
        {
          protocol,
          users,
          networks: [{ port: 0 }],
          ...(protocol === 'socks' ? { udp: true } : {}),
        },
      ],
      outbounds: [
        { tag: 'deny', protocol: 'blackhole' },
        { tag: 'allow', protocol: 'freedom' },
      ],
      routing: {
        rules: [
          {
            source: ['127.0.0.1'],
            sourcePort: '1-65535',
            user: ['udp@synthetic'],
            network: 'udp',
            outboundTag: 'allow',
          },
        ],
      },
    });
    await server.start();
    t.after(() => server.close());
    const client = createRuntime({
      outbounds: [
        {
          protocol,
          users,
          networks: [{ address: '127.0.0.1', port: server.listenersInfo[0].address.port }],
          ...(mode === 'mux' ? { mux: { enabled: true } } : {}),
          ...(mode === 'xudp' ? { packetEncoding: 'xudp' } : {}),
        },
      ],
    });
    await client.start();
    t.after(() => client.close());
    const session = await client.openDatagram({ host: '127.0.0.1', port: target.address().port });
    await session.send(Buffer.from('policy'));
    assert.equal((await session.next()).value.data.toString(), 'policy');
    session.destroy();
  });

test('policy profiles, field aliases, indexed matchers and unknown behavior are explicit', () => {
  for (const compatibility of ['native', 'v2ray-5.14.1', 'xray-25.3.6'])
    for (const domainMatcher of ['linear', 'mph', 'hybrid']) {
      const config = {
        compatibility,
        routing: {
          domainMatcher,
          rules: [
            {
              domains: ['regexp:^api[0-9]+\\.example$'],
              ruleTag: 'synthetic',
              outboundTag: 'direct',
            },
          ],
        },
      };
      const report = checkConfig(config);
      assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
      assert.equal(
        new Router(report.config.routing, report.config._assets, compatibility).select({
          host: 'api42.example',
        }),
        'direct',
      );
      assert.equal(checkConfig(report.config).ok, true);
    }
  for (const routing of [
    { balancers: [] },
    { rules: [{ network: 'tcp', balancerTag: 'auto' }] },
    { rules: [{ source: ['invalid'], outboundTag: 'direct' }] },
  ])
    assert.equal(checkConfig({ routing }).ok, false);
  assert.equal(checkConfig({ compatibility: 'latest' }).ok, false);
});

for (const protocol of ['vmess', 'vless', 'socks'])
  for (const type of ['tcp', 'ws', 'xhttp'])
    test(`${protocol}/${type}: authenticated identity and source survive plaintext sniffing and payload fragmentation`, async (t) => {
      const destination = await echo(t),
        id = crypto.randomUUID();
      const users =
        protocol === 'socks'
          ? [{ user: 'tenant@synthetic', pass: 'synthetic-password' }]
          : [{ id, email: 'tenant@synthetic', security: 'aes-128-gcm' }];
      if (protocol === 'vless') {
        delete users[0].security;
        users[0].encryption = 'none';
      }
      const network = {
        type,
        address: '127.0.0.1',
        port: 0,
        ...(type === 'tcp'
          ? {}
          : {
              option: {
                path: '/policy',
                ...(type === 'xhttp' ? { httpVersion: '1.1', mode: 'packet-up' } : {}),
              },
            }),
      };
      const server = createRuntime({
        inbounds: [
          {
            tag: 'entry',
            protocol,
            networks: [network],
            users,
            sniffing: { enabled: true, routeOnly: true },
          },
        ],
        outbounds: [
          { tag: 'deny', protocol: 'blackhole' },
          { tag: 'allow', protocol: 'freedom' },
        ],
        routing: {
          rules: [
            {
              source: ['127.0.0.1'],
              sourcePort: '1-65535',
              user: ['tenant@synthetic'],
              protocol: ['http'],
              attrs: { ':method': '^POST$', 'x-policy': '^yes$' },
              outboundTag: 'allow',
            },
          ],
        },
      });
      await server.start();
      t.after(() => server.close());
      const client = createRuntime({
        outbounds: [
          {
            protocol,
            networks: [{ ...network, port: server.listenersInfo[0].address.port }],
            users,
          },
        ],
      });
      await client.start();
      t.after(() => client.close());
      const stream = await client.dial({ host: '127.0.0.1', port: destination.port });
      t.after(() => stream.destroy());
      const payload = Buffer.from(
        'POST /policy HTTP/1.1\r\nHost: synthetic.example\r\nX-Policy: yes\r\n\r\n' +
          'x'.repeat(65536),
      );
      stream.write(payload.subarray(0, 10));
      stream.write(payload.subarray(10));
      assert.deepEqual(await readBytes(stream, payload.length), payload);
    });

test('RE2 and declared external Geo resources support domain and source inversion without backtracking', () => {
  const config = {
    geodata: {
      ...manifest,
      external: {
        'custom-site.dat': { ...manifest.geosite, kind: 'geosite' },
        'custom-ip.dat': { ...manifest.geoip, kind: 'geoip' },
      },
    },
    routing: {
      rules: [
        {
          domains: ['ext:custom-site.dat:cn'],
          source: ['ext-ip:custom-ip.dat:!cn'],
          outboundTag: 'direct',
        },
      ],
    },
  };
  const report = checkConfig(config);
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  const router = new Router(report.config.routing, report.config._assets);
  assert.equal(router.select({ host: 'sub.cn.test', sourceIP: '192.0.2.1' }), 'direct');
  assert.equal(router.select({ host: 'sub.cn.test', sourceIP: '198.18.1.1' }), undefined);
  for (const pattern of ['regexp:(?=forbidden)', 'regexp:(a)\\1', 'ext:undeclared.dat:cn'])
    assert.equal(
      checkConfig({ routing: { rules: [{ domain: [pattern], outboundTag: 'direct' }] } }).ok,
      false,
    );
  const expression = require('../geodata/regex').expression('(a+)+$');
  assert.equal(expression('a'.repeat(20000) + '!'), false);
});

test('routing requires every source, user, protocol and HTTP attribute condition and preserves field OR', () => {
  const router = new Router({
    rules: [
      {
        source: ['192.0.2.0/24', '2001:db8::/32'],
        sourcePort: '1000-2000',
        user: ['regexp:^tenant@'],
        protocol: ['http'],
        attrs: { ':method': '^GET$', 'X-Mode': '^synthetic$' },
        outboundTag: 'direct',
      },
    ],
  });
  const target = {
    host: 'example.test',
    sourceIP: '2001:db8::1',
    sourcePort: 1234,
    userEmail: 'tenant@example.test',
    protocol: 'http1',
    attrs: { ':method': 'GET', 'x-mode': 'synthetic' },
  };
  assert.equal(router.select(target), 'direct');
  for (const field of ['sourceIP', 'sourcePort', 'userEmail', 'protocol', 'attrs'])
    assert.equal(router.select({ ...target, [field]: undefined }), undefined, field);
  assert.equal(
    checkConfig({
      compatibility: 'v2ray-5.14.1',
      routing: { rules: [{ attrs: { ':method': 'GET' }, outboundTag: 'direct' }] },
    }).ok,
    false,
  );
  const v2 = new Router(
    { rules: [{ user: ['regexp:^tenant@'], outboundTag: 'direct' }] },
    undefined,
    'v2ray-5.14.1',
  );
  assert.equal(v2.select(target), undefined);
});

test('100000 indexed domain rules keep exact, suffix, keyword and regex decisions identical', () => {
  const domains = Array.from({ length: 100000 }, (_, i) => 'full:n' + i + '.example');
  domains.push('domain:suffix.example', 'keyword:needle', 'regexp:^regex[0-9]+\\.example$');
  const indexed = new Router({
    domainMatcher: 'mph',
    rules: [{ domain: domains, outboundTag: 'direct' }],
  });
  for (const host of [
    'n99999.example',
    'deep.suffix.example',
    'hasneedle.example',
    'regex42.example',
  ])
    assert.equal(indexed.select({ host }), 'direct');
  assert.equal(indexed.select({ host: 'unmatched.example' }), undefined);
});

test('TCP inbound passes real source and sniffed HTTP attributes without consuming the first payload', async (t) => {
  const target = await echo(t);
  const runtime = createRuntime({
    inbounds: [
      {
        protocol: 'tcp',
        tag: 'entry',
        target: { host: '127.0.0.1', port: target.port },
        networks: [{ port: 0 }],
        sniffing: { enabled: true, routeOnly: true },
      },
    ],
    outbounds: [
      { tag: 'blocked', protocol: 'blackhole' },
      { tag: 'direct', protocol: 'freedom' },
    ],
    routing: {
      rules: [
        {
          source: ['127.0.0.1'],
          sourcePort: '1-65535',
          protocol: ['http'],
          attrs: { ':method': '^GET$', ':path': '^/synthetic$', 'X-Check': 'yes' },
          outboundTag: 'direct',
        },
      ],
    },
  });
  await runtime.start();
  t.after(() => runtime.close());
  const socket = net.connect(runtime.listenersInfo[0].address.port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const payload = Buffer.from(
    'GET /synthetic HTTP/1.1\r\nHost: synthetic.test\r\nX-Check: yes\r\n\r\npreserved',
  );
  socket.write(payload.subarray(0, 13));
  socket.write(payload.subarray(13));
  assert.deepEqual(await readBytes(socket, payload.length), payload);
});
