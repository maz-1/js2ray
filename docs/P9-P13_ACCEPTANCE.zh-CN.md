# P9–P13 扩展验收

Node.js 24.20.0，包版本 `4.0.0-dev.0`。本轮按用户指定顺序扩展，并在每项完成后更新 `DEVELOPMENT_PLAN.zh-CN.md`。没有修改 ChatRoom、合并主分支或发布 npm。

| 阶段               | 交付接口与行为                                                                                                                    | 专项证据                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P9 错误与指标      | 已建立连接的错误事件、写回调、数据报读取统一为 Js2rayError；runtime.metrics 提供实例计数、耗时、DNS 缓存、Mux 队列和 reverse 状态 | metrics/runtime 专项 17 项；不启动流动、实例隔离、快照隔离、原始错误保留在 cause 而不进入日志                    |
| P10 应用 WebSocket | createWebSocket 支持 WS/WSS、子协议、鉴权头、严格目标 TLS、取消、心跳、有界消息/队列/关闭与大消息分片                             | 专项 6 项；普通连接、VMess、VLESS Mux 上真实 Upgrade；256 KiB 消息；失败与发送状态回调                           |
| P11 DNS 联动路由   | AsIs/IPIfNonMatch/IPOnDemand，全部 A/AAAA 地址参与匹配，保留转发域名，显式出站绕过，DNS 自身引导防递归                            | 本地 DNS/路由专项；两个固定参考内核的两种新增策略共 4 项对照                                                     |
| P12 UDP 扩展       | SOCKS5 关联、VMess、VLESS Mux、XUDP 每包地址、reverse TCP/UDP；数据报保持独立并受队列限制                                         | 新增 32 项参考互通；IPv6/域名/空包、并发 reverse、大包、取消、EOF、内核 EMSGSIZE；内存承载独立验证 65535 字节帧  |
| P13 平滑轮换       | createRuntimeManager，候选预检/探测、提交切换、按代连接池、旧会话限时排空、失败回滚；同端口认证与证书更新                         | 专项 15 项；VLESS/VMess UUID、TLS/WSS 证书、Node/Undici 活动与排队请求、UDP/WS、并发关闭、存储写入归属和自然退出 |

## 三平台与参考互通

[功能版本 CI](https://github.com/maz-1/js2ray/actions/runs/38694178123)，提交 `5bb4a15215d206401efbf91ccc59f651073e5359`：Windows Server 2022、Ubuntu 24.04、macOS 15 Intel 均完成语法、类型、格式、配置、148 项普通回归、106 项参考互通和实际 tarball 安装验收，没有失败或跳过。

参考内核继续锁定 V2Ray 5.14.1 与 Xray 24.11.5；可执行文件和官方归档摘要沿用 `test/fixtures/reference-platforms.json`。UDP 新增对照覆盖 SOCKS5 密码认证、VMess none/AES-GCM/ChaCha20、Mux TCP/WSS 双向、两个混合 reverse 拓扑，以及 Xray 默认 XUDP。参考互通分别验证两个方向，不以 JS 自连接替代。

## 长时间负载

最终源码的两组独立 100 会话/30 分钟负载均通过：原有回归 1800116 ms、1496453 轮、6129471488 字节；混合负载 1800458 ms、29 次凭据轮换、4525241856 字节。每轮检查内容身份，关闭后连接、待拨号、监听器、reverse 承载及配置代次均为零，进程自然退出。

[原有负载原始记录](acceptance/p9-p13-tcp-stability-2026-10-15.json)、[混合负载原始记录](acceptance/p9-p13-mixed-stability-2026-10-15.json) 与 [机器可读汇总](acceptance/extensions-2026-10-15.json) 保存 SHA256。两组记录中的所有 61 个运行时 JS 文件均与最终本地测试源码逐字节一致；Windows 保留源文件的 CRLF/LF 差异另按 LF 规范化，与功能提交逐文件核对一致，汇总附规范化摘要。提交后的行为差异为零，后续变化仅为测试断言和验收文档。短跑和已中止试跑不作为正式证据。

- 原有回归：50 VLESS Mux TCP + 50 reverse TCP，含 10 个慢消费者。
- 扩展负载：40 Mux TCP + 30 UDP（SOCKS/VMess/Mux）+ 30 应用 WS/WSS；保持旧连接通信，两端每分钟轮换一次合成凭据，并对新配置执行实际数据探测。

```sh
npm run test:stability
npm run test:stability:extensions
```

## 兼容边界

UDP 的协议帧上限与内核发送上限分别验证：Windows/Linux 实际传输 60000 字节；macOS 读取 `net.inet.udp.maxdgram`，保留 SOCKS 地址头预算，并验证超限错误及后续正常发送。不会修改全局内核参数。XUDP 支持每包地址封装，不跨断开的承载恢复 NAT 身份。参考大包承诺仅覆盖已测试尺寸，详见 API 文档。

轮换默认等待候选资源启动；需要验证实际节点认证或业务可达时，宿主提供 ready 探测。已有业务不迁移、不重放，预算耗尽后关闭。同端口复用需保持 TCP/WS 与有无 TLS 的传输类型；换类型可预先使用另一端口。文件存储只由当前提交代写入，指标和 VMess 动态计数按代管理。

私有 `v2ray-config.json` 始终被 Git 和发布包排除。每次推送前扫描已跟踪文件及新增历史 blob 的真实用户 ID、prefix、地址、非标准端口、邮箱、Host、SNI 和路径；检查结果只输出字段/文件，不输出私有值。

最终源码使用用户授权的真实 proxy 出站完成一次 VLESS/WSS 请求，返回 HTTP 200，本地代理监听器为 0。该记录仅覆盖实际出站请求，原文件没有改写或上传。
