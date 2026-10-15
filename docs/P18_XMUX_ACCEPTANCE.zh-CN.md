# P18 XHTTP XMUX 验收

实现范围为固定 Xray 25.3.6（提交 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`）的完整六字段 XMUX，HTTP/1.1、HTTP/2 的 packet-up、stream-up、stream-one。原生配置及传统 JSON/extra 均校验。参考源码：[配置和默认值](https://github.com/XTLS/Xray-core/blob/v25.3.6/infra/conf/transport_internet.go)、[客户端池选择](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/mux.go)、[请求计数和保活](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/dialer.go)。

HTTP 客户端池按 Runtime、网络配置和代次隔离；异步握手前预留并发，取消一个等待者不取消其他等待者，全部取消后关闭无主连接。计数或时长达到上限后退役并排空；packet-up 可为后续 POST 更换上行客户端，保留原 GET，业务字节不重放。HTTP/2 GOAWAY 后已接受的流保留，新流切换；对端 TCP FIN 及时释放物理连接和全部流。池与可见资源指标见 API 文档。

`test/xmux.test.js` 34 项专项覆盖六字段/范围/默认值/互斥/错误路径、两种 HTTP 版本及有无 TLS 的三模式共享、取消隔离、并发预留、复用和请求预算、时长退役、GOAWAY、远端流容量、RST、物理断链、PING 开关、ref/unref 隔离、实例/代次隔离和关闭。既有 XHTTP 轮换测试调整为验证复用已认证 TLS session 时旧路径拒绝新流，不再假定每个逻辑流重做 TLS 握手。

`test/interop/xmux.test.js` 新增 12 项对照，严格 TLS HTTP/1.1、HTTP/2 三模式双向；每项持有旧业务流超过 1 秒复用时长，同时验证新流、请求预算轮换及取消隔离。Xray 该版本的 packet-up 要求 scMaxEachPostBytes 大于其 8192 字节内部缓冲，专项使用 16384 字节。归档和二进制摘要沿用 `reference-platforms.json`，不读取真实节点或用户配置。

`npm run test:stability:xmux` 默认运行 100 个持久会话、30 分钟、六种严格 TLS HTTP 版本/模式，含 10 个慢消费者；每秒每配置建立/关闭临时业务连接，每分钟两端轮换 UUID/path。测试配置使用 maxConcurrency=4–6、cMaxReuseTimes=8–12、hMaxRequestTimes=24–36、hMaxReusableSecs=2–4 秒、hKeepAlivePeriod=1 秒，持续触发退役。逐次检查字节、记录 RSS/heap/队列/池/socket 数、请求和退役计数、源码/配置/脚本摘要，关闭后全部管理器资源必须归零。短时调试标记 formalAcceptance=false。

当前本地专项及 12 项参考对照已通过；全量回归、实际安装包、三平台及正式长时证据待本轮 CI 结束后记录。HTTP/3、跨节点 downloadSettings 和 XHTTP+REALITY 仍未实现。
