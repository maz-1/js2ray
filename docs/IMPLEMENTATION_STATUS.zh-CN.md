# 实现进度与兼容证据

2026-10-15，Node.js 24.20.0，版本 `4.0.0-dev.0`。原始源码基线 `f316d558839da35fb1efae9979492a5d1f0c81a8`、MIT 署名保留。此文件区分已执行验收与仍待完成的发布门槛。

| 阶段  | 实现与证据                                                                                                                | 状态                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P0/P1 | 无副作用导入、独立实例、异步生命周期、启动回滚、取消、限额、排空、Duplex/UDP、类型与真实 HTTP/Undici 契约                 | 已通过本机回归                                                             |
| P2    | TCP/TLS/WS/WSS，域名/IPv4/IPv6，独立地址/SNI/Host/path，拒绝错误证书/Upgrade、超时、二进制、ping/pong、消息限制、有界关闭 | 已通过本机回归                                                             |
| P3    | VLESS v0 TCP/传统 UDP、分片与粘包、认证、地址类型、空 flow、传输组合；VMess/SOCKS/Freedom 保留能力                        | 已通过固定内核双向互通                                                     |
| P4    | DNS/DoH、GeoIP/Geosite、AsIs 路由、Blackhole、redirect、固定 TCP 入站、HTTP/TLS 嗅探、严格配置                            | 见 [P4](P4_ACCEPTANCE.zh-CN.md)                                            |
| P5    | Mux.Cool TCP 元数据/帧、会话与 ID 生命周期、并发、独立拥塞隔离、队列、关闭                                                | TCP/WSS 双向参考互通，见 [P5](P5_ACCEPTANCE.zh-CN.md)                      |
| P6    | Bridge/Portal、控制 protobuf、虚拟 tag、排空、重连、scope 限制服务处理器、Portal 重启                                     | 三种拓扑、并发、HTTP/HTTPS 流式响应已验证，见 [P6](P6_ACCEPTANCE.zh-CN.md) |
| P7    | Node HTTP/HTTPS Agent、可选 Undici 7.30.0、独立目标 TLS、池隔离、取消与连接预算                                           | 真实普通流、VMess 和 VLESS Mux 流均通过，见 [P7](P7_ACCEPTANCE.zh-CN.md)   |
| P8    | 三平台 CI、固定官方工具下载、实际 tarball 安装、100 会话/30 分钟负载、文档/示例                                           | 本机 Windows/Linux 已执行；macOS CI 和最终稳定性记录尚待完成               |

本地 Windows 与 Linux 容器的语法、类型、配置、普通回归、互通及实际 tarball 安装已通过。新增用例持续加入时，以最终保存的验收记录为准；目前完整互通套件为 52 项，无跳过。Linux 使用 Docker 官方 `node:24.20.0-bookworm-slim`，镜像摘要 `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`。完整 Linux 日志保存于忽略的 `test-results/linux.log`。

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

30 分钟脚本保持 50 条 VLESS Mux TCP 和 50 条 reverse TCP 会话，10 个慢消费者，每次 4096 字节；持续检查字节身份、控制会话、源文件摘要、机器、配置摘要、RSS/heap/应用队列峰值及关闭后连接/拨号/监听/承载数量。短时并发测试不替代该记录。早期试跑发现并修复 ID 提前复用、控制心跳未刷新会话空闲计时的问题；最终记录需由修正后的源文件生成。

## 参考内核与范围

- Xray 24.11.5，源码 `afc7ec55062c14ae69fc67b148155faae1c31548`。
- V2Ray 5.14.1，源码 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec`。

已下载官方 Windows/Linux/macOS x64 发布包，并核对官方 `.dgst` 中的 SHA256，再锁定各可执行文件摘要，见 `test/fixtures/reference-platforms.json`。本机 v2rayN 附带的两个 exe 与官方发布完全一致；V2Ray 的 `Custom` 字样即为官方版本横幅，不再视为未确定来源。

两个内核均覆盖双向 VLESS TCP/WS/WSS、传统 UDP、VMess none/AES-GCM/ChaCha20-Poly1305、Mux TCP/TCP 承载及 WSS 承载、传统 reverse 两个混合拓扑、HTTP/HTTPS 流数据，以及同一目标集的 Geo 路由和 DNS 分服务器/Freedom UseIPv4。Xray 测试进程使用 `xray.cone.disabled=true` 强制传统 UDP，防止无意改测 XUDP。Windows 参考 TLS 客户端使用专用合成 CA 和 `disableSystemRoot:true`，仍验证证书及主机名。

配置样例 `examples/combined.json` 使用合成节点及固定标准 protobuf Geo 资源，严格检查通过。原失败 fixture 保留悬空 api 规则；修订样例明确删除该规则、增加 Bridge 业务规则并提供资源。真实数据库需要调用者自行固定版本和 SHA256，样例中的 cn 仅是测试类别。该修订不改写用户原始文件。

## 明确边界

- 运行时保持纯 Node.js；参考 exe 只作独立测试对端，不被产品启动或打包。
- Mux.Cool END 与 WS 关闭均为双向会话结束，不能表达任意等待 TCP 写 EOF 才返回响应的协议；直接 TCP/TLS 支持半关闭。reverse 内部保留 Mux，外层可禁用普通 Mux。
- 普通 Mux 只支持 VLESS TCP，reverse 业务只支持 TCP；UDP/XUDP 业务拒绝。VLESS/Freedom 传统 UDP 使用独立数据报接口。
- V2Ray 5.14.1 的传统 UDP 对照只承诺至 2046 字节，其参考实现会拆分/丢弃较大数据报。不能外推为该内核的大数据报支持。
- 正式 VMess 回归使用 alterId=0；保留旧非零 alterId 实现作为未列入固定参考矩阵的能力。为避免 nonce 重用，每方向最多 65536 个加密块，达到后失败。
- 非 AsIs 路由、VMess 嗅探、Vision/Reality、XHTTP、HTTP Blackhole、透明转发、自定义 HTTP 管理 API、zero 模式均不在支持矩阵。已建立原生 Socket 可能发出 Node 标准错误，宿主仍需监听 error。
- 不做隐式直连回退，不重放已发业务字节；reverse 传输恢复和 HTTP 上层重定向由各自机制处理。

## 私有真实配置

用户授权的 `node scripts/smoke-private.js v2ray-config.json` 仅提取 proxy 出站和 hosts，引导 VLESS/WSS 请求 example.com；前次结果 HTTP 200，本地代理监听器 0，严格 TLS 开启。它不证明公网服务端的内核版本或完整 reverse 部署兼容性。`scripts/check-private.js` 仅在本地检查已跟踪文件是否出现私有地址、UUID、邮箱、Host、SNI、路径，只输出文件名而不输出值。私有文件始终 gitignored，未进入 CI/发布包；没有修改 ChatRoom。
