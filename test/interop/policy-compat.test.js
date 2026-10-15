'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRuntime } = require('../..');
const { runCore, freePort } = require('./helpers');
const { dnsServer } = require('../fixtures/dns-server');
const { listen, readBytes } = require('../helpers');
const wire = require('../../dns/wire');
const manifest = require('../fixtures/geodata/manifest.json');
const variants = [
  ['v2ray', 'v2ray', 'v2ray-5.14.1'],
  ['xray', 'xray-xhttp', 'xray-25.3.6'],
];
async function referenceDns(t, kind, profile, dns) {
  const port = await freePort(true);
  await runCore(
    t,
    kind,
    {
      log: { loglevel: 'warning' },
      dns,
      inbounds: [
        {
          tag: 'dns-in',
          listen: '127.0.0.1',
          port,
          protocol: 'dokodemo-door',
          settings: { network: 'tcp,udp', address: '8.8.8.8', port: 53 },
        },
      ],
      outbounds: [
        { tag: 'direct', protocol: 'freedom' },
        { tag: 'dns', protocol: 'dns' },
      ],
      routing: { rules: [{ type: 'field', inboundTag: ['dns-in'], outboundTag: 'dns' }] },
    },
    port,
    { profile },
  );
  const client = createRuntime();
  await client.start();
  t.after(() => client.close());
  return async (host, family = 4) => {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 3500);
    const session = await client.openDatagram({
      host: '127.0.0.1',
      port,
      signal: controller.signal,
    });
    try {
      const query = wire.query(host, family === 4 ? 1 : 28);
      await session.send(query);
      const data = (await session.next()).value?.data;
      return data ? wire.response(data, query).records : [];
    } catch (error) {
      if (controller.signal.aborted || error.code === 'ERR_DNS') return [];
      throw error;
    } finally {
      clearTimeout(timer);
      session.destroy();
    }
  };
}
for (const [kind, profile, compatibility] of variants) {
  test(`${profile}: fixed client reaches JS inbound with authenticated user/source and sniffed attributes`, async (t) => {
    const destination = await require('../helpers').echo(t),
      id = crypto.randomUUID(),
      server = createRuntime({
        compatibility,
        inbounds: [
          {
            protocol: 'vless',
            users: [{ id, email: 'core@synthetic' }],
            networks: [{ port: 0 }],
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
              user: ['core@synthetic'],
              protocol: ['http'],
              ...(kind === 'xray' ? { attrs: { ':method': '^GET$' } } : {}),
              outboundTag: 'allow',
            },
          ],
        },
      });
    await server.start();
    t.after(() => server.close());
    const port = await freePort();
    await runCore(
      t,
      kind,
      {
        log: { loglevel: 'warning' },
        inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } }],
        outbounds: [
          {
            protocol: 'vless',
            settings: {
              vnext: [
                {
                  address: '127.0.0.1',
                  port: server.listenersInfo[0].address.port,
                  users: [{ id, encryption: 'none' }],
                },
              ],
            },
          },
        ],
      },
      port,
      { profile },
    );
    const client = createRuntime({
      outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    });
    await client.start();
    t.after(() => client.close());
    const stream = await client.dial({ host: '127.0.0.1', port: destination.port }),
      payload = Buffer.from('GET / HTTP/1.1\r\nHost: core.synthetic\r\n\r\n');
    stream.write(payload);
    assert.deepEqual(await readBytes(stream, payload.length), payload);
    stream.destroy();
  });
  test(`${profile}: fixed hosts merge, alias IP precedence and global family restriction agree`, async (t) => {
    const upstream = await dnsServer(t),
      dns = {
        queryStrategy: 'UseIPv4',
        hosts: {
          'hosts.policy.synthetic': '192.0.2.1',
          'domain:policy.synthetic': '192.0.2.2',
          'alias.synthetic': ['192.0.2.3', 'replacement.synthetic'],
          'replacement.synthetic': '192.0.2.4',
          'v6.synthetic': '2001:db8::1',
        },
        servers: [{ address: upstream.address, port: upstream.port }],
      };
    const query = await referenceDns(t, kind, profile, dns),
      runtime = createRuntime({ compatibility, dns });
    await runtime.start();
    t.after(() => runtime.close());
    for (const [host, family] of [
      ['hosts.policy.synthetic', 4],
      ['alias.synthetic', 4],
      ['v6.synthetic', 6],
    ]) {
      const reference = await query(host, family),
        actual = await runtime.resolve(host, { family }).catch(() => []);
      const addresses = (rs) =>
        rs.map((r) => require('../../core/utils').iptoBuffer(r.address).toString('hex'));
      assert.deepEqual(addresses(actual), addresses(reference));
    }
  });
  for (const algorithm of ['linear', ...(kind === 'v2ray' ? ['mph'] : ['hybrid'])])
    test(`${profile}: common routing aliases, RE2, external resources, source/user/protocol and matcher ${algorithm}`, async (t) => {
      const outbounds = [];
      for (const tag of ['default', 'domain', 'context', 'external']) {
        const sockets = new Set(),
          server = net.createServer((s) => {
            sockets.add(s);
            s.once('close', () => sockets.delete(s));
            s.on('error', () => {});
            s.once('data', () => s.end(tag.padEnd(8)));
          });
        const port = await listen(server);
        t.after(() => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        });
        outbounds.push({ tag, protocol: 'freedom', settings: { redirect: `127.0.0.1:${port}` } });
      }
      const id = crypto.randomUUID(),
        users = [{ id, email: 'tenant@synthetic' }];
      const routing = {
        domainMatcher: algorithm,
        rules: [
          {
            type: 'field',
            domain: ['full:one.synthetic'],
            domains: ['regexp:^api[0-9]+\\.synthetic$', 'dotless:single'],
            outboundTag: 'domain',
          },
          {
            type: 'field',
            domain: ['ext:geosite.dat:cn'],
            source: ['ext-ip:geoip.dat:!cn'],
            outboundTag: 'external',
          },
          {
            type: 'field',
            source: ['127.0.0.0/8'],
            sourcePort: '1-65535',
            user: [kind === 'xray' ? 'regexp:^tenant@' : 'tenant@synthetic'],
            protocol: ['http'],
            ...(kind === 'xray' ? { attrs: { 'x-policy': '^yes$' } } : {}),
            outboundTag: 'context',
          },
        ],
      };
      const port = await freePort();
      await runCore(
        t,
        kind,
        {
          log: { loglevel: 'warning' },
          inbounds: [
            {
              listen: '127.0.0.1',
              port,
              protocol: 'vless',
              settings: { decryption: 'none', clients: users },
              sniffing: { enabled: true, routeOnly: true, destOverride: ['http', 'tls'] },
            },
          ],
          outbounds,
          routing,
        },
        port,
        { profile },
      );
      const js = createRuntime({
        compatibility,
        geodata: manifest,
        inbounds: [
          {
            protocol: 'vless',
            users,
            networks: [{ port: 0 }],
            sniffing: { enabled: true, routeOnly: true },
          },
        ],
        outbounds,
        routing,
      });
      await js.start();
      t.after(() => js.close());
      for (const destinationPort of [port, js.listenersInfo[0].address.port]) {
        const client = createRuntime({
          outbounds: [
            {
              protocol: 'vless',
              users: [{ id, encryption: 'none' }],
              networks: [{ address: '127.0.0.1', port: destinationPort }],
            },
          ],
        });
        await client.start();
        t.after(() => client.close());
        for (const [host, payload, expected] of [
          ['one.synthetic', 'raw', 'domain'],
          ['api42.synthetic', 'raw', 'domain'],
          ['single', 'raw', 'domain'],
          ['sub.cn.test', 'raw', 'external'],
          [
            'unknown.synthetic',
            'GET / HTTP/1.1\r\nHost: unknown.synthetic\r\nX-Policy: yes\r\n\r\n',
            'context',
          ],
          ['unknown.synthetic', 'raw', 'default'],
        ]) {
          const stream = await client.dial({ host, port: 80 });
          stream.write(payload);
          assert.equal((await readBytes(stream, 8)).toString().trim(), expected);
          stream.destroy();
        }
      }
    });
  for (const scheme of ['udp', 'tcp', 'tcp+local'])
    test(`${profile}: DNS ${scheme} ECS, expected IPs and cache agree with fixed core`, async (t) => {
      const upstream = await dnsServer(t),
        address = scheme === 'udp' ? upstream.address : `${scheme}://127.0.0.1:${upstream.port}`;
      const dns = {
        queryStrategy: 'UseIPv4',
        clientIp: '192.0.2.199',
        servers: [
          {
            address,
            ...(scheme === 'udp' ? { port: upstream.port } : {}),
            domains: ['domain:policy.synthetic'],
            expectIPs: ['127.0.0.0/8'],
          },
        ],
      };
      const query = await referenceDns(t, kind, profile, dns),
        runtime = createRuntime({ compatibility, dns });
      await runtime.start();
      t.after(() => runtime.close());
      for (const resolve of [query, (h) => runtime.resolve(h, { family: 4 })]) {
        const before = upstream.calls.length;
        assert.equal((await resolve('dns.policy.synthetic'))[0]?.address, '127.0.0.1');
        assert.equal((await resolve('dns.policy.synthetic'))[0]?.address, '127.0.0.1');
        assert.equal(upstream.calls.length - before, 1);
        assert.deepEqual(upstream.calls.at(-1).ecs, {
          family: 4,
          prefix: 24,
          address: '192.0.2.0',
        });
        assert.equal(upstream.calls.at(-1).transport, scheme === 'udp' ? 'udp' : 'tcp');
      }
    });
  for (const failure of ['excluded', 'empty', 'refused', 'servfail', 'strategy', 'expected'])
    test(`${profile}: fixed DNS ${failure} semantics match explicit compatibility profile`, async (t) => {
      const first = await dnsServer(t, {
          ...(failure === 'empty' ? { addresses: [] } : {}),
          ...(failure === 'refused' ? { rcode: 5 } : {}),
          ...(failure === 'servfail' ? { rcode: 2 } : {}),
        }),
        second = await dnsServer(t, { addresses: ['192.0.2.2'] });
      const dns = {
        queryStrategy: 'UseIPv4',
        disableCache: true,
        ...(failure === 'excluded' ? { disableFallback: true } : {}),
        servers: [
          {
            address: first.address,
            port: first.port,
            ...(failure === 'excluded' ? { skipFallback: true } : {}),
            ...(failure === 'strategy' ? { queryStrategy: 'UseIPv6' } : {}),
            ...(failure === 'expected' ? { expectIPs: ['192.0.2.0/24'] } : {}),
          },
          ...(failure === 'excluded' || failure === 'strategy'
            ? []
            : [{ address: second.address, port: second.port }]),
        ],
      };
      const query = await referenceDns(t, kind, profile, dns),
        runtime = createRuntime({ compatibility, dns });
      await runtime.start();
      t.after(() => runtime.close());
      const expected =
        failure === 'expected'
          ? '192.0.2.2'
          : failure === 'strategy'
            ? kind === 'v2ray'
              ? '0:0:0:0:0:0:0:1'
              : undefined
            : failure === 'excluded'
              ? kind === 'xray'
                ? '127.0.0.1'
                : undefined
              : ['empty', 'refused'].includes(failure) && kind === 'xray'
                ? '192.0.2.2'
                : undefined;
      const records = await query('failure.policy.synthetic', failure === 'strategy' ? 6 : 4);
      const actual = await runtime
        .resolve('failure.policy.synthetic', { family: failure === 'strategy' ? 6 : 4 })
        .catch(() => []);
      const canonical = (a) =>
        a && net.isIP(a) === 6 ? require('../../core/utils').iptoBuffer(a).toString('hex') : a;
      assert.equal(canonical(records[0]?.address), canonical(expected), 'reference expectation');
      assert.equal(canonical(actual[0]?.address), canonical(expected), 'js profile expectation');
    });
}
