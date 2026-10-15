# P16 REALITY 验收

实现基线为 Node.js 24.20.0 与固定 Xray 25.3.6（源码 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`）。复用 `reference-cores.json` / `reference-platforms.json` 的 `xray-xhttp` 工具键及三平台归档和可执行文件 SHA256；REALITY 依赖固定为 `48f0b2d5ed6d`，uTLS 为 1.6.7。所有目标、证书、用户和密钥独立合成，未读取真实节点凭据进行 REALITY 试探。

原型先通过 4 项真实互通才接入 Runtime：纯 Node 客户端到 Xray 分别强制三种 TLS 1.3 套件并验证真实加密响应，Xray Chrome 客户端到纯 Node 服务端验证镜像握手、客户端 Finished 和业务响应。实现使用公开 crypto/net/stream API，无 Node 私有 TLS 状态、原生扩展、WASM 或产品内启动的外部内核。

新增 27 项普通测试覆盖固定记录向量、Session ID 完整 ClientHello AAD、密钥/short ID/SNI/时间/版本认证、强制证书 HMAC、分片与非法记录、单字节密文、缓冲明文、半关闭、KeyUpdate、Direct 粘包、慢读与读水位限额、超时/取消、正常 TLS 与畸形握手的固定目标转发、IPv6/引导 DNS、配置校验与脱敏，以及同端口私钥/short ID/UUID/dest 轮换和失败回滚。入站连接限额在连接 cover 之前执行，关闭运行时会取消尚未认证的握手。100 并发真实内层 TLS 1.3 会话逐一完成双向 Direct，关闭后连接和队列归零。

固定 Xray 的正式 Runtime 对照为 17 项，加上前述 4 项原型共 21 项：空 flow 与 Vision 两种方式、普通 TCP/内层 TLS 1.2/1.3、客户端/服务端两个方向，传统 UDP 与 Vision XUDP 两个方向，以及从固定 Xray 捕获的 Chrome ClientHello 字段对照。TLS 1.3 必须实际发生读写 Direct，其他流量必须保持未切换。每条 TCP 会话多次校验 17、65539、524307 字节；参考 UDP 使用 1400 字节，不把 JS 两端较大数据报能力外推给 Xray。

实际 tarball 安装后建立 REALITY 客户端/服务端、固定 TLS 1.3 cover 和独立内层 TLS 目标，验证业务字节及两端双向 Direct。安装验证保留 CJS/ESM、生命周期、XHTTP 和原生 TLS Vision 检查；产品运行依赖仍仅 ws，测试工具与证书不进包。

复现命令：

```sh
node --test test/reality-codec.test.js test/reality-stream.test.js test/reality.test.js
node --test --test-concurrency=1 test/interop/reality-prototype.test.js test/interop/reality.test.js
npm run check
npm run check:types
npm run format:check
npm run check:config
npm test
npm run test:tools
npm run test:interop
npm run test:package
```

Windows 2022、Ubuntu 24.04、macOS 15 Intel 的 [三平台 CI](https://github.com/maz-1/js2ray/actions/runs/38719238453) 全部通过，功能提交为 `0abc16233d50b3b23373fab72bd729253395b449`。每个平台 236/236 普通回归、156/156 参考互通，失败、取消和跳过均为零；语法、类型、格式、配置和实际 tarball 安装均通过。验收时包内共 108 个文件，新增本节机器证据后增加一个文档文件，产品源码与运行依赖不变。

[机器可读证据](acceptance/reality-2026-10-15.json) 从实际完整作业日志提取测试数与包验证结果，保存逐平台作业链接和 77 个产品源码的规范化 Git SHA256；源码汇总为 `56f744db79b6c4866a90098f1b7125c7ba0a63e704454988793b2bbbd2106526`。推送前本地审计覆盖 184 个跟踪文件与 355 个历史 blob，未匹配私有用户 ID、prefix、服务器地址或非标准端口。实现边界、目标握手布局约束、固定非 PQ Chrome 120 模板及不支持项见 [API](API.zh-CN.md#realityp16)。

协议参考：[固定 Xray REALITY 客户端](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/transport/internet/reality/reality.go)、[固定 REALITY 服务端握手](https://github.com/XTLS/REALITY/blob/48f0b2d5ed6d/handshake_server_tls13.go)、[固定 uTLS 模板](https://github.com/refraction-networking/utls/blob/v1.6.7/u_parrots.go)、[TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)、[证书压缩](https://www.rfc-editor.org/rfc/rfc8879.html)。
