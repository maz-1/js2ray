'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createRuntime } = require('../..');
const { listen, readBytes } = require('../helpers');
const { runCore, freePort } = require('./helpers');
const { dnsServer } = require('../fixtures/dns-server');
for (const kind of ['v2ray', 'xray']) {
  test(`${kind}: ordered AsIs routing matches js2ray across domains, CIDRs, ports and inbound tags`, async (t) => {
    const outbounds = [];
    for (const tag of ['default', 'direct', 'proxy', 'block']) {
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.end(tag.padEnd(8));
      });
      const port = await listen(server);
      t.after(() => new Promise((resolve) => server.close(resolve)));
      outbounds.push({ tag, protocol: 'freedom', settings: { redirect: `127.0.0.1:${port}` } });
    }
    const routing = {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
        {
          type: 'field',
          domain: ['geosite:cn'],
          inboundTag: ['entry'],
          port: '80,443',
          outboundTag: 'direct',
        },
        { type: 'field', ip: ['10.0.0.0/8', '2001:db8::/32', 'geoip:cn'], outboundTag: 'direct' },
        { type: 'field', domain: ['geosite:geolocation-!cn'], outboundTag: 'proxy' },
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
            tag: 'entry',
            listen: '127.0.0.1',
            port,
            protocol: 'socks',
            settings: { auth: 'noauth', udp: false },
          },
        ],
        outbounds,
        routing,
      },
      port,
    );
    const reference = createRuntime({
      outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    });
    await reference.start();
    t.after(() => reference.close());
    const runtime = createRuntime({
      inbounds: [{ tag: 'entry', protocol: 'socks', networks: [{ port: 0 }] }],
      outbounds,
      routing,
      geodata: require('../fixtures/geodata/manifest.json'),
    });
    await runtime.start();
    t.after(() => runtime.close());
    for (const [host, port, expected] of [
      ['sub.ads.test', 80, 'block'],
      ['cn.test', 443, 'direct'],
      ['cn.test', 81, 'default'],
      ['10.2.3.4', 80, 'direct'],
      ['2001:db8::1', 80, 'direct'],
      ['198.18.1.1', 80, 'direct'],
      ['remote.test', 80, 'proxy'],
      ['unmatched.test', 80, 'default'],
    ]) {
      for (const [client, inboundTag] of [
        [runtime, 'entry'],
        [reference, undefined],
      ]) {
        const stream = await client.dial({ host, port, inboundTag });
        assert.equal((await readBytes(stream, 8)).toString().trim(), expected);
        stream.destroy();
      }
    }
  });
  test(`${kind}: DNS domain server selection and Freedom UseIPv4 agree`, async (t) => {
    const server = await dnsServer(t),
      destination = await require('../helpers').echo(t),
      port = await freePort();
    const dns = {
      hosts: { 'static.test': '127.0.0.1' },
      queryStrategy: 'UseIPv4',
      servers: [
        {
          address: server.address,
          port: server.port,
          domains: ['domain:resolved.test'],
          skipFallback: true,
        },
        'localhost',
      ],
    };
    await runCore(
      t,
      kind,
      {
        log: { loglevel: 'warning' },
        dns,
        inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } }],
        outbounds: [{ protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } }],
      },
      port,
    );
    const reference = createRuntime({
      outbounds: [{ protocol: 'socks', networks: [{ address: '127.0.0.1', port }] }],
    });
    await reference.start();
    t.after(() => reference.close());
    const runtime = createRuntime({
      dns,
      outbounds: [{ protocol: 'freedom', domainStrategy: 'UseIPv4' }],
    });
    await runtime.start();
    t.after(() => runtime.close());
    for (const client of [reference, runtime])
      for (const host of ['static.test', 'name.resolved.test']) {
        const stream = await client.dial({ host, port: destination.port });
        stream.write('dns');
        assert.equal((await readBytes(stream, 3)).toString(), 'dns');
        stream.destroy();
      }
    assert.equal(server.calls.filter((call) => call.host === 'name.resolved.test').length, 2);
  });
}
