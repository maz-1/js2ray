# js2ray 更新规划

规划日期：2026 年 10 月 15 日。

源码基线：`f316d558839da35fb1efae9979492a5d1f0c81a8`，`package.json` 版本 `3.0.3`。

目标是把当前 js2ray 更新为可独立使用、可嵌入其他 Node.js 程序的代理协议库，补齐 VLESS、可靠的 WS/TLS 传输、V2Ray 传统反向代理，以及参考配置需要的 DNS 和分流能力。库调用方能够直接取得连接流，无须在本地开启 SOCKS 或 HTTP 代理端口。

所有开发和验收首先在 js2ray 内完成。达到本文的完整版本门槛后，再单独规划 ChatRoom 整合；本轮不修改 ChatRoom，也不将其作为 js2ray 的测试依赖。

## 1 首个完整版本的边界

“特性完整”指下列目标能力全部达到验收标准，不代表实现所有 V2Ray、Xray 协议和配置项。

| 能力 | 首个完整版本要求 | 完成依据 |
| --- | --- | --- |
| 纯 Node.js 运行 | 使用 JavaScript 和 Node.js 内置网络、TLS、加密接口；允许纯 JavaScript 依赖 | 发布包运行时不下载或启动其他内核，不依赖原生扩展或 WASM 内核 |
| 库模式 | 多实例、显式生命周期、配置校验、结构化错误、可注入日志 | 导入无运行副作用，实例和资源彼此隔离 |
| 无本地代理端口 | `inbounds: []` 时直接拨号并取得双向流 | 库模式测试确认没有创建本地 TCP/UDP 监听器 |
| VLESS | v0 入站和出站，`encryption/decryption: "none"`，TCP 和传统 UDP 数据报 | 与锁定版本的官方实现分别验证客户端和服务端互通 |
| 传输 | TCP、TCP 上的 TLS、WS、WSS；域名、IPv4、IPv6 | SNI、Host、连接地址和路径可分别设置，证书校验正确 |
| 基础入站和出站 | 保留 VMess、SOCKS、Freedom；新增 Blackhole 和必要的 TCP 转发入站 | 原有主要用法有回归测试，新增协议通过独立验收 |
| Mux.Cool | TCP 会话复用及传统 reverse 依赖的流与控制能力 | 官方实现互通、隔离、背压、关闭与异常测试通过 |
| 传统 reverse | `reverse.bridges` 与 `reverse.portals`，TCP 业务转发 | js2ray 与参考内核交叉组网，具备重连和资源上限 |
| 配置适配 | 原 js2ray 配置与参考文件使用的 V2Ray 传统 JSON 子集 | 生成规范化配置及诊断，未支持的行为字段明确报错 |
| DNS 和分流 | 参考文件用到的 hosts、DNS 服务器选择、GeoIP、Geosite、路由字段及 HTTP/TLS 嗅探 | 固定资源和请求集下，决策与参考内核一致 |
| 通用 HTTP 接入 | Node.js HTTP/HTTPS Agent 以及可选 Undici 适配 | 无本地代理监听端口，支持 HTTPS 目标的隧道内 TLS |
| 发布质量 | Windows、Linux、macOS 回归，示例、类型声明、兼容矩阵和迁移说明 | 发布包安装与运行验收全部通过 |

首轮运行时基线采用 Node.js 24，其他 Node.js 主版本在 CI 验证后再列入正式支持矩阵。

后续独立扩展项包括 XHTTP 的 HTTP/3、gRPC、QUIC、TUN、透明代理和 V2Ray gRPC 管理 API。XUDP 数据报封装与配置轮换已在 P12/P13 扩展；P14 新增 XHTTP 的 HTTP/1.1、HTTP/2 三模式，P15 实现原始 TLS 1.3 上的 Vision，P16 扩展 REALITY 及 Vision 组合，P18 补齐 XMUX 六字段，P19 增加独立上下行入口，范围见 API 文档。原 HTTP 伪装及旧 XHTTP 源码保留；正式支持以新接口和对应固定版本互通验收为准。未完成能力返回明确诊断。

HTTP/3 当前状态（2026-10-15）：**暂缓实现，等待 Node.js 原生 QUIC 支持稳定后再启动**。后续优先采用 Node.js 原生实现；现阶段不启动定制 Node 构建、HTTP/3 原型或正式实现。恢复前重新核对上游 API 稳定性、目标发行包及三平台可用性，再锁定运行时版本并完成固定 Xray 双向互通和完整验收。已有能力探测仅提供信息，不代表 HTTP/3 支持。详见 [HTTP/3 可行性评估](docs/HTTP3_FEASIBILITY.zh-CN.md)。

## 2 历史源码基线与当时的优先修复项

本节记录最初源码基线，不能当作 P0–P19 之后的当前能力说明。最初仓库提供了协议层与传输层的基本分离，但没有完整的 VLESS 和传统 reverse 实现，也没有测试脚本及测试目录；当前状态以各阶段验收及 API 文档为准。

| 位置 | 当前情况 | 更新方向 |
| --- | --- | --- |
| `index.js` | 注册 VMess、SOCKS；出站逻辑在内部；公开配置接口只返回 start/stop | 增加实例化运行时及独立拨号接口 |
| `index.js`、`core/event.js` | `global.log` 和模块单例影响实例隔离 | 日志、事件、协议注册表和连接状态归属实例 |
| `core/storage.js` | 导入即创建定时器、恢复 stdin、注册信号及异常处理，部分处理调用 `process.exit()` | 存储服务显式创建和关闭；退出信号由 CLI 管理 |
| `protocols/vmess/store.js`、`validator.js` | 依赖共享存储，校验器包含周期任务 | 每实例持有存储及周期任务，并纳入关闭流程 |
| `core/remoteNetwork.js` | WSS URL 直接拼接 `serverName + port`；DNS 覆盖写死 IPv4；返回值形态不统一 | 修复地址构造，统一传输流、DNS、超时与错误接口 |
| `core/remoteNetwork.js` | 多处 write/send 未统一传递背压，存在固定超时和吞错路径 | 使用有界队列、标准流及可配置的连接和空闲超时 |
| `protocols/vmess/client.js` | 多 network 分支存在 `Ddata` 拼写错误 | 用回归用例修复，并明确节点和传输选择策略 |
| `protocols/vmess/server.js` | 命令检查排除 `0x03`，其后的部分 Mux UDP 分支不可达 | 以完整协议状态机替代零散分支，不能据此认定已有 Mux 支持 |
| `protocols/bridge.js` | 只是本地连接与远端连接之间的转发，入口相关逻辑被注释 | 保留为普通转发概念；传统 reverse 使用独立模块 |
| `core/utils.js` | 地址编解码承担协议公共职责 | 独立验证 IPv4、IPv6、域名长度和异常输入 |
| `install.js`、`package.json` | 安装脚本在 Linux 写 systemd 服务 | 普通包安装不修改系统服务；服务部署作为显式 CLI 操作 |

先建立能重现这些问题的测试，再逐项修改。现有 VMess、SOCKS 和 Freedom 路径也需要完成回归，才能列入新版本兼容承诺。

## 3 运行时与连接接口

### 运行时职责

建议沿用 JavaScript 实现，补充 JSDoc 和 TypeScript 声明。保留 CommonJS 使用方式，并提供清晰的 ESM 消费入口，避免在协议改造的同时进行全库语言迁移。

运行时分成以下模块，目录名称可在 P0 冻结接口时调整。

| 模块 | 职责 |
| --- | --- |
| `runtime/` | 实例生命周期、协议注册、连接跟踪、限制、事件和日志 |
| `config/` | 原生配置、V2Ray JSON 适配、规范化、校验和能力诊断 |
| `transports/` | TCP、TLS、WS、WSS，统一输出双向流 |
| `protocols/` | VMess、VLESS、SOCKS、Freedom、Blackhole、TCP 转发 |
| `routing/`、`dns/`、`geodata/` | 路由匹配、解析策略、资源加载与嗅探 |
| `mux/`、`reverse/` | Mux.Cool 会话及传统 Bridge/Portal 控制和调度 |
| `adapters/` | Node.js HTTP/HTTPS Agent 和可选 Undici 接口 |
| `cli/` | 显式监听、配置检查、服务部署及信号处理 |

协议只处理自身编码和状态；传输只处理字节流连接。路由通过协议无关的目标及元数据选择出站，避免 VLESS、VMess、HTTP 适配器分别实现一套路由。

### 建议的库接口

以下代码是接口草案，待 P0 冻结，不表示当前已经存在这些 API。

```js
const runtime = createRuntime(config, { logger });
await runtime.start();

const stream = await runtime.dial({
  host: "example.com",
  port: 443,
  network: "tcp",
  outboundTag: "proxy",
  signal,
});

// 调用方直接读写 stream，或交给 HTTP 适配器。
await runtime.close({ drainTimeoutMs: 5000 });
```

- `createRuntime()` 只解析配置和建立实例，不创建连接、监听器、定时器或进程信号处理器。
- `start()` 只启动显式配置的入站、reverse 和后台任务。没有入站时也能运行；普通出站按需建立连接。
- `dial()` 返回保持二进制内容和顺序的 `Duplex`。显式 `outboundTag` 固定出站，省略时执行正常路由；保留 `inboundTag` 等上下文供内部路由使用。
- UDP 使用独立的数据报接口，保留每个数据报的边界及目标信息，不能伪装成任意字节流。
- `close()` 异步且幂等，取消未完成拨号，限时排空后释放连接、监听器、会话、定时器和可选存储资源。
- 明确 created、starting、running、closing、closed 状态及并发调用行为。关闭后的运行时通过新建实例重新启动。
- 错误使用稳定的 code、阶段、cause 和脱敏上下文，覆盖配置、DNS、传输、认证、协议、超时和关闭等类别。

反向业务流同时支持按显式服务 tag 调用进程内处理器，以及经 Freedom redirect 转发到已有服务。处理器收到可信的隧道来源元数据；该接口不绑定某个应用的路由或认证实现。

原 `config().start()/stop()` 用兼容层接入新运行时。异步启动与关闭语义如果无法保持，应放在主版本升级中说明，不能让旧接口悄悄提前返回成功。

## 4 配置兼容与参考样例

### 规范化和诊断

同时接受原 js2ray 配置及 V2Ray 传统 JSON，但都先转换为统一内部模型，避免协议实现直接依赖两种配置格式。旧 `routing` 函数仅在库模式保留；CLI JSON 使用声明式规则。

适配器必须区分三个结果：已支持、明确识别的无行为元数据、尚未支持的行为。未知协议、传输、flow、安全模式和路由条件不得静默忽略。诊断包含字段路径、原因和建议修改，输出时隐藏凭据。

重点映射和校验：

1. `streamSettings.network/security`、`tlsSettings`、`wsSettings` 转换为独立传输配置。`wsSettings.host` 与 `headers.Host` 同时出现时明确优先级；冲突配置应报错。
2. VLESS 用户的 `encryption` 与传输层 `security` 分开处理。VMess 遗留的用户 `security` 字段单独诊断，不能解释为 VLESS 加密或 TLS 模式。
3. 所有真实及 reverse 生成的虚拟 tag 纳入引用检查；重复、缺失和循环引用按明确规则拒绝。
4. 普通目标端口校验与 reverse 内部保留控制目标分开处理，避免误拦参考协议使用的端口 0。
5. 原始文件不由加载器改写。配置路径相对于所加载配置文件解析，纯对象输入通过显式 baseDir 解析相对路径。
6. 提供只校验、不拨号的 check 命令，以及脱敏的规范化配置和能力报告。

### 参考配置的测试化

将前期提供的 `v2ray-config.json` 作为能力需求来源，在仓库新增脱敏、可复现的测试样例。真实节点地址、UUID、邮箱和路径不进入仓库、CI 或示例。

建议样例分为：

- `vless-wss-client.json`：最小 VLESS 出站、WSS、严格证书校验，无本地代理入站。
- `reverse-bridge.json` 和 `reverse-portal.json`：传统反代两端和显式 TCP 业务入口。
- `routing-dns.json`：hosts、指定 DNS、DoH、GeoIP、Geosite、HTTP/TLS 嗅探及阻断规则。
- `reference-config.json`：组合样例，用于完整版本验收。

原参考文件中的 `api` 路由没有对应的 API 配置或可用出站，不能直接当作合法基线。为它保留失败用例；组合样例通过明确记录的修订移除此遗留规则。其他未支持或多余字段也要逐项记录处理结果，不通过静默丢弃使样例“通过”。

SOCKS 入站在样例中属于显式、可选功能。无端口库模式用另一份 `inbounds: []` 样例独立验收；“无本地代理端口”不限制 Portal 提供必要的公网业务监听，也不禁止连接现有本地服务。

## 5 阶段与验收门槛

按 P0 至 P8 顺序推进。每阶段保留可独立审查的提交，并在进入下一阶段前满足本阶段出口条件。P0 至 P8 已定义的能力矩阵和阶段门槛已验收；实际命令、证据和兼容边界见 [实现进度与兼容证据](docs/IMPLEMENTATION_STATUS.zh-CN.md)。复选框只记录对应工作项，不代替阶段出口验收。

### P0 固定基线和测试边界

工作内容：

- [x] 建立 `node:test` 测试入口和格式、静态检查、配置检查脚本。
- [x] 记录原配置用法，建立 VMess、SOCKS、Freedom 及现有传输的回归清单。
- [x] 冻结运行时、字节流、数据报、错误和配置诊断接口。
- [x] 确定用于 VLESS 及传统 Bridge/Portal 互通的参考内核版本，保存版本号、源码提交和下载校验值。
- [x] 明确实际服务端所使用的协议版本；不能用会移动的 latest 作为兼容承诺。V2Ray 与 Xray、传统 reverse 与较新的 reverse 变体分别建矩阵。
- [x] 建立本地 echo、HTTP/HTTPS、DNS/DoH 和测试 CA 设施，全部使用临时目录和合成凭据。

出口条件：可以复现已知问题；每项目标能力有对应测试位置和参考依据；首轮平台、版本及负载矩阵已确定。测试设施不依赖真实节点或 ChatRoom。

### P1 建立可嵌入的运行时

工作内容：

- [x] 拆分库入口与 CLI，移除安装和导入时的系统服务、stdin、退出处理副作用。
- [x] 将存储、日志、事件、用户校验器和周期任务改为实例资源。
- [x] 实现显式生命周期、连接跟踪、超时、取消、排空和结构化错误。
- [x] 定义 `Duplex` 及数据报契约，统一背压、队列上限、半关闭及重复关闭语义。
- [x] 修复 `Ddata` 等现有确定性错误，增加多实例及多网络选择回归。
- [x] 验证普通 TCP 流和适配后的虚拟流能够满足 Node HTTP 与 Undici 的接口要求，记录所需方法及行为。

出口条件：仅导入库的隔离进程可自然退出；两实例互不影响；空入站模式不监听端口；启动失败、取消和反复创建关闭均无残留资源。

### P2 完善 TCP TLS WS WSS 传输

工作内容：

- [x] 统一传输工厂，修复 WSS URL、SNI、Host、端口和路径处理。
- [x] 支持连接目标与证书名称不同、IPv4/IPv6 及可注入 DNS 解析器。
- [x] 默认验证证书链和主机名；测试用例通过测试 CA 建立信任。
- [x] 对连接、TLS 握手、WebSocket Upgrade 和空闲分别实施超时与取消。
- [x] 对 WS 实现二进制流适配、发送背压、接收限制、ping/pong 和有界关闭。
- [x] 区分传输已就绪与对端应用协议已响应，不通过固定延迟判断成功。

出口条件：四种传输在域名、IPv4、IPv6 下通过；错误证书及失败 Upgrade 正确失败；慢速读写保持内存有界；关闭不会产生重复回调或未处理异常。

### P3 新增 VLESS 入站和出站

工作内容：

- [x] 实现 v0 请求头、响应头、UUID、附加信息、命令和三种地址类型。
- [x] 实现 TCP 及传统 UDP 帧，覆盖长度限制和无效输入。
- [x] 使用可跨多次读取的解析状态机，保留与响应头同批到达的业务数据。
- [x] 握手不等待首个业务响应后才允许写入，避免 HTTP 或隧道内 TLS 首包死锁。
- [x] VLESS 与传输独立组合，P3 基线支持 none 加密和空 flow；P15 扩展 Vision，其他 flow 显式拒绝。
- [x] 增加 VLESS 入站与出站配置校验，并保留原协议回归。

出口条件：js2ray 客户端对官方服务端、官方客户端对 js2ray 服务端均通过；TCP/UDP、WS/WSS、地址类型、分片、粘包、拒绝认证和断连均有覆盖。UDP 按数据报接口验证，不以 TCP 流测试代替。

### P4 实现配置 DNS 和路由

工作内容：

- [x] 实现两种配置格式的规范化及严格能力诊断。
- [x] 新增 Blackhole、Freedom redirect 和 reverse Portal 测试需要的 TCP 转发入站。
- [x] 按规则顺序匹配 `inboundTag`、domain、IP/CIDR、port、network；同一字段的多个候选和多个字段组合遵循参考语义。
- [x] 支持 `full:`、`domain:` 和样例实际使用的 Geosite 类别；其他匹配形式按支持矩阵校验。
- [x] 实现 `domainStrategy: "AsIs"`，区分目标域名保留、路由解析与最终拨号解析。
- [x] 支持 hosts、普通 DNS、DoH、按 domains 选服务器、expectIPs、回退、缓存、超时及 A/AAAA。
- [x] 明确节点地址解析、DNS 查询及 DoH 自身连接的路径，避免 DNS 与代理递归依赖。
- [x] 用纯 JavaScript 加载固定版本的 GeoIP/Geosite 资源；校验资源格式、引用、大小、版本及校验值。
- [x] 区分 `geoip:!cn` 的取反语义与 `geosite:geolocation-!cn` 的类别名称。
- [x] 实现有界的 HTTP Host 和 TLS ClientHello SNI 嗅探，保留原始首包；分别验证 `routeOnly` 对路由目标和实际目标的影响。

出口条件：脱敏组合样例通过配置检查；缺失资源及无效 tag 明确失败；同一目标集合下的路由结果与参考内核一致；私网直连、国内分流、广告阻断、UDP 443 阻断和远端出站均有验证。

### P5 实现 Mux.Cool

工作内容：

- [x] 依据固定参考实现实现 Mux 元数据和数据帧的增量编解码。
- [x] 实现 TCP 会话的建立、传输、关闭、错误传播和会话 ID 生命周期。
- [x] 实现每会话与每底层连接的背压及队列上限，限制并发、帧大小和空闲时间。
- [x] 提供 reverse 可复用的控制流与业务流接口，处理连接排空和失效。
- [x] 明确普通出站 Mux 的能力范围。首轮只承诺 TCP；UDP/XUDP 等未实现组合直接报错。

出口条件：与参考实现互通；分片、并发、ID 回收、慢消费者和异常关闭不会串流、死锁或无界缓存；单会话错误与整条传输错误分别处理。已有零散 Mux UDP 辅助函数不作为完成依据。

### P6 实现传统 Bridge 和 Portal

工作内容：

- [x] Bridge 主动建立到 Portal 的连接，区分控制域名和业务目标。
- [x] Portal 将桥接连接与显式业务入口配对；实现反代控制消息、状态迁移、可用连接选择与排空。
- [x] 将虚拟入站、出站 tag 纳入路由，并保证反代专属规则优先级符合配置顺序。
- [x] 支持固定服务 redirect 及进程内服务处理器，两种模式均有明确目标范围。
- [x] 实现带上限和抖动的退避重连、故障恢复、并发限制和启动失败清理。
- [x] 传输失效时终止受影响业务流，不重放已发送的应用数据。
- [x] 区分运行状态、传输状态和业务可达状态，提供事件与脱敏诊断。
- [x] 保留 `mux.enabled: false` 时 reverse 内部所需的 Mux，避免额外嵌套复用。

出口条件：以下三种拓扑均通过：js2ray Bridge 对参考 Portal、参考 Bridge 对 js2ray Portal、js2ray 两端互连。验证 HTTP、HTTPS、流式响应、半关闭、Portal 重启、多并发和长连接；仅 js2ray 自身两端互连不算兼容验收完成。

### P7 提供通用 HTTP 适配

工作内容：

- [x] 在统一拨号接口上实现 Node.js HTTP/HTTPS Agent。
- [x] 提供可选 Undici connector/dispatcher 适配，明确所支持的 Undici 版本；不将它变成协议核心依赖。
- [x] HTTPS 目标通过隧道流再建立目标站点 TLS，节点 TLS 与目标 TLS 分别验证。
- [x] 明确连接池键与复用范围，涵盖目标、出站、TLS 参数及实例，避免错误复用。
- [x] 贯通取消和总时间预算；由上层 HTTP 客户端处理的重定向持续使用相同适配器及路由策略。
- [x] 使用虚拟流适配层满足实际接口契约，不用类型断言代替运行时兼容测试。

出口条件：HTTP/HTTPS、跨主机重定向、大响应流、错误证书、超时、取消及连接池关闭均通过；整个测试流程无需创建本地 SOCKS/HTTP 代理监听器。

### P8 完成发布验收

工作内容：

- [x] Windows、Linux、macOS CI 执行配置、协议、运行时和现有功能回归。
- [x] 普通单测不依赖参考内核；互通测试使用固定且校验过的测试工具，单独提供明确入口。
- [x] 必需的发布互通检查缺失工具时失败，不能静默跳过；开发者快速单测可单独运行。
- [x] 发布前执行首轮 100 并发 TCP 会话、持续 30 分钟的本地稳定性测试，包含反代及慢消费者。记录负载、机器、配置、队列峰值、内存和关闭后资源情况。
- [x] 确认包安装及导入均无系统服务、信号或全局网络设置副作用。
- [x] 验证从打包产物安装，而非仅从源码运行；运行依赖中不包含参考内核。
- [x] 补齐 API、能力矩阵、迁移说明、原始署名和许可证，以及最小可运行示例。
- [x] 依据最终 API 兼容性决定版本号；破坏性变更使用主版本升级。

出口条件：第 7 节完整版本清单全部满足，测试证据及已知限制随版本保存。

## 6 测试组织与验收证据

建议建立以下测试层次：

| 层次 | 主要内容 | 判断依据 |
| --- | --- | --- |
| 编解码单测 | VLESS、Mux、UDP、IPv4/IPv6、长度与非法输入 | 固定字节向量、随机分片与截断输入 |
| 运行时单测 | 状态、取消、超时、排空、实例隔离、无副作用 | 受控时钟、故障注入、隔离子进程自然退出 |
| 本机集成 | TCP/TLS/WS/WSS、HTTP/HTTPS、DNS/DoH、配置和资源 | 本地测试服务及合成证书，无公网依赖 |
| 参考互通 | 客户端/服务端、Mux、Bridge/Portal、分流 | 锁定版本和校验值，分别测试两个方向 |
| 发布验收 | 平台、打包安装、并发、长连接及资源清理 | 完整测试日志、配置摘要和负载记录 |

每个功能完成记录至少包含测试命令、js2ray 提交、参考内核版本、配置与资源校验值、通过的平台和未支持的组合。正式支持与试验能力分别列出。

重点覆盖首包任意切分、头与数据合并、远端在握手中断开、取消与连接成功竞争、慢读写、重复关闭和大数据流。这些测试应在对应阶段完成，不集中拖到发布前。

对于“无本地代理端口”，直接在测试中检查库是否创建入站监听；出站连接的临时源端口、与已有服务建立的连接，以及独立 Portal 的业务端口不属于本地代理监听端口。

测试允许使用官方内核作为独立对端，但 js2ray 产品运行时保持纯 Node.js。不得使用真实节点凭据、生产服务或关闭全局证书校验来获得通过结果。

## 7 完整版本完成清单

- [x] P0 至 P8 出口条件全部满足，关键回归与参考互通检查通过。
- [x] 无入站配置时，库导入、运行和 HTTP 适配均不创建本地代理监听端口。
- [x] VLESS、WS/TLS、传统 UDP、Mux TCP、Bridge/Portal 有明确的官方版本互通记录。
- [x] 原有 VMess、SOCKS 和 Freedom 的保留能力有回归证据。
- [x] 脱敏组合配置覆盖参考文件的有效需求；修订、诊断及不支持项逐项说明。
- [x] DNS、GeoIP、Geosite、嗅探及路由决策通过固定样例验证。
- [x] TLS 校验、取消、关闭、重连、队列和并发上限行为明确且经过测试。
- [x] 通用 HTTP 适配、类型声明、示例、迁移与发布包验收完成。
- [x] 正式支持矩阵与试验能力区分清楚，后续扩展不阻塞已经定义的完成标准。
- [x] 达到以上条件后，再创建独立的 ChatRoom 整合规划，评估 API、认证和部署；本规划不提前实施整合。

## 8 任务推进和变更原则

每项任务遵循“确认参考行为、增加失败用例、实现、回归、记录兼容范围”的顺序。提交按运行时、传输、协议、路由、Mux、reverse 和适配器划分，避免把所有改动压入一个提交。

开始每阶段时更新其复选框和实际验收命令。新增协议或扩大配置兼容范围时，先补充能力矩阵与测试条件，再改变实现；实际 Portal 内核与 P0 基线不同时，先增加对应版本的互通验证。

对连接失败不隐式回退直连，不对已发送业务数据自动重试。配置的路由决策、明确的连接池策略和 reverse 传输恢复分别实现，避免让调用方误判请求是否已经执行。

对已有实现，优先修复可复现的问题并保持行为可解释；协议接口确实需要改变时，提供迁移说明。任何测试通过结果都只对应已记录的协议、传输和版本组合。

## 9 后续扩展 P9–P13（2026-10-15）

以下阶段按用户指定顺序实施，每项独立补充测试并更新本节。P0–P8 的历史验收不自动覆盖新增能力。

| 阶段 | 工作与出口验收 | 状态 |
| --- | --- | --- |
| P9 统一错误与指标 | 已建立流、数据报、拨号、DNS 的稳定错误；实例隔离的字节、耗时、缓存、队列及重连统计；脱敏、取消和资源回收回归 | 已通过：`node --test test/metrics.test.js test/runtime.test.js` 17/17；`npm test` 110/110 |
| P10 应用 WebSocket | 公开 WS/WSS 客户端适配；真实 Upgrade、子协议、文本/二进制、心跳、鉴权失败、严格目标 TLS、取消、关闭和代理承载测试 | 已通过：`node --test test/websocket-adapter.test.js` 6/6；真实普通流、VMess 和 VLESS Mux 上的 WS/WSS |
| P11 DNS 联动路由 | AsIs/IPIfNonMatch/IPOnDemand、所有解析地址参与 IP 匹配、保留实际域名、显式出站绕过、DNS 自身防递归、超时取消及固定内核对照 | 已通过：DNS/路由专项 13/13；V2Ray 5.14.1、Xray 24.11.5 两策略对照 4/4 |
| P12 UDP 扩展 | SOCKS5 UDP、VMess UDP、Mux UDP/XUDP、reverse UDP；独立数据报边界、地址、空包、大包、队列、取消、关闭及固定内核互通 | 已通过：`npm test` 129/129；`npm run test:interop` 106/106（新增 UDP 对照 32 项）；IPv6/域名/空包/大包及并发 reverse 边界均通过；macOS 按内核上限验收并测试 EMSGSIZE，独立验证 65535 字节协议帧，修复 VMess UDP 对端 EOF |
| P13 平滑轮换 | 配置/凭据预检、新实例就绪后切换、新请求与连接池按代隔离、旧会话限时排空、启动失败回滚、并发轮换和关闭竞争 | 已通过：轮换专项 15/15；`npm test` 148/148；同端口 VMess/VLESS 凭据、TLS/WSS 证书、HTTP/Undici 池、UDP/WS 排空与失败回滚 |

P9–P13 五项实现、专项及发布验收全部通过：三平台各 148 项普通回归、106 项参考互通、实际 tarball 安装；两组独立 100 会话/30 分钟负载均通过。原始记录、源码摘要、资源清理与隐私审计见 [扩展验收](docs/P9-P13_ACCEPTANCE.zh-CN.md) 和 [机器可读汇总](docs/acceptance/extensions-2026-10-15.json)。

新增验收继续使用合成凭据及固定参考内核，真实配置仅在本地审计或授权的单请求回归中读取，不进入日志、Git 或发布包。普通回归、类型/格式/配置检查、参考互通、实际 tarball 安装和三平台 CI 均已执行通过。

## 10 XHTTP 扩展 P14（2026-10-15）

本阶段实现 HTTP/1.1、HTTP/2 的 `packet-up`、`stream-up`、`stream-one`，客户端与服务端均接入现有 Runtime。固定参考内核采用 Xray 25.3.6，独立于既有 Xray 24.11.5 回归基线；工具归档、二进制及源码提交均锁定校验值。

- [x] 原生配置、V2Ray/Xray JSON 子集、类型声明、示例与支持矩阵。
- [x] 三种模式、独立连接地址/SNI/Host/path、严格 TLS、取消、超时和背压。
- [x] 分包排序、重复/非法序号、会话与请求上限、未配对会话回收和关闭清理。
- [x] HTTP/1.1、TLS HTTP/1.1、HTTP/2（TLS 与显式 h2c）本机测试。
- [x] 与固定 Xray 25.3.6 的客户端/服务端双向互通；三种模式均不得跳过。
- [x] Windows、Linux、macOS 全量回归、互通、类型/格式/配置及 tarball 安装验收。

验收命令：`node --test test/xhttp.test.js`、`node --test test/interop/xhttp.test.js`、`npm test`、`npm run test:interop` 及现有三平台 CI。HTTP/3、REALITY、浏览器指纹、跨节点上下行分离和完整 XMUX 参数不属于本阶段；配置必须明确拒绝尚未支持的行为字段。实现和测试通过后在本节记录实际数量及证据。

P14 全部验收通过：XHTTP 专项 37/37、Xray 25.3.6 对照 21/21；Windows、Linux、macOS 各 185/185 普通回归、127/127 参考互通，类型/格式/配置和实际 tarball 安装均通过。100 条并发 TLS 连接涵盖三模式且关闭后资源归零，包内 XHTTP 拨号通过，运行依赖仍仅 ws，无原生运行资产。功能提交 `4f226980b97ac38f2dbad04bafd73eaa21b6c9de` 对应 [三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38706751704)。详见 [P14 验收记录](docs/P14_XHTTP_ACCEPTANCE.zh-CN.md) 和 [机器可读证据](docs/acceptance/xhttp-2026-10-15.json)。

## 11 Vision 扩展 P15（2026-10-15）

本阶段先验证纯 Node.js 24 的公开 TLS/Duplex API 能否实现 Vision 的双向 TLS→TCP 切换，重点覆盖 TLS 记录与原始数据粘包、分片、未读明文、背压及半关闭。原型必须证明数据完整、有序且不依赖 Node 私有 TLS 状态；通过后才进入正式协议实现。参考内核继续锁定 Xray 25.3.6（源码提交及二进制校验值见 `test/fixtures/reference-cores.json`）。

- [x] 公开 API 原型：三种 TLS 1.3 密码套件双向切换、未读明文与原始数据保序、2 MiB 完整性、单字节分片/密文与原始数据粘包、KeyUpdate/认证向量、畸形记录、延迟 keylog 与半关闭，原型 8/8。
- [x] VLESS Vision 流协商、填充编解码、内层 TLS 识别与原始 TCP 切换；明确配置限制和错误。
- [x] 原生/传统配置、类型、示例、指标及凭据/证书轮换回归。
- [x] 固定 Xray 25.3.6 双向互通 8/8；真实内层 TLS 1.3 均触发双向 Direct，普通流量/TLS 1.2 保持外层 TLS，另测 XUDP 和参考内核大包拒绝。
- [x] Windows、Linux、macOS 各 209/209 普通回归、135/135 参考互通，类型/格式/配置及实际 tarball 安装全部通过，零跳过。

验收命令：`node --test test/vision-prototype.test.js test/vision.test.js`、`node --test test/interop/vision.test.js`、全量回归/互通及现有三平台 CI。100 并发真实内层 TLS 1.3 会话全部完成双向 Direct 并关闭归零；完整范围与实际 CI 结果见 [P15 验收](docs/P15_VISION_ACCEPTANCE.zh-CN.md)。

P15 全部验收通过：功能验收提交 `fd294a63e80abb5808ab31092682523e11f33491` 对应 [三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38713120194)。公开 API 原型 8/8、Vision 协议及运行时 16/16、固定 Xray 25.3.6 双向互通 8/8；100 并发、同端口凭据及证书轮换、实际发布包内的双向 Direct 均通过。69 个产品源码的 Git 规范化 SHA256 汇总与逐平台作业/日志核对结果保存于 [机器可读证据](docs/acceptance/vision-2026-10-15.json)，隐私审计无敏感字段匹配。运行依赖仍仅 ws，产品无原生扩展、WASM 或参考内核进程。

## 12 REALITY 扩展 P16（2026-10-15）

先验证纯 Node.js 24 的公开 crypto/stream/net API 能否实现 REALITY 握手，固定 Xray 25.3.6 及其 REALITY 依赖提交 `48f0b2d5ed6d`。原型须验证 X25519、Session ID 认证、TLS 1.3 密钥派生、REALITY 证书认证、CertificateVerify/Finished 以及双向真实加密数据；不能仅以 TCP 连通或跳过服务端认证判定可行。

- [x] 纯 Node.js 握手原型 4/4：三种 TLS 1.3 密码套件客户端对 Xray，Xray Chrome 客户端对 Node 服务端，均完成认证及加密数据往返。
- [x] 完整客户端/服务端、目标握手镜像、未认证连接转发、配置/类型/文档与明确限制。
- [x] 与 Vision 组合，实际双向 Direct、缓冲保序和 XUDP。
- [x] 固定 Xray 双向互通 21/21（含 4 项原型），普通专项 27/27：认证拒绝、取消/限额、轮换与资源回收；100 并发真实内层 TLS 1.3 双向 Direct。
- [x] Windows、Linux、macOS 各 236/236 普通回归、156/156 参考互通，配置/类型/格式及发布包验收全部通过，无失败、取消或跳过。

原型通过后继续实现；实际支持边界、命令及验收证据在本节逐项更新。所有凭据、目标和密钥均使用独立合成 fixture，不读取真实节点配置进行 REALITY 试探。

P16 全部验收通过：功能提交 `0abc16233d50b3b23373fab72bd729253395b449` 对应 [三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38719238453)。纯 Node.js 握手原型 4/4、协议与运行时专项 27/27、固定 Xray 25.3.6 对照合计 21/21。100 并发双向 Direct、同端口私钥/short ID/UUID/dest 轮换与回滚、实际安装包的 REALITY + Vision 均通过。77 个产品源码的 Git 规范化 SHA256 汇总为 `56f744db79b6c4866a90098f1b7125c7ba0a63e704454988793b2bbbd2106526`；[验收说明](docs/P16_REALITY_ACCEPTANCE.zh-CN.md) 与 [机器可读证据](docs/acceptance/reality-2026-10-15.json) 保存逐平台作业、测试数和隐私审计。支持原始 TCP、TLS 1.3、固定非 PQ Chrome 120 模板；WS/XHTTP REALITY、PQ、其他任意指纹和 PROXY protocol 明确不支持，详见 API。

## 13 验收与可观测性加固 P17（2026-10-15）

按顺序补齐 P14–P16 验收盲区，保留既有固定参考基线；所有故障注入及负载使用合成凭据。

- [x] 入站传输握手指标与脱敏诊断：成功、失败、超时、限额、关闭取消、REALITY cover 建连和正常未认证转发，单次计数、实例/轮换隔离及有界诊断输出。`test/inbound-metrics.test.js` 10/10；诊断每实例每秒最多 8 项，错误累计不采样，正常转发不冒充错误。
- [x] REALITY 安全负向：CertificateVerify/Finished 篡改、压缩证书边界、随机分片与非法输入；认证前业务零泄露，队列和生命周期有界。新增 11 项确定性用例，包含双向 Finished 拒绝、Brotli 压缩炸弹/声明长度/算法/畸形数据、四个固定分片种子与 512 次 ClientHello 变异。
- [x] cover 兼容性：强制单记录/四记录布局、三套件服务端方向、HRR/CCS/记录空间/断连等边界；本机专项 12/12。新增 CLI `check-cover`，不创建入站监听、不输出目标/凭据，检查所有配置名称的镜像布局与记录空间；另以固定 Xray 25.3.6 的 Go TLS cover 验证双向互通。
- [x] P14–P16 长时混合负载：三个平台分别 100 并发、持续 30 分钟，涵盖 XHTTP 三模式、Vision/REALITY、慢消费者、轮换、cover 故障、延迟/内存/内部队列及关闭归零；每个平台完成 29 次轮换及故障恢复，原始证据已保存。
- [x] 修正文档冲突，扩展原生/传统配置和 REALITY 密钥/short IDs 隐私审计；合成敏感字段与已删除历史 blob 测试 2/2。实际安装的 tarball 在本地额外逐文件执行私有字段检查，CI 继续保持不接触真实凭据。
- [x] 全量回归、固定内核互通及 Windows/Linux/macOS 验收：各 275/275 普通回归、158/158 参考互通、类型/格式/配置和实际 tarball 安装全部通过，无失败、取消或跳过；保存逐平台作业、源码摘要与机器可读证据。

长时负载先用短运行检查脚本，再在固定功能提交上执行完整 30 分钟；短运行不得计作正式长时验收。实现与验收逐项更新本节。

短负载发现并修复 WSS/XHTTP 握手计时器移交问题：TCP、TLS 与 HTTP/2 session 各自持有超时，传输就绪后必须清除父 TCP 计时器，HTTP/2 后续预算交给 session。新增 4 项持续读写超过握手预算的回归通过；修复后的 100 会话短运行完成 4 次全端点轮换与 4 次 cover 故障恢复。该结果不计作正式 30 分钟证据。

P17 全部验收通过：[全量三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38733773509) 对应 `7f79809f41c0d247450db11c8e7554f68ab89e77`；[三平台长时验收](https://github.com/maz-1/js2ray/actions/runs/38733509036) 对应 `80c5908d4b5216f135044179ca51ca1551382de9`。两者 79 个产品源码及长时脚本摘要完全一致，仅临时测试目录修订不同。Windows/Linux/macOS 分别持续 1800310/1800300/1800137 ms，完成 1192456/1377202/1304761 次逐字节校验，29 次轮换和 cover 故障恢复，关闭后全部管理器资源归零。源码汇总 SHA256 为 `b3b869f731b9696b650d143abf23b3a025b55ee4a551c16203c1b7aed527cc99`。详见 [P17 验收](docs/P17_ACCEPTANCE.zh-CN.md)、[机器可读汇总](docs/acceptance/p17-2026-10-15.json) 及三份未改写的原始负载记录。

最终文档回归另暴露共享 macOS CPU 上多个 100 并发测试文件同时争用预算的问题。CI 改为测试文件串行，保留每个用例内部的 100 真并发、默认 10 秒握手预算和全部断言；不增加产品超时。Node 测试选项必须位于文件参数之前，不能用 `npm test -- --test-concurrency=1` 冒充生效的串行设置。产品和长时负载源码不变。

## 14 XHTTP 完整 XMUX P18（2026-10-15）

范围锁定 Xray 25.3.6 的六项 XMUX 字段，覆盖 HTTP/1.1、HTTP/2 的三模式；跨节点 downloadSettings 和 HTTP/3 单独评估，不由 XMUX 验收推断支持。

- [x] 核对固定源码的六项字段、取随机范围、全零默认值、互斥规则及保活语义。
- [x] 接入按 Runtime、网络配置及代次隔离的 HTTP 客户端池，支持并发预留、复用/请求/时长退役、packet-up 上行切换、GOAWAY 排空与关闭清理。
- [x] 完成参数、共享取消、ref/unref 隔离、流容量、异常、保活、轮换及资源清理专项测试。保活专项增加持续入站/只有出站/恢复空闲检查，修复原生 HTTP/2 读取不触发 JS data 事件导致的固定周期 PING；当前专项 37 项。
- [x] 完成含空闲检测修正的最终固定 Xray 25.3.6 双向互通、全量回归、实际安装包和三平台验收：[CI](https://github.com/maz-1/js2ray/actions/runs/38749322344) 每平台 312 项普通测试、170 项参考互通，无失败/跳过/取消；实际安装包不含额外原生运行资产。
- [x] 完成 API/类型/配置样例及本轮隐私审计，未检出真实配置敏感值。
- [x] 完成 XMUX 100 会话/30 分钟三平台长时稳定性及 P14–P16 混合传输回归，均完成 29 次轮换，混合传输另完成 29 次 cover 故障恢复；管理器关闭后资源归零。六份原始记录与 80 个产品源码摘要一致，见 [P18 验收](docs/P18_XMUX_ACCEPTANCE.zh-CN.md) 和 [机器汇总](docs/acceptance/p18-2026-10-15.json)。
- [x] 基于本机 Node 24.20.0 和官方源码评估 HTTP/3 实现路径、成本及原型出口，见 [HTTP/3 可行性评估](docs/HTTP3_FEASIBILITY.zh-CN.md)。当前二进制未编译 QUIC，近一年主线 API 存在较大不兼容变化；HTTP/3 暂缓至 Node.js 原生 QUIC 支持稳定后再实现，不启动原型或标记支持。CI 保留三平台信息性能力探测。

P18 全部验收通过：最终产品提交 `74d4529f36db80446b77305ae5f9b0b08766a8af`，[回归](https://github.com/maz-1/js2ray/actions/runs/38749322344)、[XMUX 长时](https://github.com/maz-1/js2ray/actions/runs/38749322880) 和 [混合传输长时](https://github.com/maz-1/js2ray/actions/runs/38749322553) 同源。产品汇总 SHA256 为 `fbd3e69f320246067daba12c1ec7a9d98d6e0f28fa42b87969093bc326eae939`。保活修正后的持续入站/只有出站/空闲恢复测试均通过；原始记录与最终产品一一对应，不以修正前的长时结果代替。

## 15 XHTTP 上下行分离与部署链路 P19（2026-10-16）

HTTP/3 继续暂缓。本阶段锁定 Xray 25.3.6，实现 HTTP/1.1、HTTP/2 的独立上下行入口；先确认 downloadSettings 的默认值、模式及会话关联语义，不能将任意独立服务端误认为共享会话。

- [x] 修正文档中“逻辑连接独占池”的历史描述；XMUX 长时工作流补齐 DNS、路由、Geo、适配器、reverse、core、测试 fixture 和依赖变更触发范围。
- [x] 实现原生及传统 downloadSettings 配置、严格诊断、类型与样例；独立地址/SNI/Host/path/TLS/HTTP 版本及 XMUX 池，不支持项明确拒绝。
- [x] 完成上下行关联、背压、取消、限时、断链、单向故障、GOAWAY、请求预算及配置轮换测试，业务字节不重放。本地新增 27 项专项通过；下行物理客户端失效现能立即终止逻辑流并释放上行租约。
- [x] 完成真实 HTTP 反向代理链路的流式转发、版本转换、缓冲/超时/拒绝和关闭测试，使用合成凭据及本地严格 TLS。Node 代理与固定 Caddy 2.10.0 均有双向对照；Caddy 明确启用 HTTP/1 全双工、上游 Connection: close 和逐入口 ALPN，三平台归档按官方 SHA512 校验并锁定二进制 SHA256。
- [x] 完成固定 Xray 25.3.6 客户端/服务端双向互通、全量回归、配置/类型/格式、实际 tarball 安装和隐私审计。提交 `617d2a69361d9508a13b0081ef8376f657390043` 的 [三平台回归](https://github.com/maz-1/js2ray/actions/runs/38771437742) 各通过 339 项普通/202 项参考互通，无失败、跳过或取消；本地审计未检出真实配置敏感字段。
- [x] 完成 Windows/Linux/macOS 全量及 100 会话/30 分钟上下行分离长时验收，保存原始记录、运行版本、配置和产品源码摘要；P18 XMUX 及 P14–P16 混合传输长时回归继续通过。三组负载每平台均完成 29 次轮换；分离负载每平台另完成 232 次代理故障恢复，管理器关闭归零、四个 Caddy 子进程全部退出。

每项实现和验收后更新本节；未执行或失败的结果不计作完成。

首轮正式长时在三平台约 330 秒一致失败，定位为测试反向代理仍使用 Node HTTP/1 默认 300 秒整请求期限；持续上传也会触发该期限。测试代理改为流式请求不设置整请求期限，握手/取消和逻辑空闲仍由运行时预算约束；产品 XHTTP 入站原已采用这一设置。首轮失败不作为验收通过证据，修正后重新执行完整 30 分钟。

P19 全部验收通过：[全量回归](https://github.com/maz-1/js2ray/actions/runs/38771437742) 与 [上下行分离长时](https://github.com/maz-1/js2ray/actions/runs/38772075331) 对应 `617d2a69361d9508a13b0081ef8376f657390043`；[XMUX 长时](https://github.com/maz-1/js2ray/actions/runs/38770712593) 与 [混合传输长时](https://github.com/maz-1/js2ray/actions/runs/38770712799) 对应 `4456d6807cc6f144f68ac7f8b53461cda957c216`。四组验收的 80 个产品源码和对应负载脚本逐文件一致，产品汇总 SHA256 为 `5d13786a11049bc5783b1e475bdf0386f08be57b4bbffac565cba4a3f12e5492`。Windows/Linux/macOS 分离负载实际持续 1800494/1800893/1801026 ms，完成 1109243/1355179/778359 次逐字节校验。详见 [P19 验收](docs/P19_XHTTP_SPLIT_ACCEPTANCE.zh-CN.md)、[机器汇总](docs/acceptance/p19-2026-10-16.json) 及九份按字节保存的原始 JSON；HTTP/3 继续暂缓。

## 16 常用路由与 DNS 配置兼容 P20（2026-10-16）

按前两批实施：常用静态路由与 DNS；固定 V2Ray 5.14.1（`1f1ff246ddebb530d8fadeb49ffd32b8617e64ec`）和 Xray 25.3.6（`2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`），保留已有参考基线。原生默认行为兼容旧版本，新增显式兼容档案区分两内核的配置语义；未知行为继续报错。动态负载均衡、观测选路、Starlark/Lua、FakeDNS、按进程路由不属于本阶段。HTTP/3 和 DoQ 继续暂缓。

- [x] 冻结逐字段支持矩阵、参考源码及语义差异，补齐正式验收失败退出与依赖触发范围。
- [x] 常用路由：domain/domains 别名、ruleTag、匹配算法、受控正则、外部 Geo 资源；来源 IP/端口、认证用户、协议及 Xray HTTP attrs，覆盖 TCP/UDP/Mux/reverse 与库模式。
- [x] 常用 DNS：每服务器 queryStrategy/timeout/cache/tag、ECS、TCP/local 模式、域名和 IP 过滤、回退策略、缓存与引导解析；按固定内核明确支持与差异。
- [x] 原生/传统配置、类型、示例、诊断和脱敏；逐项专项、固定内核对照与真实应用链路回归。
- [ ] Windows/Linux/macOS 全量、固定内核对照、实际 tarball 和 100 会话/30 分钟长时验收，保存原始记录、产品/配置/脚本摘要与资源清理结果；新增自动核验门禁。

P20 功能与 12 项正式长时已通过，归档后的最终进程级验收重新打开：[三平台全量回归](https://github.com/maz-1/js2ray/actions/runs/38791828807) 每平台 372 项普通/228 项固定内核互通、类型/格式/示例与实际 tarball 安装全部通过，无失败、取消或跳过。[路由/DNS 长时](https://github.com/maz-1/js2ray/actions/runs/38789667879)、[上下行分离长时](https://github.com/maz-1/js2ray/actions/runs/38789667907)、[XMUX 长时](https://github.com/maz-1/js2ray/actions/runs/38789667673) 和 [混合传输长时](https://github.com/maz-1/js2ray/actions/runs/38789668013) 各在三个平台完成 100 会话/30 分钟验收；P20 另保有 4 个 UDP 会话，覆盖 DNS/缓存/超时回退和凭据轮换。12 份原始记录均通过自动核验，所有管理器关闭归零，Caddy 子进程退出。83 个产品文件的规范化汇总 SHA256 为 `0c02ff45b132a23efb67b1edef659f6b32c65e497849b374cd8abfc047749f08`；全量与长时作业的产品、依赖、包清单及对应负载脚本逐文件一致。 逐项字段与差异、修复过程、原始记录链接见 [P20 验收与支持矩阵](docs/P20_POLICY_COMPATIBILITY.zh-CN.md) 和 [机器汇总](docs/acceptance/p20-2026-10-16.json)。短跑及中间失败/取消运行均未计作正式通过；HTTP/3 和 DoQ 继续暂缓。

归档后最终 Linux 回归在全部 372 个断言通过后发生 SIGSEGV，不能计作通过。GDB 与本地 Linux Valgrind 已定位 Node 24.20.0 在 HTTP/2 接收回调内发送 RST_STREAM 导致的 nghttp2 use-after-free（上游 [#64166](https://github.com/nodejs/node/pull/64166)）。XHTTP 客户端取消、XMUX 物理关闭及服务端关闭现统一推迟原生销毁至 setImmediate；逻辑关闭立即生效，避免原生回调重入和重复关闭会话所属 socket。新增三项定向回归，本机普通测试 375/375；修正前 Valgrind 4 次非法内存访问，客户端修正后为 0。三平台全量、12 项正式长时及 Linux 重复进程/内存门禁将按最终产品源码重新执行，完成前保留此项未完成。

## 17 参考资料

- [js2ray 源码基线](https://github.com/seezaara/js2ray/tree/f316d558839da35fb1efae9979492a5d1f0c81a8)
- [js2ray MIT 许可证](https://github.com/seezaara/js2ray/blob/f316d558839da35fb1efae9979492a5d1f0c81a8/LICENSE)
- [V2Ray VLESS 编解码实现](https://github.com/v2fly/v2ray-core/blob/master/proxy/vless/encoding/encoding.go)
- [V2Ray 传统反向代理说明](https://www.v2fly.org/config/reverse.html)
- [V2Ray Bridge 实现](https://github.com/v2fly/v2ray-core/blob/master/app/reverse/bridge.go)
- [V2Ray Mux 实现](https://github.com/v2fly/v2ray-core/tree/master/common/mux)
- [V2Ray 路由配置](https://www.v2fly.org/config/routing.html)
- [V2Ray DNS 配置](https://www.v2fly.org/config/dns.html)
- [Undici Connector 接口](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md)

协议参考链接用于定位资料。P0 应将实际采用的参考实现固定到不可变提交，并以固定版本的测试结果作为兼容依据。
