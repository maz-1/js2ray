# 运行时接口与迁移

当前版本为 `4.0.0-dev.0`，Node.js 运行基线为 24。本文件说明已经实现的接口；完整开发计划的未完成项见 `IMPLEMENTATION_STATUS.zh-CN.md`。

## 生命周期

`createRuntime(config, { logger, lookup, baseDir, services })` 进行配置校验并创建独立实例。构造不拨号、不监听、不读写存储、不启动定时器，也不修改进程信号处理。Geo 资源在配置校验时只读加载并校验；TLS 文件在使用时读取。配置中的相对文件路径按 `baseDir` 解析，默认是当前工作目录；CLI 使用配置文件所在目录。

状态依次为 `created → starting → running → closing → closed`。`start()` 返回 Promise，只有所有显式入站成功监听才成功；失败回滚到 `closed`。启动中的并发调用共享启动结果。空入站可以正常运行。关闭后的实例不能重启，必须创建新实例。

`close({ drainTimeoutMs = 0 })` 幂等。关闭时停止接受连接并取消未完成拨号；已有连接可在给定时间内自然结束，之后强制销毁。所有跟踪的监听器、流、数据报会话、用户校验任务和存储定时器均被释放。`close()` 在 `start()` 尚未完成时也可调用。

`runtime.listenersInfo` 返回监听地址和 tag，适合测试中读取端口 0 分配的临时端口。`runtime.stats` 返回状态、跟踪流数、待完成拨号数和监听器数。内部包装流和其传输不会重复计数；一次入站转发仍同时持有入站和出站两个流。

## 字节流和数据报

`await runtime.dial({ host, port, network: "tcp", outboundTag, inboundTag, signal })` 返回二进制 `Duplex`。指定出站 tag 会绕过路由函数，未指定时使用路由结果或第一个出站。未知 tag 和拒绝决策均失败，不会隐式直连。节点列表在每次拨号时随机选择一个，传输设置与选中的地址配对，不做失败重试。

`AbortSignal` 取消未完成拨号，也在拨号成功后继续控制该连接，流关闭时移除订阅。TCP/TLS 保留半关闭。WS/WSS 遵循 WebSocket 关闭语义，`end()` 完成整个 WebSocket；不能以它表达仅关闭写方向。

返回的虚拟流提供 `setTimeout`、`setNoDelay`、`setKeepAlive`、`ref` 和 `unref`，支持标准 Node.js HTTP Agent 接口。`createHttpAgent(runtime, options)`、`createHttpsAgent(runtime, options)` 提供公共适配，HTTPS 目标在隧道内单独建立 TLS；节点 TLS 和目标 TLS 分别验证。`createUndiciConnector`、`createUndiciDispatcher(runtime, { undici, ...options })` 支持可选 Undici 7.30.0，无核心依赖和全局 dispatcher 修改。适配器选项包括固定 `outboundTag`、`inboundTag`、`signal`、`timeoutMs`、`targetTls` 及对应客户端池选项。每个工厂拥有独立连接池，目标和 TLS 参数参与池键。请求总预算由上层 AbortSignal 控制，连接和目标 TLS 共用适配器预算。Undici 单请求取消由客户端处理，尚未完成的共享建连最多持续到连接预算或适配器销毁；传入工厂 signal 可同时取消底层拨号。销毁 Node agent 或 Undici dispatcher 并关闭 runtime。

写入者必须处理 `write()` 的布尔返回值或使用 `pipeline()`。协议读队列、握手缓冲和数据报队列受 `maxBufferBytes` 限制；调用方无视标准流背压反复写入，仍可能在调用方的 Node.js Writable 队列中积压数据。

`await runtime.openDatagram({ host, port, network: "udp", outboundTag, inboundTag, signal })` 支持 Freedom、VLESS、SOCKS5、VMess、Mux/XUDP 和传统 reverse 的固定目标会话，具体范围见 P12。它不是任意字节流：`send(Buffer)` 发送一个数据报，异步迭代产生 `{ data, host, port }`。也可以监听 `message(data, target)`。`close()`/`destroy()` 幂等；更换目标需要另建会话。

传统 VLESS 帧最大为 65535 字节，直接 UDP 发送最多为 65507 字节；单次写入还受队列限制。对 V2Ray 5.14.1 的兼容记录仅承诺不超过 2046 字节的 UDP 数据报，该版本会拆分或丢弃较大数据报，不能将本库两端互通的长度范围套用到该参考内核。

## 错误、日志与限制

`Js2rayError` 提供稳定的 `code`、`phase`、`cause` 和 `context`。`toJSON()` 不输出原始 cause。常见代码为 `ERR_CONFIG`、`ERR_TARGET`、`ERR_STATE`、`ERR_CLOSED`、`ERR_LISTEN`、`ERR_DNS`、`ERR_TRANSPORT`、`ERR_TLS`、`ERR_AUTH`、`ERR_PROTOCOL`、`ERR_CANCELLED`、`ERR_TIMEOUT`、`ERR_LIMIT` 和 `ERR_ROUTING`。

上述结构覆盖拨号、配置和库产生的错误。已建立流的 error 事件、写回调与数据报迭代错误也统一为 Js2rayError；原始异常仅保留在 cause，序列化与日志不输出 cause。调用方仍须处理流的 error 事件。

注入的日志可以是函数，或提供 `error(record)` 的对象；旧 `debug` 回调映射为该函数。日志接收脱敏结构，不依赖 `global.log`。`diagnostic` 事件保留结构化错误供宿主检查。事件、VMess 用户账户和校验器各实例独立。

默认限制为：TCP 连接超时 10000 ms、TLS/Upgrade/协议握手阶段超时 10000 ms、空闲超时 0（关闭空闲计时）、跟踪连接 1024、未完成拨号 128、协议队列 1 MiB。整体拨号预算为连接与握手超时之和。设置非零 `idleTimeoutMs` 后，超时销毁连接。VMess 为避免重复使用分块加密 nonce，每个方向最多处理 65536 个加密块，达到上限后失败，不自动重试业务数据。

## 配置与迁移

`checkConfig(config, { baseDir })` 返回 `{ ok, diagnostics, metadata, config, capabilities }`，诊断包含字段路径、原因和修改建议。`normalizeConfig()` 在无效配置时抛出 `ERR_CONFIG`。规范化结果可以再次传给 `createRuntime()`。`redact()` 适合输出报告；不要直接输出包含凭据的原始或规范化配置。

已支持原生 `networks/users` 配置，以及传统 JSON 的单服务器 VLESS/VMess/SOCKS 出站、相应入站、基本 Freedom、TCP/WS 与 TLS 设置。VLESS 用户的 `encryption` 必须为 `none`，`flow` 支持空值和 P15 的 Vision；它与 TLS `security` 独立。`wsSettings.host` 与 `headers.Host` 必须一致。VLESS 上遗留的用户 `security: "auto"` 会被记录为已识别但无行为的元数据，其他值报错。未知行为字段不会被丢弃。

本版本有破坏性变更，因而使用 4.x 开发版本号：

- `config(data)` 返回运行时，必须 `await config(data).start()` / `await runtime.stop()`；`stop` 是 `close` 的兼容别名。
- 模块级 `on` 和共享 `protocols` 被实例事件替代。启动后可通过 `runtime.protocols.vmess.api` 使用实例的用户管理接口；它与原来的自定义 HTTP 管理 API 不等价。
- 不再创建 Linux systemd 文件，不注册宿主异常或退出处理。部署服务由操作者显式配置。
- 原 HTTP 伪装、自定义管理 API、`security: "zero"` 等未验收能力在新入口中明确拒绝。旧 XHTTP 源码保留，正式支持范围见 P14。
- `routing` 函数仅用于库模式；声明式 `field` 规则按顺序、字段内 OR/字段间 AND 匹配 inboundTag/domain/IP/port/network，以及 P20 的来源 IP/端口、认证用户、协议和 HTTP 属性。支持 AsIs、IPIfNonMatch 和 IPOnDemand。域名可用 full/domain/keyword/regexp/dotless/geosite 和声明的 ext 资源，GeoIP ! 取反与 Geosite 类别中的 ! 含义不同。Geo 资源必须提供 path/version/sha256，缺失类别或错误摘要会失败。

## DNS 与 reverse

`runtime.resolve(host, { family: 0|4|6, signal })` 返回带 family 和 TTL 的地址数组。DNS 支持 hosts/别名、A/AAAA、普通 UDP DNS/截断转 TCP、严格 TLS 的 DoH、domains 选择、expectIPs、缓存及回退。DNS 配置的 timeoutMs 为每服务器预算；整体预算随服务器数有界增长。localhost 与 https+local 本地解析；普通 DNS 和 https DoH 经配置路由。代理节点和 DNS 引导只使用 hosts/注入系统解析器。Freedom 默认 AsIs，UseIP/UseIPv4/UseIPv6 才使用内部 DNS。

默认 native 模式的 DNS hosts 和服务器匹配遵循 full 优先、最长 domain 后缀其次、最先出现的 keyword、最后资源正则的顺序；相同优先级按配置顺序。native/V2Ray 档案禁用 fallback 或 skipFallback 后不会强行查询首台；Xray 25.3.6 档案在候选为空时仍查询首台。此优先级只决定 DNS 服务器选择，路由规则仍严格按规则顺序。

`reverse.bridges` 提供虚拟入站 tag，`reverse.portals` 提供虚拟出站 tag；引用必须存在，规则顺序由配置明确决定。Bridge domain:0 规则必须先于 Bridge 本地业务规则。控制域名只用于连接识别。Bridge 主动建连，无需代理监听；Portal 业务端口需显式配置 TCP/dokodemo-door 入站。`runtime.stats.reverse` 和 `reverse` 事件分别记录角色、传输、会话及连接/活动/排空/退避状态；active 表示控制传输可用，不代表目标业务一定可达。

Bridge 默认最多 4 条承载、每条最多 129 会话（含控制）。建连失败从 100 ms 开始指数退避，基准上限 30 秒并加 ±20% 抖动，实际最多 36 秒；已建立承载失效由有界监视周期处理。可配置 maxWorkers/maxSessions/reconnectMs。Portal 优先选非排空且会话数最少的承载；参考控制消息超过 256 累计会话后使其排空。传输故障会终止受影响业务，不重放应用字节。普通 outbound mux=false 不关闭 reverse 所需内部 Mux。Mux END 关闭整个会话，不能承诺等待写 EOF 后再返回响应的任意 TCP 半关闭协议；WS 同样没有 TCP 半关闭。runtime.close 会终止反代承载。

本地固定服务可用 Freedom redirect；进程内处理器通过 `services: { name: target => Duplex | Promise<Duplex> }` 注册，并配置 `{ protocol: 'service', service: 'name', allow: { host, port } }`，只允许这一精确目标，缺少处理器会启动失败。

`examples/combined.json` 保留脱敏参考需求，并明确修订：删除无对应入/出站的 api 规则（原失败 fixture 仍保留诊断）；添加 Bridge 本地业务规则；补齐版本化 Geo 资源。示例资源仅含合成 cn/广告/海外类别，不能当作真实国内数据库。HTTP Blackhole 响应、透明 TCP、API 管理入站均显式不支持；Vision/REALITY 的支持边界分别见 P15/P16。

## 运行指标（P9）

`runtime.metrics` 返回独立快照，生命周期内累计，不跨实例共享。包含逻辑拨号成功/失败、错误码计数、拨号/DNS/传输耗时汇总、DNS 缓存与服务器计数、普通与 reverse Mux 当前队列及会话数、reverse 状态事件计数。TCP 字节在返回的逻辑拨号流 push/write 边界统计（写入表示提交，不表示对端确认）；UDP 在接收和成功发送边界统计。内部 DNS、reverse 控制与嵌套逻辑拨号也计入，不能解释为网卡线速字节。没有安装 data 监听器启动流动，也不保存目标、凭据或原始错误文本。

## 应用 WebSocket（P10）

`createWebSocket(runtime, url, options)` 同步返回基于 ws 的事件客户端；监听 open 后发送消息，message 提供 Buffer 和 isBinary。支持 WS/WSS、protocols、headers、origin、signal、timeoutMs、targetTls、outboundTag/inboundTag、maxPayload/maxBufferBytes/closeTimeoutMs；不自动跟随重定向。目标 TLS 独立验证，默认关闭压缩，默认 1 MiB 消息/发送队列、5 秒关闭预算。大消息按 8 KiB WebSocket 分片发送，接收方仍取得完整消息。取消覆盖拨号、Upgrade 和已建立连接；运行时关闭释放升级后的流。用 ping/pong 和 close/terminate 管理心跳与关闭，应用自行实施认证。send 在连接尚未打开时抛出 ERR_STATE，关闭后抛出或通过回调返回 ERR_CLOSED，发送回调中的网络错误也使用 Js2rayError。

## DNS 联动路由（P11）

AsIs 不为规则解析域名；IPIfNonMatch 先以原始域名完整匹配，未命中再解析并重试；IPOnDemand 按序遇到 IP 条件时才解析。一次决策复用全部 A/AAAA 结果，任一地址符合即可，IP/域名等字段仍需同时满足。解析地址仅参与路由，代理请求保留原始 host（嗅探 routeOnly 保留实际目标）；显式 outboundTag 跳过规则和额外路由解析。DNS/DoH 自身目标使用 hosts/系统引导解析，避免递归；路由查询支持总拨号预算、取消和 DNS 错误，不隐式直连回退。

## UDP 扩展（P12）

`openDatagram` 继续使用固定逻辑目标，支持 Freedom、VLESS 传统 UDP、VMess、SOCKS5、VLESS Mux 和传统 reverse。SOCKS 入站显式启用 `udp: true`（传统 JSON 为 settings.udp），控制承载仅 TCP/TLS；认证成功后分配独立 UDP 端口，限制来源为控制连接的 IP，并锁定首个有效数据报的源端口；控制关闭即释放关联。分片 SOCKS UDP 包丢弃。单关联最多 128 个目标，单会话队列最多 1024 个数据报且受 maxBufferBytes 限制。

VLESS 出站 `packetEncoding: "xudp"` 使用 Xray 的 Mux UDP 封装及每包地址；未启用普通 Mux 时每个数据报会话独占承载。入站接受 XUDP NEW 全局 ID 字段和 KEEP 每包地址，但不跨断开的承载恢复 NAT 身份或重放数据。Mux/reverse 保留数据报边界，慢消费者超限只关闭对应会话。VMess 每包独立编码，不按 TCP 块拆包；安全上限 65455 字节。Freedom UDP 上限 65507，SOCKS 上限需再减地址头；Mux/VLESS 帧最大 65535。实际互通上限受参考内核限制：固定 V2Ray 大包边界仍不由 JS 自测外推，新增对照使用 1024 字节，Xray 使用 1400 字节；JS 两端另测空包和大包（Windows/Linux 为 60000 字节，macOS 读取 net.inet.udp.maxdgram 并扣除 SOCKS 头部预算）；另外用内存承载验证 65535 字节帧，不依赖系统 UDP 上限。内核 EMSGSIZE 转为结构化 ERR_TRANSPORT，VMess UDP 遇到对端 EOF 会结束等待，不保留 TCP 半关闭造成悬挂。UDP 网络本身仍可丢包；库不自动重试。

## 配置与凭据轮换（P13）

`createRuntimeManager(config, options)` 提供与 runtime 相同的 start/dial/openDatagram/resolve/close，并增加 generation、逐代 metrics 与 rotate。`await manager.rotate(config, { runtimeOptions, ready, signal, timeoutMs: 20000, drainTimeoutMs: 5000 })` 在候选配置完成校验、资源启动和可选 ready 探测后切换，返回 `{ generation, drained }`；await drained 等待旧代排空或强制关闭。候选失败、取消或超时保留当前代。ready 接收候选 Runtime 和 AbortSignal，远端认证/业务可达性应由宿主通过该回调实际探测；仅 start 成功不代表远端业务可达。

同地址端口且同传输类型的监听器由管理器持有，提交时切换认证/规则和 TLS 证书上下文；旧的已认证连接继续使用旧配置。同端口更换 TCP/WS 或有无 TLS 会明确拒绝并回滚，可通过不同端口预先启动迁移。新增监听器在提交前不接受业务；删除监听器停止接受新连接，旧连接限时排空。VMess/VLESS UUID 与 TLS/WSS 证书轮换均有真实连接测试。

createHttpAgent/createHttpsAgent、createUndiciDispatcher 和 createWebSocket 接受 manager。HTTP 池按代隔离，正在执行及已排队的旧请求完成后关闭旧池，新请求使用新代。自行持有 raw Undici connector 或自建客户端池时，由宿主管理池的代次和关闭；普通 connector 不提供池隔离。UDP/应用 WebSocket 旧会话继续使用旧代直至结束或预算耗尽，不迁移或重放业务字节。默认最多 4 个待排空代（maxRetiringGenerations 可设 1–32），轮换排队最多 128 项，超过时返回 ERR_LIMIT。

文件存储只允许已提交代写入；失败候选和旧代关闭不会覆盖新代文件。流量和错误指标按代记录，不合并不同代的 VMess 动态计数。manager.close 强制关闭所有代并取消候选；业务需先停止接收新请求再调用 close。

```js
const { createRuntimeManager, createHttpAgent } = require('js2ray');
const manager = createRuntimeManager(initialConfig);
await manager.start();
const agent = createHttpAgent(manager);
const result = await manager.rotate(nextConfig, {
  ready: async (candidate, signal) => {
    // 在这里执行宿主选择的实际业务探测，失败时抛出异常。
  },
  drainTimeoutMs: 5000,
});
await result.drained;
agent.destroy();
await manager.close();
```

## XHTTP（P14）

传输使用 `{ type: 'xhttp', address, port, option }`。`option` 接受 `host`、`path`、`mode`、`httpVersion`、`headers`、`tls`、`xPaddingBytes`、`noGRPCHeader`、`noSSEHeader`、`scMaxEachPostBytes`、`scMaxBufferedPosts`、`scStreamUpServerSecs`。地址、TLS 证书名和 HTTP Host 独立；证书默认严格验证。自定义请求头仅用于出站，Host、Referer、长度、连接及 HTTP/2 保留头由传输管理。

`httpVersion` 为 `1.1`、`2` 或 `auto`（默认）。出站 auto 在 TLS 上按 ALPN 选择 HTTP/2 或 HTTP/1.1，明文使用 HTTP/1.1；显式 2 配合无 TLS 即为 prior-knowledge h2c。TLS 入站 auto 同时接受两种 HTTP 版本，明文入站 auto 使用 HTTP/1.1；h2c 需显式设置 2。`mode` 为 `packet-up`、`stream-up`、`stream-one` 或 auto；出站 auto 在 HTTP/2 使用 stream-up、HTTP/1.1 使用 packet-up；入站 auto 接受三种模式，stream-up 入站也接受 stream-one。

path 自动补末尾 `/`，查询串保留。随机 UUID 关联 packet-up/stream-up 上下行；分包序号排序并拒绝重复、非法序号和超出窗口的包。缺包、未配对会话、单包上传、响应头和分包确认的等待受 handshakeTimeoutMs 限制。xPaddingBytes 默认 100-1000，支持 1–4096 内整数或范围；入站同时接受 Referer 和旧查询参数 padding。scMaxEachPostBytes 默认 1000000，实际还受 maxBufferBytes 限制；scMaxBufferedPosts 默认 30、上限 128。stream-up 响应定期发送 padding 保活，scStreamUpServerSecs 默认 30 秒，-1 关闭；该响应不进入业务流。

P18 起，同一 Runtime、网络配置及代次内的逻辑出站共享 XMUX 客户端池；关闭逻辑连接释放其请求和租约，Runtime 关闭释放整个池、物理连接和计时器。不同实例或配置代不复用。HTTP/2 入站可在一条物理连接上承载多个逻辑会话，单个 RST_STREAM 只终止对应会话。可读端暂停会传递到 HTTP body/HTTP2 流控；顺序 packet-up 确认等待可读队列空间。队列超限返回结构化错误，不自动重试或重放业务数据。

XHTTP 按整个逻辑连接关闭，不能承诺任意 TCP 半关闭协议；packet-up 的 end 结束整个连接，流式模式在对端结束后关闭。物理连接故障或运行时关闭终止受影响会话；P18 的 HTTP/2 GOAWAY 停止复用该客户端，已接受的流继续排空，新流及 packet-up 后续上行使用新连接。业务字节不自动重放。Manager 同端口轮换支持路径、凭据、TLS 材料和资源限制切换，已配对会话保留原路径及参数；同端口 HTTP 版本或 TLS 开关变更会拒绝并回滚。

传统 JSON 接受 `streamSettings.network: 'xhttp'`、`xhttpSettings` 和 TLS `alpn`（h2/http/1.1）。xhttpSettings.extra 存在时仅保留外层 host/path/mode/extra，不允许重叠参数；未知行为参数报错。HTTP/3 暂缓；XHTTP 与 REALITY 的组合、XHTTP 浏览器指纹未实现；完整能力不能由同名旧代码推断。固定 Xray 25.3.6 的 VLESS TCP 互通覆盖 HTTP/1.1（含 TLS）及 TLS HTTP/2 的三模式两个方向；另测 js2ray h2c 客户端到 Xray 服务端。该版本 Xray 无 TLS 出站固定选择 HTTP/1.1，因此反方向 HTTP/2 使用严格 TLS 验收。

### 上下行分离（P19）

出站 `option.downloadSettings` 接受一个完整的原生 XHTTP Network：`{ type: 'xhttp', address, port, option }`。上下行分别配置地址、TLS/SNI、Host、path、查询串、请求头、HTTP 版本及 XMUX；下行不继承上行配置，省略值按该侧默认值处理。连接上传模式由上行配置及协商出的 HTTP 版本决定；下行始终使用带相同会话 UUID 的 GET。支持 packet-up、stream-up 和 auto；stream-one 只有一个请求，不能与分离配置同时使用。仅出站支持，拒绝嵌套 downloadSettings、HTTP/3、REALITY 及非 XHTTP 下行。

传统 JSON 的 `xhttpSettings.downloadSettings` 或 `extra.downloadSettings` 使用完整的 `{ address, port, network: 'xhttp', security, tlsSettings, xhttpSettings }`，TLS ALPN 映射为该侧 HTTP 版本。示例见 `examples/vless-xhttp-split-client.json`。两条入口须汇聚到同一服务端 XHTTP 监听器的会话，反向代理可重写不同的路径和 Host；本实现不会在独立服务端间同步会话，也不自动发现共享后端。

每侧使用独立 XMUX 池、TLS 信任和 DNS 引导上下文，并随 Runtime/配置代隔离。packet-up 的上传预算退役只更换上行客户端，既有下行 GET 保持不变；HTTP/2 GOAWAY 排空已接受请求。任一正在使用的物理客户端失效会关闭该逻辑连接并释放另一侧租约；取消、失败、超时及轮换均不重放业务字节。`metrics.xhttp` 汇总两侧池；不额外保存地址或凭据。配置报告也脱敏嵌套端点及端口。

反向代理必须保持流式请求/响应、禁止缓存和自动重放，并将两侧会话路由到同一后端。固定 Caddy 2.10.0 对照使用 `enable_full_duplex: true`、`flush_interval: -1`，并向 HTTP/1.1 后端设置 `Connection: close`，避免 Go HTTP 服务在发送响应头前等待上传结束。各入口明确限制 ALPN；固定 Xray 的 HTTP/1 客户端指纹可能仍提供 h2，不能让入口协商 h2 后按 HTTP/1 收发。测试仅启用 h1/h2，不监听 QUIC。Caddy 仅作为独立测试工具，不进入产品包或运行依赖。

### XMUX（P18）

原生 `network.option.xmux` 与传统 `xhttpSettings.xmux` / `xhttpSettings.extra.xmux` 支持固定 Xray 25.3.6 的完整六字段。它管理 XHTTP 的 HTTP 客户端复用，与协议层 Mux.Cool 分别配置；服务端接受并校验同一字段，但不会把客户端调度参数解释为入站限制。

| 字段             | 语义                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| maxConcurrency   | 每个 HTTP 客户端同时承载的逻辑连接数；达到后新建客户端。范围在池创建时取值。                                                                                   |
| maxConnections   | 先建立指定数量的可复用 HTTP 客户端，再随机选择；不能与正值 maxConcurrency 同时配置。                                                                           |
| cMaxReuseTimes   | 每个客户端累计分配次数，含首次；达到后停止向新逻辑连接分配。packet-up 换上行客户端也占一次分配，不占逻辑并发数。                                               |
| hMaxRequestTimes | 每个客户端累计 HTTP 请求预算；GET、POST 分别计数，packet-up 后续 POST 用尽预算后换客户端。stream-up 已预留的 GET/POST 配对完整创建，极小预算可被配对超出一次。 |
| hMaxReusableSecs | 客户端从创建起可接受新逻辑连接及 packet-up 新 POST 的秒数；到期后已建立流继续排空。                                                                            |
| hKeepAlivePeriod | HTTP/2 读取空闲时 PING 间隔秒数，0 使用 45 秒，负数关闭；HTTP/1.1 无 HTTP/2 PING。                                                                             |

前五项接受非负整数或闭区间字符串（如 `"4-8"`），范围为 0–2147483647，0 表示不限。后三种客户端预算在每个客户端创建时分别抽样。hKeepAlivePeriod 接受绝对值不超过 2147483647 的整数，不接受范围。六项全零（包括省略或 `{}`）时使用 maxConcurrency=`"16-32"`、hMaxRequestTimes=`"600-900"`、hMaxReusableSecs=`"1800-3000"`，其余为 0；任意非零项会关闭这组三项隐式默认值。

每个 Runtime 的每个网络配置单独持有池；不同出站、凭据、TLS 信任、DNS 上下文、Runtime 或 Manager 代次不共用池。HTTP/2 同一客户端共享一个 session，并根据对端 SETTINGS 的流容量选择客户端；maxConnections 不承诺物理 TCP 连接数硬上限。HTTP/1.1 无流多路复用，GET/流式 POST 各占连接，packet-up 的有限 POST 连接可跨逻辑会话复用；同一客户端的 agent 最多持有 `2 * maxConnections`（运行时 limits 的值，最少 2）个活跃 socket、2 个空闲 socket。无使用者的客户端 90 秒后回收，空闲资源和保活计时器不阻止进程退出；Runtime.close 关闭整个池。

`runtime.metrics.xhttp` 暴露 clients/draining/active/sockets/pending，以及累计 created/retired/requests/pings/failures，不含目标或凭据。active 是各池的并发预留数：未分离时每条逻辑连接预留一次，分离时上下行各预留一次，因此不能直接作为用户连接数；未分离的 packet-up 临时上行租约不增加 active。requests 为实际创建的 HTTP 请求数，pings 为成功收到 ACK 的 PING 数，failures 为异常关闭的客户端数。验收命令为 `node --test test/xmux.test.js`、`node --test test/interop/xmux.test.js` 和 `npm run test:stability:xmux`。

HTTP/2 由 nghttp2 原生读取 socket，不依赖 JavaScript `data` 事件判断空闲。保活使用公开的 socket.bytesRead 观测入站 DATA 和控制帧，不增加 body 消费者、不改变背压；观测周期为 min(1 秒, 保活周期/4)，实际空闲 PING 可相应延后。持续入站数据会推迟 PING，只有出站写入时不会推迟。

## Vision（P15）

VLESS 用户设置 `flow: 'xtls-rprx-vision'`，所有节点必须使用原始 TCP 与 TLS 或 P16 的 REALITY。出站及含 Vision 用户的入站监听器强制外层 TLS 1.3；同一监听器的空 flow 用户也使用 TLS 1.3，继续按普通 VLESS 处理。支持原生配置及传统 JSON 的 users/clients.flow，示例见 `examples/vless-vision-client.json`。WS/XHTTP、TCP Mux 和未知 flow 明确拒绝。

两个方向分别处理 UUID、Continue/End/Direct、内容长度与随机填充。VLESS 请求/响应头与初始空填充合并写入，避免独立暴露短头部。内层 TLS 1.3 协商及符合条件的密码套件触发 Direct；普通流量、TLS 1.2 保留外层 TLS。Direct 只绕过外层封装，内层目标 TLS 继续验证和加密。实现只使用 Node.js 公开 Duplex、TLS 和内存 keylog 事件，读取秘密不写文件或日志；切换前以记录明文字节数和解析器确认阻止后续原始字节进入 OpenSSL。外层 AES-128-GCM、AES-256-GCM、ChaCha20-Poly1305 及切换前 KeyUpdate 有测试。Direct 写方向建立后若 TLS 试图追加控制记录，连接以 ERR_TLS 结束，避免把控制记录混入业务流。

UDP 自动采用独占承载的 XUDP，默认拒绝 UDP/443；仅出站可以设置 `xtls-rprx-vision-udp443` 显式允许，线上仍发送基础 Vision flow。Vision 入站的 Mux 只接受 UDP，传统 UDP 命令及 TCP Mux 会话拒绝。与 Xray 25.3.6 的 UDP 对照使用 1400 字节，并明确验证 8193 字节被该内核拒绝；不能把 JS 两端的大包能力外推到参考内核，空 UDP 包也不属于该版本 Xray 的互通承诺。

`runtime.metrics` 增加 `visionSessions`、`visionReadSwitches`、`visionWriteSwitches`；这些是实例累计值，业务字节统计不包含填充。Direct 保留 TCP 半关闭、取消、背压及连接关闭；无需原生模块、外部内核进程或 WASM，不提供 Linux splice 优化。同端口 Vision 监听器支持用户及证书轮换、已认证旧流排空和失败回滚；普通 TLS 监听器与 Vision 记录门控监听器之间的类型切换需使用不同端口，原端口上的不兼容变更返回 ERR_ROTATION。

## REALITY（P16）

VLESS 原始 TCP 的 `network.option.reality` 与 `option.tls` 互斥。客户端设置 `publicKey`、`serverName`、`shortId`，可选 `fingerprint: 'chrome120'`（默认，`chrome` 是同一固定模板的别名）及 `clientVersion: '4.0.0'`。密钥为规范的 32 字节 base64url，short ID 为 0–8 字节偶数位十六进制；域名规范化为小写 ASCII。地址与 SNI 独立，必须显式指定 SNI。传统 JSON 接受 `security: 'reality'`、`realitySettings` 和 `network: 'tcp'|'raw'`；合成客户端示例为 `examples/vless-reality-client.json`。

服务端设置 `privateKey`、`serverNames`、`shortIds` 和固定 `dest: 'host:port'`（IPv6 使用 `[host]:port`）。名称和 short ID 列表分别为 1–128 项，short ID 按补零后的八字节值检查重复。可选 `minClientVer`/`maxClientVer` 为三个版本字节，`maxTimeDiff` 为毫秒，0–86400000，默认 0 与固定 Xray 一致，表示不检查时间差；需要时钟窗口时显式设置，例如 60000。`xver` 仅支持 0，`show` 仅支持 false。密钥与 short ID 在 CLI/日志脱敏；不产生密钥文件、keylog 或凭据日志。

客户端执行 X25519、ClientHello Session ID 的 AEAD 认证、TLS 1.3 密钥派生、REALITY Ed25519 证书 HMAC、CertificateVerify 和 Finished 校验；任何一项失败都在发送 VLESS 请求或业务字节前关闭。不会用公开 CA 证书替代 REALITY 认证，也不实现 Xray 的 spiderX 爬虫回退。密码套件支持 AES-128-GCM/SHA256、AES-256-GCM/SHA384 和 ChaCha20-Poly1305/SHA256；证书 Brotli 解压及握手/记录缓冲均有上限。记录层支持序号、认证、TLS 填充、close_notify、KeyUpdate 和半关闭，不支持 TLS 会话恢复与 0-RTT。

服务端将收到的 ClientHello 发送到固定 dest，认证通过后镜像目标 ServerHello 与首个加密握手 flight 的记录长度，替换 X25519 与 REALITY 认证材料。目标必须接受所提供 SNI、TLS 1.3、X25519、上述套件和兼容 CCS，不能要求 HelloRetryRequest 或客户端证书；握手 flight 必须为单个合并记录或 EE/Certificate/CertificateVerify/Finished 四记录布局，且容纳 REALITY 握手材料。不镜像额外 SessionTicket 的时序，也不承诺任意网站的流量特征。目标域名仅经 hosts/系统引导解析，避免代理递归。未认证及畸形 ClientHello 的已消费与剩余字节完整转发到固定 dest，普通 TLS 客户端可实际访问该目标。未完成握手及转发连接受连接数、握手期限、缓冲限制约束；未认证转发的空闲预算使用非零 idleTimeoutMs，否则使用 handshakeTimeoutMs。

空 flow 支持普通 VLESS TCP/传统 UDP；Vision 支持真实双向 Direct 与 XUDP，内层 TLS 1.2/普通流量保持外层记录保护。Vision 指标和 UDP/443 策略沿用 P15。同端口可原子轮换 REALITY 私钥、short IDs、用户、dest、名称和限制，已认证旧流继续排空；候选失败保留当前配置。TLS 与 REALITY 监听类型切换需迁移端口。WS/XHTTP REALITY、PQ/Kyber、任意 uTLS 指纹、PROXY protocol、spiderX 均明确拒绝。固定 Chrome 120 模板的对照只证明与固定版本字段一致，不代表最新版浏览器指纹或抗识别保证。测试与实际证据见 [P16 验收](P16_REALITY_ACCEPTANCE.zh-CN.md)。

## 入站握手与验收加固（P17）

`runtime.metrics.inbound` 按物理连接统计 accepted/active/pending、succeeded/failed/rejected/cancelled、fallback/fallbackActive、coverDials/coverFailures 与 diagnosticsSuppressed。succeeded 表示传输握手已完成，不代替 VLESS/VMess/SOCKS 应用协议认证成功；应用协议失败继续进入稳定 errors 计数。REALITY 未认证流量访问固定 cover 属于 fallback，不计为错误；已连接后的 cover 握手失败属于 failed，只有 TCP 建连失败才增加 coverFailures。关闭取消和限额拒绝有独立结果，每条物理连接只有一次传输握手结果。错误计数不采样，握手 diagnostic/logger 输出每实例每秒最多 8 项，其余增加 diagnosticsSuppressed；不记录对端地址、SNI、密钥或原始异常文本。轮换前已接受的连接保留原指标归属。

`metrics.transport` 提供 streams、readableBytes、writableBytes、bufferedBytes，统计 Runtime 持有的传输流可见读写队列、REALITY 记录/控制缓冲和 Vision 门控/底层 Socket 队列。它不等同于内核或 OpenSSL 内部内存；与逻辑流队列可能有重叠，不能相加解释为网卡字节。关闭后对应流与队列归零。

`js2ray check-cover server-config.json` 校验配置并主动连接每个 REALITY 入站的固定 dest，逐个检查所配置 serverNames 的 TLS 1.3/X25519、CCS、单记录/四记录布局及可容纳认证 flight 的长度。它不创建业务入站监听，不输出目标名称或凭据；成功表示当前模板可镜像，不代替实际节点认证和业务验收。HRR、缺少 CCS、空间不足、截断和超时明确失败。固定 Node/OpenSSL cover 与 Xray 25.3.6 Go TLS cover 均有测试。

长时脚本 `npm run test:stability:transports` 默认 100 会话/30 分钟，混合 XHTTP 两种 HTTP 版本三模式、Vision TLS、REALITY 空 flow/Vision、TLS 1.2/1.3 和普通流量，包含慢消费者、每分钟两端轮换、cover 故障、逐次字节比较和读写 Direct 断言。每秒采集队列/内存，每分钟保存样本，记录延迟直方图与最大值；保留原始 JSON、源码/配置摘要和关闭状态。少于 30 分钟的脚本检查标记 formalAcceptance=false，不计作正式长时证据。P17 的实际三平台结果见验收记录。

## 常用路由与 DNS 兼容（P20）

完整字段、固定版本差异、JS 扩展和边界见 [P20 支持矩阵](P20_POLICY_COMPATIBILITY.zh-CN.md)。根字段 compatibility 选择 native、v2ray-5.14.1 或 xray-25.3.6；传统 JSON 与原生字段均接受。来源和用户使用已认证入站上下文；HTTP/TLS/BitTorrent 需开启嗅探，VMess 已支持纯文本嗅探与首包保序。库 dial/openDatagram 可传入 sourceIP、sourcePort、userEmail、protocol、attrs，调用者负责上下文可信性。实际代理请求不能伪造这些外层属性。

支持 ECS、TCP/local DNS、每服务器查询/缓存/回退/标签等控制；正则通过纯 JS re2js 2.8.6 执行，ws 8.22.0 继续用于 WebSocket。HTTP/3、DoQ 暂缓。示例见 examples/policy-compat.json。
