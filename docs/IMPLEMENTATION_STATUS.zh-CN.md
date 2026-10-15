# 实现进度与兼容证据

记录日期：2026-10-15。源码基线 `f316d558839da35fb1efae9979492a5d1f0c81a8`；当前为其上的 `4.0.0-dev.0` 工作树。本文不是完整版本发布声明。

## 已实现并验证

| 领域            | 证据                                         | 范围                                                                                                                          |
| --------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 无导入副作用    | `test/baseline.test.js`                      | 子进程自然退出；信号监听、stdin、global.log 均无修改；专门防止原异常处理器吞掉断言                                            |
| 生命周期        | `test/runtime.test.js`                       | 多实例、空入站、启动回滚、启动/关闭竞争、取消、超时、限额、排空和重复关闭                                                     |
| VMess           | `test/vmess.test.js`、`test/crypto.test.js`  | none/AES-GCM/ChaCha20-Poly1305/auto，多节点，账户隔离；修复 Ddata、地址偏移、校验反转、分片和响应填充；SHAKE 读取固定状态空间 |
| SOCKS / Freedom | `test/socks.test.js`、`test/runtime.test.js` | SOCKS5 无认证/密码、SOCKS4 CONNECT、分片及首包；Freedom TCP/UDP                                                               |
| 传输            | `test/transports.test.js`                    | TCP/TLS/WS/WSS，域名/IPv4/IPv6，独立 SNI/Host/path，拒绝错误证书和 Upgrade，超时、取消、二进制 WS                             |
| VLESS v0        | `test/vless.test.js`                         | 固定字节向量、逐切点解析、头/数据粘包、认证、非法命令、none/空 flow、TCP/TLS/WS/WSS                                           |
| 传统 UDP        | `test/datagram.test.js`                      | 独立接口、边界、固定目标、空帧、队列和长度限制                                                                                |
| HTTP 流契约     | `test/http-contract.test.js`                 | Freedom、VMess、VLESS 流经 Node HTTP Agent；隧道内 HTTPS 单独验证测试 CA                                                      |
| 配置            | `test/config.test.js`                        | 原生和传统 JSON 最小子集、严格诊断、Host 冲突、脱敏、路径与规范化复用                                                         |
| 类型            | `npm run check:types`                        | TypeScript 5.9.3、Node 24 声明；CommonJS/ESM 公共入口                                                                         |

实际执行平台为 Windows、Node.js 24.20.0。Linux/macOS 需由新增 CI 执行后记录，不声称已在本机验证。

当前验证命令为 `npm test`、`npm run test:interop`、`npm run check`、`npm run check:types`、`npm run format:check`、`npm run check:config` 与 `npm run test:package`。普通回归包含 100 并发 VLESS、每会话 64 KiB、暂停消费者后收取及关闭测试；它不代替 30 分钟稳定性验收，也尚未包含 reverse。

最终本机结果：普通回归 75 项通过，锁定内核互通 28 项通过，无失败或跳过；语法、类型、格式、两份配置检查与 tarball 安装检查全部通过。

打包安装检查从 `npm pack` 的实际 tarball 离线安装，只安装运行依赖；确认无 install/postinstall hook、无私有配置和测试内核、CommonJS/ESM 均可导入，空入站运行时可自然关闭。该检查使用预热的 npm 缓存。

## 固定参考内核

测试读取 v2rayN 本机已安装的两个开发对端，复制到被忽略的 `.test-tools/`。精确版本、源码参考和可执行文件 SHA256 保存在 `test/fixtures/reference-cores.json`。未从产品运行时下载或执行内核。

- Xray 24.11.5，报告源码前缀 `afc7ec5`，固定上游提交 `afc7ec55062c14ae69fc67b148155faae1c31548`。
- V2Ray 5.14.1，v2rayN 附带 `Custom` 构建；上游 tag 的源码参考为 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec`。尚未独立证明该 Custom 构建的构建来源，测试承诺绑定清单中的实际二进制校验值。

`npm run test:interop` 包含两套内核上的双向 VLESS TCP/WS/WSS、双向传统 UDP，以及双向 VMess none/AES-GCM/ChaCha20-Poly1305。缺少工具、版本或校验值不符都会失败，不能静默跳过。

Xray 参考进程设置 `xray.cone.disabled=true`，确保请求使用传统 UDP，而非自动 XUDP。该开关来自固定提交 `core/xray.go` 和 `common/platform/platform.go`；不更改用户正在运行的 v2rayN。

Windows 参考内核默认使用系统根证书路径，加载本地测试 CA 时需要 `disableSystemRoot: true`。该设置只在测试对端使用；测试仍校验证书链与 `js2ray.test` 主机名，从未关闭全局证书验证。

V2Ray 5.14.1 的 `proxy/vless/encoding/addons.go` 使用 2048 字节缓冲并可能拆分大数据报，互通用例限制到 2046 字节；不能据此声称大数据报与该版本互通。

## 私有真实配置验证

按用户授权执行 `node scripts/smoke-private.js v2ray-config.json`，仅提取 `proxy` 出站和对应 hosts 引导信息，使用 VLESS/WSS 请求 example.com。结果为 HTTP 200、运行时本地代理监听器 0。没有创建 SOCKS/HTTP 入站，证书校验保持开启。原文件未改写，私有地址、UUID、邮箱、Host 和路径没有进入仓库样例及输出。

该验证不证明远端服务端内核版本，也不证明完整参考配置已受支持。原配置的 reverse、DNS、声明式规则、嗅探、redirect 和 Blackhole 等需求仍包含未实现行为。

## 阶段门槛与后续工作

| 阶段 | 当前状态                                    | 尚缺出口证据或功能                                                                |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| P0   | 基线已建立，未完全验收                      | DNS/DoH 测试设施、完整目标资源/负载矩阵、非 Custom 官方构建来源、分阶段提交       |
| P1   | 核心运行时已实现                            | 更多慢消费者/异常注入、旧 alterId/zero 与管理 API 的最终兼容决策、Undici 契约验收 |
| P2   | 四种传输已实现并通过本机测试                | 更完整接收限额/慢消费者/关闭负载证据；WS 不提供 TCP 式半关闭                      |
| P3   | VLESS TCP/传统 UDP 已实现并通过锁定对端互通 | 扩大 UDP 传输/地址及异常矩阵后才能标记整个出口完成                                |
| P4   | 待实施                                      | 声明式路由、DNS/DoH、GeoIP/Geosite、嗅探、Blackhole、redirect、TCP 转发入站       |
| P5   | 待实施                                      | Mux.Cool 状态机、队列、隔离及固定版本互通                                         |
| P6   | 待实施                                      | Bridge/Portal、控制消息、重连、服务处理器、三种拓扑互通                           |
| P7   | 流契约测试已建立，公共适配器待实施          | HTTP/HTTPS Agent 工厂、连接池键、Undici connector/dispatcher 和取消预算           |
| P8   | 已通过本机打包安装与短时并发检查            | 三平台实际结果、100 会话/30 分钟含反代负载、完整发布文档与所有前置门槛            |

完整参考需求保存在合成的失败样例 `test/fixtures/reference-config.pending.json`，保留了悬空的 `api` 出站规则。校验器必须继续拒绝它，不通过删除未实现字段让完整配置“通过”。后续修订需另外记录；本轮没有修改 ChatRoom。
