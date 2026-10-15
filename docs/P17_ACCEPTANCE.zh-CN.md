# P17 验收与可观测性加固

本阶段保留既有 Node 24.20.0、Xray 25.3.6/24.11.5、V2Ray 5.14.1 固定参考矩阵，补齐 P14–P16 验收盲区。所有新测试、负载和故障均使用独立合成材料；没有进行真实节点试探。

入站专项 10 项覆盖 REALITY 超时/cover 建连失败、正常未认证转发、连接限额、运行时关闭、TLS/WSS/Vision/XHTTP 的早期握手失败、WS Upgrade 拒绝、诊断采样和轮换归属。每个物理连接只有一次传输握手结果；错误累计不采样，诊断每实例每秒最多 8 条。transport 指标只反映可见流/门控/记录队列，不将其冒充内核或 OpenSSL 内存。

短负载实际发现 WSS/XHTTP 父 TCP 计时器会在传输就绪后继续生效；HTTP/2 对外 Socket 代理的 setTimeout 操作针对 session，也不能清除已设置的 TLS Socket 预算。实现按公开事件显式移交 TCP/TLS/HTTP2 超时所有权，新增 WSS、HTTP/1.1 packet-up/stream-one 与 HTTP/2 stream-one 的持续传输回归共 4 项，均超过握手预算仍正确往返。没有靠加长握手预算绕过问题。

CI 的普通测试按文件串行运行，避免多个独立的 100 并发握手用例同时争用共享 CPU，仍保留用例内部 Promise.all 的真实 100 并发及默认 10 秒握手预算，短超时失败用例也不变。显式命令为 `node --test --test-concurrency=1 --test-timeout=15000 test/*.test.js`；选项位于文件参数前，追加到 npm test 文件列表之后不会生效。开发者的普通 npm test 入口仍保留默认调度。

REALITY 新增负向 11 项：证书 HMAC、CertificateVerify 和双方 Finished 篡改，Brotli 解压炸弹/超限声明/长度错误/算法错误/损坏数据，认证成功的压缩证书分片，以及固定种子的 512 次 ClientHello 变异/低阶 X25519/超长记录拒绝。失败客户端在完整 ClientHello 后不发送 VLESS 或业务字节；服务端拒绝已正确加密但 Finished 内容错误的请求，真实业务目标收到的连接数为零。

cover 专项 12 项分别强制单记录/四记录与三种套件组合，并验证双向 Vision Direct；记录长度逐一比较，HRR、缺少 CCS、空间不足和截断必须失败。CLI `check-cover` 使用相同的镜像兼容性解析路径，不创建入站监听、不输出目标/凭据。另有 2 项固定 Xray 25.3.6 的 Go TLS cover 双向互通，明确断言四记录布局，保留原 Node/OpenSSL cover。它们补充既有互通矩阵，不宣称任意目标或浏览器指纹都兼容。

隐私审计专项 2 项覆盖原生/传统用户与节点字段、UUID 变体、prefix、端口、Host/SNI/path/鉴权头、REALITY key 的 base64url/base64/hex 变体及 short IDs；独立临时 Git 仓库证明删除的历史密钥仍被检测，报告不输出值。本地实际安装 tarball 后逐文件执行真实私有字段审计；真实配置不传 CI。局部明文匹配审计不等同于通用秘密检测器，公开协议端口和本地端点身份不视为私有远端身份。

长时验收使用单独的三平台工作流，固定每个平台 100 会话和至少 30 分钟；文档提交只执行普通 CI，改变产品/负载相关源码才触发长时工作流。9 组负载包括 HTTP/1.1 与 HTTP/2 的三种 XHTTP 模式共 30 会话，原生 TLS Vision 30 会话，REALITY Vision 30 会话及空 flow 10 会话。两组 Vision 各含 20 个实际内层 TLS 1.3 双向 Direct、5 个 TLS 1.2 和 5 个普通 TCP。每轮对比 4096 字节；10 个慢消费者；每分钟轮换全部端点的 UUID、XHTTP path、REALITY 私钥/short ID/cover 目标，旧连接继续工作，新代通过真实业务就绪探测。每轮关闭 cover 接入验证新请求失败后再恢复，旧流继续工作。

负载每秒采集 RSS、heap、应用/传输/Mux 队列、待握手数和配置代数，每分钟保存样本，记录延迟直方图、最大值、机器、配置与规范化源码 SHA256。RSS 上限 1 GiB，传输队列上限按 100 会话的有限队列预算检查；这些阈值和样本不构成吞吐性能承诺。关闭后全部管理器的代数、连接、待拨号和监听器必须为零。短运行标记 formalAcceptance=false，不能替代完整验收。

复现：

```sh
node --test test/inbound-metrics.test.js test/reality-negative.test.js test/reality-cover.test.js test/private-audit.test.js
node --test test/interop/reality-cover.test.js
npm run check
npm run check:types
npm run format:check
npm run check:config
npm test
npm run test:tools
npm run test:interop
npm run test:package
npm run test:stability:transports
```

Windows 2022、Ubuntu 24.04、macOS 15 Intel、Node 24.20.0 的 [完整回归](https://github.com/maz-1/js2ray/actions/runs/38733773509) 全部通过：每个平台 275/275 普通测试、158/158 固定参考互通，失败/取消/跳过均为零；语法、类型、格式、配置及实际 tarball 安装也均通过。回归提交为 `7f79809f41c0d247450db11c8e7554f68ab89e77`。新增普通专项共 39 项，固定 Go TLS cover 对照新增 2 项。验收时包内共 111 个文件，增加本节汇总和三份原始记录后增加四个文档文件，产品源码和依赖不变。

[三平台长时工作流](https://github.com/maz-1/js2ray/actions/runs/38733509036) 使用功能提交 `80c5908d4b5216f135044179ca51ca1551382de9`，与回归提交的产品源码及负载脚本完全一致。逐平台原始结果如下；bytes 为每次往返所校验的单份应用负载长度之和，不等同于双向网卡流量。

| 平台            | 时长 ms | 完整往返次数 |   校验字节 | 轮换/故障恢复 | RSS 峰值 MiB | heap 峰值 MiB | 可见传输队列峰值 B |
| --------------- | ------: | -----------: | ---------: | ------------: | -----------: | ------------: | -----------------: |
| Windows x64     | 1800310 |      1192456 | 4884299776 |         29/29 |        179.3 |          45.4 |             196928 |
| Linux x64       | 1800300 |      1377202 | 5641019392 |         29/29 |        300.4 |          47.4 |              77854 |
| macOS Intel x64 | 1800137 |      1304761 | 5344301056 |         29/29 |        294.4 |          47.9 |             196928 |

三个平台均保持 100 条原始会话；每组 Vision 的 20 条真实内层 TLS 1.3 会话逐一完成两端读写 Direct，TLS 1.2/普通流量不切换。全部 18 个管理器关闭后配置代、连接、待拨号和监听器为零；最终无待握手和 Mux 队列积压。完整延迟直方图、逐秒采样峰值、分钟样本、每轮配置代快照、配置摘要、源码摘要与关闭状态保存在 [Windows 原始记录](acceptance/p17-stability-win32-2026-10-15.json)、[Linux 原始记录](acceptance/p17-stability-linux-2026-10-15.json)、[macOS 原始记录](acceptance/p17-stability-darwin-2026-10-15.json)。这些文件保持上传原字节，SHA256 与 artifact 元数据一起记录；不经格式化重写。

[机器可读汇总](acceptance/p17-2026-10-15.json) 从实际完整作业日志核验测试数和安装包结果，保存逐平台作业、artifact、原始记录摘要、79 个产品源码（含 CLI）的规范化 Git SHA256 及本地隐私审计。源码汇总为 `b3b869f731b9696b650d143abf23b3a025b55ee4a551c16203c1b7aed527cc99`；Git 与负载记录统一按 UTF-8、CRLF 转 LF 比较。原始负载记录及负载脚本摘要逐项核验通过，证据不依赖之后仍能下载临时 artifact。
