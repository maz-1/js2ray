'use strict';
const id = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
function portalConfig(port, businessPort) {
  return {
    log: { loglevel: 'warning' },
    reverse: { portals: [{ tag: 'portal', domain: 'control.test' }] },
    inbounds: [
      {
        tag: 'bridge-entry',
        listen: '127.0.0.1',
        port,
        protocol: 'vless',
        settings: { clients: [{ id }], decryption: 'none' },
      },
      ...(businessPort
        ? [
            {
              tag: 'business',
              listen: '127.0.0.1',
              port: businessPort,
              protocol: 'dokodemo-door',
              settings: { address: 'service.test', port: 80, network: 'tcp' },
            },
          ]
        : []),
    ],
    outbounds: [{ tag: 'blocked', protocol: 'blackhole' }],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        {
          type: 'field',
          inboundTag: ['bridge-entry'],
          domain: ['full:control.test'],
          outboundTag: 'portal',
        },
        ...(businessPort
          ? [{ type: 'field', inboundTag: ['business'], outboundTag: 'portal' }]
          : []),
      ],
    },
  };
}
function bridgeConfig(port, destination) {
  return {
    reverse: { bridges: [{ tag: 'bridge', domain: 'control.test' }] },
    inbounds: [],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: { vnext: [{ address: '127.0.0.1', port, users: [{ id, encryption: 'none' }] }] },
        mux: { enabled: false },
      },
      {
        tag: 'service',
        protocol: 'freedom',
        settings: { redirect: `${destination.host}:${destination.port}` },
      },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        {
          type: 'field',
          inboundTag: ['bridge'],
          domain: ['full:control.test'],
          outboundTag: 'proxy',
        },
        {
          type: 'field',
          inboundTag: ['bridge'],
          domain: ['full:service.test'],
          outboundTag: 'service',
        },
      ],
    },
  };
}
async function waitFor(predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('Reverse state deadline exceeded.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
module.exports = { id, portalConfig, bridgeConfig, waitFor };
