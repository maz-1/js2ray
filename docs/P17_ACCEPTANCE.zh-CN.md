# P17 验收与可观测性加固

本阶段保留既有 Node 24.20.0、Xray 25.3.6/24.11.5、V2Ray 5.14.1 固定参考矩阵，补齐 P14–P16 验收盲区。所有新测试、负载和故障均使用独立合成材料；没有进行真实节点试探。

入站专项 10 项覆盖 REALITY 超时/cover 建连失败、正常未认证转发、连接限额、运行时关闭、TLS/WSS/Vision/XHTTP 的早期握手失败、WS Upgrade 拒绝、诊断采样和轮换归属。每个物理连接只有一次传输握手结果；错误累计不采样，诊断每实例每秒最多 8 条。transport 指标只反映可见流/门控/记录队列，不将其冒充内核或 OpenSSL 内存。

短负载实际发现 WSS/XHTTP 父 TCP 计时器会在传输就绪后继续生效；HTTP/2 对外 Socket 代理的 setTimeout 操作针对 session，也不能清除已设置的 TLS Socket 预算。实现按公开事件显式移交 TCP/TLS/HTTP2 超时所有权，新增 WSS、HTTP/1.1 packet-up/stream-one 与 HTTP/2 stream-one 的持续传输回归共 4 项，均超过握手预算仍正确往返。没有靠加长握手预算绕过问题。

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

三平台完整回归与长时结果待实际执行后填写，原始 JSON 将与工作流、作业、源码及负载脚本摘要一起保存。
