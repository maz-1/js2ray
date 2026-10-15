# XHTTP HTTP/3 可行性评估

评估基线：2026-10-15，js2ray Node 24.20.0、纯 JavaScript 包、没有额外原生扩展或核心进程的既有约束。HTTP/3 尚未实现，本文的工期是工程估计，不是验收结果。

## 结论

主要难点是可用的 QUIC/HTTP3 运行时。XHTTP 路径、会话配对、三模式和 XMUX 策略已有基础；HTTP/2 的 socket/session 不能直接替换成 UDP。保留目前普通 Node 24 安装方式时，HTTP/3 需要另建底层能力，难度很高；允许使用启用 QUIC 的定制 Node 构建时，可先验证其公开 API，整体难度降为中高。

本机 Windows x64 及 [Windows/Linux/macOS x64 CI](https://github.com/maz-1/js2ray/actions/runs/38749322344) 的结果一致：`node --experimental-quic` 能识别开关，但 `require('node:quic')` 返回 `ERR_UNKNOWN_BUILTIN_MODULE`；`process.config.variables.node_use_quic=false`，ngtcp2/nghttp3 版本为空。可用 `node scripts/probe-http3.js` 重现；逐平台原始能力记录随 P18 机器验收汇总保存。`available=false` 只表示该二进制不能提供底层能力，不算 HTTP/3 测试通过或跳过互通验收。

Node 24.20.0 的[官方源码文档](https://github.com/nodejs/node/blob/v24.20.0/doc/api/quic.md)包含实验 QUIC 和 HTTP/3 头部/流接口，稳定性标为 Early development；[构建选项](https://github.com/nodejs/node/blob/v24.20.0/configure.py)提供编译期 `--experimental-quic`。因此“当前二进制不可用”与“该版本源码没有实现”是两个不同结论。启用该实现需要重新验收运行时、公开 API、证书验证及三个平台，不能只加一个命令行开关就承诺现有部署支持。

若考虑升级 Node，应先探测候选固定发行包，而不是仅凭大版本号判断。作为源码对照，[Node 26.0.0 的 configure_quic](https://github.com/nodejs/node/blob/v26.0.0/configure.py)仍由编译选项控制 node_use_quic；本轮未测试 Node 26 二进制，也不扩大 engines 或正式兼容范围。

## 三条实现路径

| 路径                                                    | 难度                         | 主要工作与成本估计                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启用 QUIC 的固定 Node 构建，库继续用公开 JavaScript API | 中高；推荐先做可行性原型     | 先用 3–5 个工程日验证三个系统的构建/加载、严格证书校验和 Xray 基本收发。通过后，三模式、XMUX、生命周期、故障和长时验收估计另需 4–8 工程周；运行时构建及 API 不稳定可能使估计增加。           |
| 普通 Node + dgram/crypto，自行实现 QUIC/TLS/HTTP3/QPACK | 很高；独立协议栈项目         | 完成可靠最小互通预计需数月，达到当前项目安全与稳定性门槛可能需 6–12 工程月或更多；还需长期维护和独立安全审查。当前 REALITY 的 TLS 记录实现只能复用部分密码工具，不能直接作为 QUIC TLS 接口。 |
| 额外原生扩展或独立 QUIC 进程                            | 适配中等，部署与维护成本增加 | 使用选定实现做原型约 1–2 工程周，完整交付视依赖和跨平台情况再估。需要改变当前包/运行时约束；不能把依赖隐藏在安装脚本中。                                                                     |

以上按一名熟悉代码与协议的工程师估算，包含测试开发，不包含外部平台或依赖等待时间；尚未编译定制 Node，也没有验证任何额外 QUIC 包。

## 技术工作拆分

1. 传输：QUIC 的流控、流重置、连接关闭/迁移、地址验证和资源限额；自行实现路线还需承担包编号、ACK、重传、密钥更新及拥塞控制。[RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html)、[RFC 9002](https://www.rfc-editor.org/rfc/rfc9002.html)
2. 安全：QUIC 将 TLS 握手用于密钥协商，数据由 QUIC 包保护，不走现有 TCP TLS 记录管线。验证完整证书链、SNI/目标名称、ALPN h3，处理握手取消和错误隔离。[RFC 9001](https://www.rfc-editor.org/rfc/rfc9001.html)
3. HTTP：映射请求/响应头与流、控制流/SETTINGS、GOAWAY、流错误、头部大小和 QPACK 阻塞限额；采用 Node 内置实现时优先验证它已提供的头部/帧接口，不重复实现整套编码。[RFC 9114](https://www.rfc-editor.org/rfc/rfc9114.html)、[RFC 9204](https://www.rfc-editor.org/rfc/rfc9204.html)
4. XHTTP：首先接 packet-up 的 GET/POST，再接 stream-up 和 stream-one，维持首包/头部合并、任意分片、背压、取消、限时和无重放。已有 server 处理器依赖 HTTP/1/2 的 req/res，须提炼请求与响应适配层。
5. XMUX：复用六字段策略，替换底层客户端、PING/保活和流容量探测。QUIC 保活不复用 HTTP/2 PING；session 退役、GOAWAY 和 packet-up 换上行保留相同业务语义。
6. 宿主与路由：QUIC 出站使用 UDP，Resolver 的 bootstrap、IPv4/IPv6、UDP 被阻断、MTU/路径变化及关闭清理都需新增验收。XHTTP 内传 TCP 字节流不等于底层 QUIC 使用 TCP。

固定 Xray 25.3.6 已在[客户端](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/dialer.go)和[服务端](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/hub.go)提供基于 quic-go/http3 的路径，可继续作为对照基线；具体 API 适配和三模式双向互通仍需实测。

## 建议的原型出口

先做独立 P19 可行性阶段，锁定 Node 源码、构建选项、产物摘要和参考 Xray；不要提前把 httpVersion=3 标为正式能力。

- 三个平台能加载所选公开 API；普通 Node 缺能力时给出明确诊断，HTTP/1.1/2 正常工作。
- 严格 TLS 的 GET/POST 与固定 Xray 双向互通；流式 POST 在发送请求头后保持可写，不能误发 FIN。
- 通过坏证书/错误名称、任意切分、慢消费者、取消、RST/GOAWAY、丢包/乱序/黑洞和 UDP 阻断测试，资源有界且业务字节不重放。
- 原型通过后再确定正式范围，补齐三模式、六项 XMUX、代次隔离、100 会话/30 分钟及三平台实际安装包验收。初期可将 0-RTT、会话恢复、主动连接迁移列为未支持项，但对端发送相关数据时须安全处理或明确拒绝。

采用定制 Node 路径前，应先决定是否接受新增运行时构建要求；这会改变目前普通 Node 24 即可运行的部署前提。
