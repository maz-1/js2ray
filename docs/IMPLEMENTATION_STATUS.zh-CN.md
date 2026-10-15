# 实现进度与兼容证据

2026-10-15，Node.js 24.20.0，版本 `4.0.0-dev.0`。原始源码基线 `f316d558839da35fb1efae9979492a5d1f0c81a8`、MIT 署名保留。P0–P8 已定义的能力矩阵与验收门槛全部通过；未合并主分支或发布 npm 包。

| 阶段  | 实现与证据                                                                                                                | 状态                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0/P1 | 无副作用导入、独立实例、异步生命周期、启动回滚、取消、限额、排空、Duplex/UDP、类型与真实 HTTP/Undici 契约                 | 已通过本机回归                                                             |
| P2    | TCP/TLS/WS/WSS，域名/IPv4/IPv6，独立地址/SNI/Host/path，拒绝错误证书/Upgrade、超时、二进制、ping/pong、消息限制、有界关闭 | 已通过本机回归                                                             |
| P3    | VLESS v0 TCP/传统 UDP、分片与粘包、认证、地址类型、空 flow、传输组合；VMess/SOCKS/Freedom 保留能力                        | 已通过固定内核双向互通                                                     |
| P4    | DNS/DoH、GeoIP/Geosite、AsIs 路由、Blackhole、redirect、固定 TCP 入站、HTTP/TLS 嗅探、严格配置                            | 见 [P4](P4_ACCEPTANCE.zh-CN.md)                                            |
| P5    | Mux.Cool TCP 元数据/帧、会话与 ID 生命周期、并发、独立拥塞隔离、队列、关闭                                                | TCP/WSS 双向参考互通，见 [P5](P5_ACCEPTANCE.zh-CN.md)                      |
| P6    | Bridge/Portal、控制 protobuf、虚拟 tag、排空、重连、scope 限制服务处理器、Portal 重启                                     | 三种拓扑、并发、HTTP/HTTPS 流式响应已验证，见 [P6](P6_ACCEPTANCE.zh-CN.md) |
| P7    | Node HTTP/HTTPS Agent、可选 Undici 7.30.0、独立目标 TLS、池隔离、取消与连接预算                                           | 真实普通流、VMess 和 VLESS Mux 流均通过，见 [P7](P7_ACCEPTANCE.zh-CN.md)   |
| P8    | 三平台 CI、固定官方工具下载、实际 tarball 安装、100 会话/30 分钟负载、文档/示例                                           | Windows/Linux/macOS CI 和 100 会话/30 分钟稳定性全部通过                   |

Windows、Linux、macOS x64 CI 均通过语法、类型、格式、配置、107 项普通回归、70 项参考互通及实际 tarball 安装，没有失败或跳过。[最终功能版本 CI](https://github.com/maz-1/js2ray/actions/runs/38682754389) 对应 `cba04d239c93d09ef131036ede959df015dfd44e`。本地 Linux 还使用 Docker 官方 `node:24.20.0-bookworm-slim` 验证，镜像摘要 `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`；本地日志在忽略的 `test-results/` 中。

## P9–P13 扩展验收

用户要求的五项扩展已按序实现，并分别更新开发计划：统一连接错误和实例指标、应用 WS/WSS、三种 DNS 联动路由策略、SOCKS5/VMess/Mux/XUDP/reverse UDP，以及配置/凭据平滑轮换。API 与具体边界见 [API 文档](API.zh-CN.md)。本轮 Windows 普通回归 148/148，固定内核互通 106/106（新增 DNS 对照 4 项、UDP 对照 32 项），轮换专项 15/15。三平台 CI、实际 tarball 和两组 100 会话/30 分钟负载均通过，原始 JSON、SHA256 和逐文件源码核对见 [扩展验收](P9-P13_ACCEPTANCE.zh-CN.md) 与 [汇总](acceptance/extensions-2026-10-15.json)。以下 P0–P8 数字与原始稳定性记录保留为历史证据。

## 复现

```sh
npm ci --ignore-scripts
npm run check
npm run check:types
npm run format:check
npm run check:config
npm test
npm run test:tools
npm run test:interop
npm run test:package
npm run test:stability
```

普通单测不调用参考内核。互通检查缺工具、版本错误或摘要错误必须失败。互通文件顺序运行，避免独立进程分配并释放临时端口时相互竞争；不能通过跳过失败取得通过结果。CI 固定 Ubuntu 24.04、Windows 2022、macOS 15 Intel 和 Node 24.20.0。未实际执行的 CI 不能算通过。

发布包检查从实际 npm tarball 安装，只包含运行依赖 ws 8.22.0，无 install/postinstall、无测试内核、私有配置、原生模块；CJS/ESM 导入、新适配器导出和空入站关闭均验证。安装优先使用缓存，允许读取 npm 的依赖元数据。Undici 只作为测试开发依赖，调用者显式传入可选模块；npm 审计当前为零已知问题。

30 分钟脚本保持 50 条 VLESS Mux TCP 和 50 条 reverse TCP 会话，10 个慢消费者，每次 4096 字节；检查字节身份、控制会话、源文件摘要、机器、配置摘要、RSS/heap/应用队列峰值及关闭后资源。早期试跑发现并修复 ID 提前复用、控制心跳未刷新会话空闲计时的问题，最终测试在两项修复之后运行。

## 保存的最终验收记录

[机器可读汇总](acceptance/release-2026-10-15.json) 保存三个平台的提交/作业链接、工具范围和敏感信息审计；[原始稳定性记录](acceptance/stability-2026-10-15.json) 保持脚本输出字节，汇总中附 SHA256。稳定性实际运行 1,800,152 ms，100 并发完成 1,486,025 次校验，共 6,086,758,400 字节；RSS 峰值 245,899,264 字节、heap 峰值 35,563,144 字节、应用流队列峰值 40,960 字节。协议队列限额另由故障与慢消费者用例验证，不把应用队列峰值冒充承载内部峰值。四个运行时关闭后的连接、待拨号、监听器和 reverse 承载均为 0，测试进程自然退出。

负载启动时的工作树由逐文件 SHA256 精确标识，不能仅以当时基准提交推断所有文件。负载期间只有 DNS 服务器优先级和 Geo 匹配器优先级元数据两处后续修订；runtime、Mux、reverse、VLESS、传输、HTTP 适配等承载核心摘要与最终功能版本逐一相同。最终 DNS 修订另在三平台回归及两个固定内核对照通过，汇总保留这一区别，没有将早期试跑冒充最终验收。

依据开发计划，验收后另存 [ChatRoom 后续整合规划](CHATROOM_INTEGRATION_PLAN.zh-CN.md)；未提前实施宿主整合。

## 参考内核与范围

P14 XHTTP 已通过 [三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38706751704)：每个平台 185 项普通回归、127 项参考互通及实际 tarball 安装；其中 XHTTP 专项 37 项、Xray 25.3.6 对照 21 项，均无跳过。HTTP/1.1、TLS HTTP/1.1、TLS HTTP/2 的三种模式分别验证两个方向；显式 h2c 的参考方向限制、源码摘要和逐平台证据见 [P14](P14_XHTTP_ACCEPTANCE.zh-CN.md)。

- Xray 24.11.5，源码 `afc7ec55062c14ae69fc67b148155faae1c31548`。
- XHTTP/Vision 参考 Xray 25.3.6，源码 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`，与既有基线分别锁定归档和二进制摘要。
- V2Ray 5.14.1，源码 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec`。

已下载官方 Windows/Linux/macOS x64 发布包，并核对官方 `.dgst` 中的 SHA256，再锁定各可执行文件摘要，见 `test/fixtures/reference-platforms.json`。本机 v2rayN 附带的两个 exe 与官方发布完全一致；V2Ray 的 `Custom` 字样即为官方版本横幅，不再视为未确定来源。

两个内核均覆盖双向 VLESS TCP 与传统 UDP 在 TCP/TLS/WS/WSS 上的承载、IPv4/域名/IPv6 实际 TCP 目标、VMess none/AES-GCM/ChaCha20-Poly1305、Mux TCP/TCP 承载及 WSS 承载、传统 reverse 两个混合拓扑、HTTP/HTTPS 流数据，以及同一目标集的 Geo 路由和 DNS 分服务器/优先级/Freedom UseIPv4。Xray 测试进程使用 `xray.cone.disabled=true` 强制传统 UDP，防止无意改测 XUDP。Windows 参考 TLS 客户端使用专用合成 CA 和 `disableSystemRoot:true`，仍验证证书及主机名。

配置样例 `examples/combined.json` 使用合成节点及固定标准 protobuf Geo 资源，严格检查通过。原失败 fixture 保留悬空 api 规则；修订样例明确删除该规则、增加 Bridge 业务规则并提供资源。真实数据库需要调用者自行固定版本和 SHA256，样例中的 cn 仅是测试类别。该修订不改写用户原始文件。

## 明确边界

- 运行时保持纯 Node.js；参考 exe 只作独立测试对端，不被产品启动或打包。
- Mux.Cool END 与 WS 关闭均为双向会话结束，不能表达任意等待 TCP 写 EOF 才返回响应的协议；直接 TCP/TLS 支持半关闭。reverse 内部保留 Mux，外层可禁用普通 Mux。
- 普通 Mux 支持 VLESS TCP/UDP，reverse 支持 TCP/UDP；SOCKS5、VMess、VLESS、Freedom 均提供独立数据报接口。XUDP 接受/发送每包地址，但不承诺断开承载后保留 NAT 身份。
- V2Ray 5.14.1 的传统 UDP 对照只承诺至 2046 字节，其参考实现会拆分/丢弃较大数据报。不能外推为该内核的大数据报支持。
- 正式 VMess 回归使用 alterId=0；保留旧非零 alterId 实现作为未列入固定参考矩阵的能力。为避免 nonce 重用，每方向最多 65536 个加密块，达到后失败。
- XHTTP 支持 HTTP/1.1、HTTP/2 的 packet-up、stream-up、stream-one，范围与验收见 [P14](P14_XHTTP_ACCEPTANCE.zh-CN.md)。HTTP/3、REALITY、完整 XMUX、浏览器指纹及跨节点上下行分离不在本阶段。
- Vision 支持原始 TCP/TLS 1.3 的双向 Direct、普通流量和内层 TLS 1.2、XUDP、同端口凭据/证书轮换；API 边界、原型及参考验收见 [P15](P15_VISION_ACCEPTANCE.zh-CN.md)。三平台 CI 在实际作业完成后另行登记。
- VMess 嗅探、REALITY、HTTP Blackhole、透明转发、自定义 HTTP 管理 API、zero 模式仍不在支持矩阵。连接 error 事件与写回调已统一为 Js2rayError，宿主仍需处理 error。
- 不做隐式直连回退，不重放已发业务字节；reverse 传输恢复和 HTTP 上层重定向由各自机制处理。

## 私有真实配置

用户授权的 `node scripts/smoke-private.js v2ray-config.json` 仅提取 proxy 出站和 hosts，引导 VLESS/WSS 请求 example.com；前次结果 HTTP 200，本地代理监听器 0，严格 TLS 开启。它不证明公网服务端的内核版本或完整 reverse 部署兼容性。`scripts/check-private.js` 仅在本地检查已跟踪文件是否出现私有地址、UUID、邮箱、Host、SNI、路径，只输出文件名而不输出值。私有文件始终 gitignored，未进入 CI/发布包；没有修改 ChatRoom。
