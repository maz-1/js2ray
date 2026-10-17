# Native QUIC (experimental)

`network.type: "quic"` provides reliable bidirectional QUIC byte streams with integrated TLS 1.3. VLESS and VMess use their existing protocol implementations over these streams. This is raw QUIC, without HTTP/3 framing or an extra TLS wrapper.

**Full QUIC acceptance has NOT passed; native FIN resolution is pending.** The adapter uses the public native `writer` API. The experimental runtime has a confirmed connection-window-zero gate that can block a zero-byte FIN, and earlier 2 MiB proxy tests intermittently stalled after receiving the full payload without EOF. The precise branch behind those earlier stalls remains unproven; a passing run does not resolve them. The native async body API also has a destruction/Promise lifetime defect, so it is not used as an alternative. Node source and binaries have not been patched. QUIC remains experimental and is unsuitable where fully validated FIN/lifecycle behavior is required.

The final supported-runtime full test run also failed the concurrent 2 MiB VMess half-close case with `ERR_CLOSED: Transport closed while writing`. That failure remains unassigned; it has not been proved to originate in Node or to share the earlier FIN stall's cause.

The supported Node range remains `>=24 <25` for existing transports. QUIC additionally requires a build that includes native QUIC and the `--experimental-quic` flag. Development testing uses Node main commit `62ca1bae5a2ba9fd63041464e90a6073e7dd0392` (v27.0.0 pre-release). That experimental API may change. The project does not download or start another runtime automatically.

Ordinary CommonJS/ESM imports and configurations without QUIC never load `node:quic`. `checkConfig`, `normalizeConfig` and CLI `check` validate configuration independently of runtime support. Constructing a Runtime (including a manager candidate) checks **all** configured QUIC inbounds and outbounds before creating resources. An unsupported runtime throws `Js2rayError`, `code: ERR_UNSUPPORTED`, `phase: quic`; CLI `run` exits nonzero. There is no TCP fallback.

## Configuration

See [native client](../examples/vless-quic-client.json), [native server](../examples/vless-quic-server.json) and [traditional client](../examples/vless-quic-v2ray-client.json). Replace the documentation address, UUID and certificate paths. The server needs a certificate and private key; self-signed deployments must configure the client CA and matching `serverName`. Peer certificate and name validation are enabled by default. Only an explicit `rejectUnauthorized: false` (traditional `allowInsecure: true`) disables them.

`option.tls` accepts the existing `ca`, `cert`, `key` PEM strings or corresponding `*File` paths, plus `serverName`. QUIC adds `alpn`: a nonempty string array, with exactly one entry on outbound. Default client ALPN is `h2`; server defaults are `h2`, `http/1.1`. These identifiers select Node's raw QUIC application. `h3` and `h3-*` are rejected because they activate HTTP/3. HTTP path/headers and REALITY cannot be combined with QUIC. Client certificates use the same PEM/key mapping.

Traditional `streamSettings.network: "quic"` requires explicit `security: "tls"`. `quicSettings` accepts only `security: "none"`, empty `key`, and `header.type: "none"` (including omitted default fields). Other settings fail configuration validation. These fields describe **additional UDP packet encryption and disguise**, not TLS. Unlike V2Ray's implicit self-signed mode, js2ray requires explicit TLS configuration. A single traditional TLS certificate entry supports `usage: "encipherment"` (default) or `usage: "verify"` for a CA file.

## Lifecycle and limits

Each outbound dial owns one session/UDP endpoint and one bidirectional stream. Inbound sessions can carry multiple independent streams. Native flow-control windows use `maxBufferBytes`; the Duplex read and write queues and native writer budget use at most 64 KiB high-water marks, with writes divided into bounded chunks. As with other Node streams, callers must respect `write()` returning false and wait for `drain`. No unreliable QUIC Datagram substitutes for byte streams.

Connection and handshake deadlines, DNS lookup, AbortSignal, reset/error propagation, idle socket timeouts, and FIN half-close are supported. EOF requires FIN; truncation is an error. Internal normal-close hooks let the existing relay, VLESS and VMess wrappers finish pending writes and await native stream closure without calling public destroy early. QUIC has a finite 30-second native idle timeout; slow valid ACKs are not subject to an artificial one-second deadline. Public `destroy()` synchronously marks the Duplex destroyed and immediately cancels native I/O. Explicit cancellation, errors, runtime close and listener destruction tear down sessions and endpoints without waiting for ACKs. Listener `listen`, `address`, `close` and runtime/manager cleanup use the existing lifecycle interface. DNS listener names are resolved before constructing a native SocketAddress.

The adapter supplies the Duplex byte-stream and lifecycle operations used by this project, rather than every net.Socket behavior. `setNoDelay`, `setKeepAlive`, `ref` and `unref` are compatibility no-ops returning the stream: they neither configure TCP options/QUIC PING nor change endpoint process-liveness. `setTimeout` does configure an activity timer and emits `timeout` in the existing Socket style.

Shared listener rotation can update TLS certificate/key material and protocol credentials while retaining existing streams. ALPN and transport/flow-window/timeout/connection-limit changes on a shared listener fail with `ERR_ROTATION`; use a new binding for those changes. Invalid candidate TLS material is rejected before commit, and rollback restores the old identity.

## Evidence and upstream references

The automated tests `test/quic.test.js` cover real loopback transport and VLESS/VMess proxy traffic, three simultaneous 2 MiB streams, backpressure, FIN, certificate trust/name failures, cancellation/timeouts, reset, hostname binding, endpoint/Runtime resource counts and manager rotation. `test/quic-runtime.test.js` checks ordinary CJS/ESM TCP traffic without QUIC warnings and unsupported CLI behavior. QUIC-dependent tests explicitly skip on unsupported runtimes.

`test/interop/quic.test.js` tests both directions of VLESS and VMess against the pinned **V2Ray 5.14.1** executable using trusted TLS and none/none packet settings. The pinned **Xray 24.11.5** executable rejects QUIC at configuration load with `unknown transport protocol: quic`; it cannot serve as a QUIC peer. Native self-tests alone are not interoperability evidence.

- [V2Fly QUIC configuration](https://www.v2fly.org/config/transport/quic.html)
- [V2Fly QUIC dialer](https://github.com/v2fly/v2ray-core/blob/master/transport/internet/quic/dialer.go), [listener](https://github.com/v2fly/v2ray-core/blob/master/transport/internet/quic/hub.go), [packet options](https://github.com/v2fly/v2ray-core/blob/master/transport/internet/quic/config.go)
- [V2Fly TLS ALPN defaults](https://github.com/v2fly/v2ray-core/blob/master/transport/internet/tls/config.go)
- [Pinned Node QUIC API](https://github.com/nodejs/node/blob/62ca1bae5a2ba9fd63041464e90a6073e7dd0392/doc/api/quic.md), [implementation](https://github.com/nodejs/node/blob/62ca1bae5a2ba9fd63041464e90a6073e7dd0392/lib/internal/quic/quic.js)
