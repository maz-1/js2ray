# js2ray

An embeddable, pure JavaScript proxy runtime for Node.js 24. Original implementation by [seezaara](https://github.com/seezaara/js2ray), MIT licensed.

This working tree is **4.0.0-dev.0**. It implements the runtime, TCP/TLS/WS/WSS transports, VLESS v0 TCP/traditional UDP, and VMess/SOCKS/Freedom regressions. The complete development plan is still in progress: declarative DNS/routing, Geo resources, Mux.Cool, traditional reverse, public HTTP/Undici adapters and full release acceptance remain pending. Unsupported behavior produces configuration diagnostics.

## Direct library use

```js
const { createRuntime } = require('js2ray');

const runtime = createRuntime({
  inbounds: [],
  outbounds: [{ tag: 'direct', protocol: 'freedom' }],
});
await runtime.start();
try {
  const stream = await runtime.dial({ host: 'example.com', port: 80 });
  stream.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
  for await (const chunk of stream) process.stdout.write(chunk);
} finally {
  await runtime.close({ drainTimeoutMs: 5000 });
}
```

CommonJS and ESM named imports are supported. Importing or constructing a runtime does not listen, start timers, register process handlers, resume stdin, or install services. With `inbounds: []`, `start()` and `dial()` create no local proxy listener.

Use the traditional JSON outbound in [examples/vless-wss-client.json](examples/vless-wss-client.json) for VLESS over WSS. Replace the synthetic address, UUID, Host, SNI and path with your own values; the connection address, certificate name, HTTP Host and WebSocket path are independent. Certificate chain and name verification are enabled by default.

```js
const runtime = createRuntime({ inbounds: [], outbounds: [yourVlessOutbound] });
await runtime.start();
const stream = await runtime.dial({ host: 'example.com', port: 443, outboundTag: 'proxy' });
// For an HTTPS target, wrap this stream with tls.connect({ socket: stream, ...targetTlsOptions }).
```

VLESS and Freedom expose UDP separately:

```js
const session = await runtime.openDatagram({ host: '127.0.0.1', port: 53 });
await session.send(dnsQueryBuffer);
for await (const { data, host, port } of session) {
  // Each item is exactly one datagram from the fixed target.
  break;
}
session.close();
```

Callers must respect normal stream backpressure. TCP/TLS support half-close; WebSocket `end()` closes both directions after sending queued bytes, as required by WebSocket. Applications requiring a response after write EOF should use TCP/TLS.

## CLI and checks

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:types
npm run format:check
npm run check:config
npm run test:package
node cli/index.js check examples/vless-wss-client.json
node cli/index.js run your-config.json
```

`check` validates and prints a redacted report without dialing. The CLI alone owns SIGINT/SIGTERM handling. Package installation has no system-service hooks.

```sh
npm run test:interop
```

Interoperability checks require the exact binaries in [test/fixtures/reference-cores.json](test/fixtures/reference-cores.json); missing tools or checksum mismatches fail. Set `JS2RAY_XRAY_BIN` / `JS2RAY_V2RAY_BIN`, or place the locked Windows binaries in the ignored `.test-tools/` directory. These executables are development test peers, never product dependencies. Set `JS2RAY_INTEROP_VERBOSE=1` for synthetic reference logs.

Private remote smoke testing is opt-in: `node scripts/smoke-private.js v2ray-config.json`. It selects only the `proxy` outbound, makes one example.com request, and reports status and listener count. It does not claim that the full source configuration is supported. The private configuration is ignored by Git and excluded from the package.

See [API and migration](docs/API.zh-CN.md), [compatibility and evidence](docs/IMPLEMENTATION_STATUS.zh-CN.md), and [the development plan](DEVELOPMENT_PLAN.zh-CN.md).
