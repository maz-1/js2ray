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

`await runtime.openDatagram({ host, port, network: "udp", outboundTag, inboundTag, signal })` 支持 Freedom 与 VLESS 的固定目标会话。它不是任意字节流：`send(Buffer)` 发送一个数据报，异步迭代产生 `{ data, host, port }`。也可以监听 `message(data, target)`。`close()`/`destroy()` 幂等；更换目标需要另建会话。入站 SOCKS UDP 与 VMess UDP 尚未通过新运行时验收，显式拒绝。

传统 VLESS 帧最大为 65535 字节，直接 UDP 发送最多为 65507 字节；单次写入还受队列限制。对 V2Ray 5.14.1 的兼容记录仅承诺不超过 2046 字节的 UDP 数据报，该版本会拆分或丢弃较大数据报，不能将本库两端互通的长度范围套用到该参考内核。

## 错误、日志与限制

`Js2rayError` 提供稳定的 `code`、`phase`、`cause` 和 `context`。`toJSON()` 不输出原始 cause。常见代码为 `ERR_CONFIG`、`ERR_TARGET`、`ERR_STATE`、`ERR_CLOSED`、`ERR_LISTEN`、`ERR_DNS`、`ERR_TRANSPORT`、`ERR_TLS`、`ERR_AUTH`、`ERR_PROTOCOL`、`ERR_CANCELLED`、`ERR_TIMEOUT`、`ERR_LIMIT` 和 `ERR_ROUTING`。

上述结构覆盖拨号、配置和库产生的错误。已建立流的 error 事件、写回调与数据报迭代错误也统一为 Js2rayError；原始异常仅保留在 cause，序列化与日志不输出 cause。调用方仍须处理流的 error 事件。

注入的日志可以是函数，或提供 `error(record)` 的对象；旧 `debug` 回调映射为该函数。日志接收脱敏结构，不依赖 `global.log`。`diagnostic` 事件保留结构化错误供宿主检查。事件、VMess 用户账户和校验器各实例独立。

默认限制为：TCP 连接超时 10000 ms、TLS/Upgrade/协议握手阶段超时 10000 ms、空闲超时 0（关闭空闲计时）、跟踪连接 1024、未完成拨号 128、协议队列 1 MiB。整体拨号预算为连接与握手超时之和。设置非零 `idleTimeoutMs` 后，超时销毁连接。VMess 为避免重复使用分块加密 nonce，每个方向最多处理 65536 个加密块，达到上限后失败，不自动重试业务数据。

## 配置与迁移

`checkConfig(config, { baseDir })` 返回 `{ ok, diagnostics, metadata, config, capabilities }`，诊断包含字段路径、原因和修改建议。`normalizeConfig()` 在无效配置时抛出 `ERR_CONFIG`。规范化结果可以再次传给 `createRuntime()`。`redact()` 适合输出报告；不要直接输出包含凭据的原始或规范化配置。

已支持原生 `networks/users` 配置，以及传统 JSON 的单服务器 VLESS/VMess/SOCKS 出站、相应入站、基本 Freedom、TCP/WS 与 TLS 设置。VLESS 用户的 `encryption` 必须为 `none`，`flow` 为空；它与 TLS `security` 独立。`wsSettings.host` 与 `headers.Host` 必须一致。VLESS 上遗留的用户 `security: "auto"` 会被记录为已识别但无行为的元数据，其他值报错。未知行为字段不会被丢弃。

本版本有破坏性变更，因而使用 4.x 开发版本号：

- `config(data)` 返回运行时，必须 `await config(data).start()` / `await runtime.stop()`；`stop` 是 `close` 的兼容别名。
- 模块级 `on` 和共享 `protocols` 被实例事件替代。启动后可通过 `runtime.protocols.vmess.api` 使用实例的用户管理接口；它与原来的自定义 HTTP 管理 API 不等价。
- 不再创建 Linux systemd 文件，不注册宿主异常或退出处理。部署服务由操作者显式配置。
- 原 HTTP 伪装、XHTTP、自定义管理 API、`security: "zero"` 等未验收能力在新入口中明确拒绝。旧实现源码保留，但不列为新接口正式支持能力。
- `routing` 函数仅用于库模式；声明式 `field` 规则按顺序、字段内 OR/字段间 AND 匹配 inboundTag/domain/IP/port/network。支持 AsIs、IPIfNonMatch 和 IPOnDemand。域名可用 full/domain/keyword/geosite，GeoIP ! 取反与 Geosite 类别中的 ! 含义不同。Geo 资源必须提供 path/version/sha256，缺失类别或错误摘要会失败。

## DNS 与 reverse

`runtime.resolve(host, { family: 0|4|6, signal })` 返回带 family 和 TTL 的地址数组。DNS 支持 hosts/别名、A/AAAA、普通 UDP DNS/截断转 TCP、严格 TLS 的 DoH、domains 选择、expectIPs、缓存及回退。DNS 配置的 timeoutMs 为每服务器预算；整体预算随服务器数有界增长。localhost 与 https+local 本地解析；普通 DNS 和 https DoH 经配置路由。代理节点和 DNS 引导只使用 hosts/注入系统解析器。Freedom 默认 AsIs，UseIP/UseIPv4/UseIPv6 才使用内部 DNS。

DNS hosts 和服务器匹配遵循 full 优先、最长 domain 后缀其次、最先出现的 keyword、最后资源正则的顺序；相同优先级按配置顺序。禁用 fallback 或 skipFallback 后，不会强行查询第一台未匹配服务器。此优先级只决定 DNS 服务器选择，路由规则仍严格按规则顺序。

`reverse.bridges` 提供虚拟入站 tag，`reverse.portals` 提供虚拟出站 tag；引用必须存在，规则顺序由配置明确决定。Bridge domain:0 规则必须先于 Bridge 本地业务规则。控制域名只用于连接识别。Bridge 主动建连，无需代理监听；Portal 业务端口需显式配置 TCP/dokodemo-door 入站。`runtime.stats.reverse` 和 `reverse` 事件分别记录角色、传输、会话及连接/活动/排空/退避状态；active 表示控制传输可用，不代表目标业务一定可达。

Bridge 默认最多 4 条承载、每条最多 129 会话（含控制）。建连失败从 100 ms 开始指数退避，基准上限 30 秒并加 ±20% 抖动，实际最多 36 秒；已建立承载失效由有界监视周期处理。可配置 maxWorkers/maxSessions/reconnectMs。Portal 优先选非排空且会话数最少的承载；参考控制消息超过 256 累计会话后使其排空。传输故障会终止受影响业务，不重放应用字节。普通 outbound mux=false 不关闭 reverse 所需内部 Mux。Mux END 关闭整个会话，不能承诺等待写 EOF 后再返回响应的任意 TCP 半关闭协议；WS 同样没有 TCP 半关闭。runtime.close 会终止反代承载。

本地固定服务可用 Freedom redirect；进程内处理器通过 `services: { name: target => Duplex | Promise<Duplex> }` 注册，并配置 `{ protocol: 'service', service: 'name', allow: { host, port } }`，只允许这一精确目标，缺少处理器会启动失败。

`examples/combined.json` 保留脱敏参考需求，并明确修订：删除无对应入/出站的 api 规则（原失败 fixture 仍保留诊断）；添加 Bridge 本地业务规则；补齐版本化 Geo 资源。示例资源仅含合成 cn/广告/海外类别，不能当作真实国内数据库。VMess 嗅探、HTTP Blackhole 响应、Mux UDP/XUDP、Vision/Reality、透明 TCP、API 管理入站均显式不支持。

## 运行指标（P9）

`runtime.metrics` 返回独立快照，生命周期内累计，不跨实例共享。包含逻辑拨号成功/失败、错误码计数、拨号/DNS/传输耗时汇总、DNS 缓存与服务器计数、普通与 reverse Mux 当前队列及会话数、reverse 状态事件计数。TCP 字节在返回的逻辑拨号流 push/write 边界统计（写入表示提交，不表示对端确认）；UDP 在接收和成功发送边界统计。内部 DNS、reverse 控制与嵌套逻辑拨号也计入，不能解释为网卡线速字节。没有安装 data 监听器启动流动，也不保存目标、凭据或原始错误文本。

## 应用 WebSocket（P10）

`createWebSocket(runtime, url, options)` 同步返回基于 ws 的事件客户端；监听 open 后发送消息，message 提供 Buffer 和 isBinary。支持 WS/WSS、protocols、headers、origin、signal、timeoutMs、targetTls、outboundTag/inboundTag、maxPayload/maxBufferBytes/closeTimeoutMs；不自动跟随重定向。目标 TLS 独立验证，默认关闭压缩，默认 1 MiB 消息/发送队列、5 秒关闭预算。大消息按 8 KiB WebSocket 分片发送，接收方仍取得完整消息。取消覆盖拨号、Upgrade 和已建立连接；运行时关闭释放升级后的流。用 ping/pong 和 close/terminate 管理心跳与关闭，应用自行实施认证。

## DNS 联动路由（P11）

AsIs 不为规则解析域名；IPIfNonMatch 先以原始域名完整匹配，未命中再解析并重试；IPOnDemand 按序遇到 IP 条件时才解析。一次决策复用全部 A/AAAA 结果，任一地址符合即可，IP/域名等字段仍需同时满足。解析地址仅参与路由，代理请求保留原始 host（嗅探 routeOnly 保留实际目标）；显式 outboundTag 跳过规则和额外路由解析。DNS/DoH 自身目标使用 hosts/系统引导解析，避免递归；路由查询支持总拨号预算、取消和 DNS 错误，不隐式直连回退。
