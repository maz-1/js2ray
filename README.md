# js2ray

An embeddable, pure JavaScript proxy runtime for Node.js 24. Original implementation by [seezaara](https://github.com/seezaara/js2ray), MIT licensed.

This working tree is **4.0.0-dev.0**. It includes TCP/TLS/WS/WSS, VLESS TCP/traditional UDP, VMess/SOCKS/Freedom, DNS/DoH and ordered routing with pinned Geo resources, Mux.Cool TCP/UDP, XUDP packet framing, traditional Bridge/Portal reverse TCP/UDP, application WebSocket, runtime metrics, smooth configuration rotation, and Node HTTP/HTTPS and optional Undici adapters. Release acceptance is tracked in [the evidence record](docs/IMPLEMENTATION_STATUS.zh-CN.md); unsupported combinations fail explicitly.

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

Freedom, VLESS, VMess, SOCKS5, Mux and reverse expose UDP separately:

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

Mux.Cool (including reverse) uses the reference protocol's full-session END semantics. It cannot represent arbitrary TCP write-half-close protocols. Ordinary outbound Mux supports VLESS TCP and UDP; packetEncoding: "xudp" adds per-packet address framing. Reverse has its own internal Mux and works with `mux.enabled: false` on the carrier outbound.

```js
const { createHttpsAgent, createUndiciDispatcher } = require('js2ray');
const agent = createHttpsAgent(runtime, { outboundTag: 'proxy' });
// https.get('https://example.com/', { agent }, response => { ... });
agent.destroy();

const undici = require('undici'); // optional; tested with 7.30.0
const dispatcher = createUndiciDispatcher(runtime, { undici, outboundTag: 'proxy' });
const response = await undici.fetch('https://example.com/', { dispatcher });
await response.body.cancel();
await dispatcher.close();
```

[examples/combined.json](examples/combined.json) is a sanitized configuration check fixture for DNS, Geo routing, reverse and redirect. Its tiny bundled Geo resources contain synthetic test categories; replace them with your own versioned and SHA256-pinned resources for real deployment. [The migration guide](docs/API.zh-CN.md) records the removed dangling API rule and other corrections.

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

Run `npm run test:tools` to install the official fixed reference builds for Windows/Linux/macOS x64. Archive and executable SHA256 values are pinned in [the platform lock](test/fixtures/reference-platforms.json). Missing tools or checksum mismatches fail. Alternatively set `JS2RAY_XRAY_BIN` / `JS2RAY_V2RAY_BIN`. These executables are development test peers, never product dependencies. Set `JS2RAY_INTEROP_VERBOSE=1` for synthetic reference logs. `npm run test:stability` runs the separate 100-session, 30-minute acceptance test and writes machine/config/source/queue/memory/cleanup evidence to `test-results/stability.json`.

Private remote smoke testing is opt-in: `node scripts/smoke-private.js v2ray-config.json`. It selects only the `proxy` outbound, makes one example.com request, and reports status and listener count. It does not claim that the full source configuration is supported. The private configuration is ignored by Git and excluded from the package.

See [API and migration](docs/API.zh-CN.md), [compatibility and evidence](docs/IMPLEMENTATION_STATUS.zh-CN.md), and [the development plan](DEVELOPMENT_PLAN.zh-CN.md).

Configuration and credential rotation uses `createRuntimeManager`. Its HTTP/Undici adapters isolate pools by generation, while old streams drain within a budget. See the [API and rotation contract](docs/API.zh-CN.md), including same-port UUID/certificate rotation and readiness probes.

`npm run test:stability:extensions` runs a separate 100-session, 30-minute mix of TCP, UDP and application WS/WSS, with credential rotation every minute. [The P9–P13 acceptance record](docs/P9-P13_ACCEPTANCE.zh-CN.md) links the three-platform results, original load records and source hashes.
