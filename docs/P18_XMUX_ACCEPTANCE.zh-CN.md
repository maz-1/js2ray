# P18 XHTTP XMUX 验收

实现范围为固定 Xray 25.3.6（提交 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`）的完整六字段 XMUX，HTTP/1.1、HTTP/2 的 packet-up、stream-up、stream-one。原生配置及传统 JSON/extra 均校验。参考源码：[配置和默认值](https://github.com/XTLS/Xray-core/blob/v25.3.6/infra/conf/transport_internet.go)、[客户端池选择](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/mux.go)、[请求计数和保活](https://github.com/XTLS/Xray-core/blob/v25.3.6/transport/internet/splithttp/dialer.go)。

HTTP 客户端池按 Runtime、网络配置和代次隔离；异步握手前预留并发，取消一个等待者不取消其他等待者，全部取消后关闭无主连接。计数或时长达到上限后退役并排空；packet-up 可为后续 POST 更换上行客户端，保留原 GET，业务字节不重放。HTTP/2 GOAWAY 后已接受的流保留，新流切换；对端 TCP FIN 及时释放物理连接和全部流。池与可见资源指标见 API 文档。

`test/xmux.test.js` 37 项专项覆盖六字段/范围/默认值/互斥/错误路径、两种 HTTP 版本及有无 TLS 的三模式共享、取消隔离、并发预留、复用和请求预算、时长退役、GOAWAY、远端流容量、RST、物理断链、PING 开关及真正的读取空闲、ref/unref 隔离、实例/代次隔离和关闭。保活使用公开 socket.bytesRead 观测原生 nghttp2 的入站 DATA/控制帧，持续入站推迟 PING、只有出站写入不推迟；不添加数据消费者。既有 XHTTP 轮换测试验证复用已认证 TLS session 时旧路径拒绝新流，不假定每个逻辑流重做 TLS 握手。

`test/interop/xmux.test.js` 新增 12 项对照，严格 TLS HTTP/1.1、HTTP/2 三模式双向；每项持有旧业务流超过 1 秒复用时长，同时验证新流、请求预算轮换及取消隔离。Xray 该版本的 packet-up 要求 scMaxEachPostBytes 大于其 8192 字节内部缓冲，专项使用 16384 字节。归档和二进制摘要沿用 `reference-platforms.json`，不读取真实节点或用户配置。

`npm run test:stability:xmux` 默认运行 100 个持久会话、30 分钟、六种严格 TLS HTTP 版本/模式，含 10 个慢消费者；每秒每配置建立/关闭临时业务连接，每分钟两端轮换 UUID/path。测试配置使用 maxConcurrency=4–6、cMaxReuseTimes=8–12、hMaxRequestTimes=24–36、hMaxReusableSecs=2–4 秒、hKeepAlivePeriod=1 秒，持续触发退役。逐次检查字节、记录 RSS/heap/队列/池/socket 数、请求和退役计数、源码/配置/脚本摘要，关闭后全部管理器资源必须归零。短时调试标记 formalAcceptance=false。

## 正式结果（2026-10-15）

[三平台全量回归](https://github.com/maz-1/js2ray/actions/runs/38749322344) 对应产品提交 `74d4529f36db80446b77305ae5f9b0b08766a8af`，Windows/Linux/macOS x64、Node 24.20.0 各通过 312 项普通测试、170 项固定内核互通，无失败、跳过或取消；实际 tarball 安装、类型、配置、格式和语法检查通过，不含额外原生运行资产。

[XMUX 正式长时](https://github.com/maz-1/js2ray/actions/runs/38749322880) 每平台均为 100 持久会话、六种严格 TLS 组合，结果如下：

| 平台        | 实际时长 ms | 往返校验次数 | 临时连接 | 轮换次数 | 峰值 RSS MiB | 池故障 |
| ----------- | ----------: | -----------: | -------: | -------: | -----------: | -----: |
| Windows x64 |     1800729 |      1207029 |    10272 |       29 |        263.6 |      0 |
| Linux x64   |     1800651 |      1397683 |    10332 |       29 |        284.6 |      0 |
| macOS x64   |     1800518 |      1245723 |     9288 |       29 |        268.5 |      0 |

临时连接计数不含初始会话和 readiness 探测；字节总量按每次比较的一份 payload 统计，不把双向线速相加。RSS 是同一进程内客户端、服务端和测试目标的整体内存，队列指标只包含可见的 Node 流缓冲。采样捕获的客户端计数分别为 16946/19321/17148，已退役 16789/19156/16992；峰值池数量 37/40/37、socket 数 100/96/96，关闭后全部 12 个管理器的 generations/connections/pendingDials/listeners 均归零。保活专项已独立断言持续入站时不发空闲 PING；长时采样成功 PING 分别为 7/3/859，真实空闲及调度条件不同，不据此作跨平台性能排名。

[P14–P16 混合传输正式回归](https://github.com/maz-1/js2ray/actions/runs/38749322553) 同一产品源码每平台也完成 100 会话/30 分钟、29 次轮换及 29 次 cover 故障恢复；Windows/Linux/macOS 分别完成 1178054/1382129/1289708 次逐字节往返校验，峰值 RSS 233.7/292.0/285.7 MiB，全部 18 个管理器关闭后资源归零。

全量回归、两组长时、当前 HEAD 和工作区的 80 个产品源码按 UTF-8/CRLF→LF 核验一致，汇总 SHA256 为 `fbd3e69f320246067daba12c1ec7a9d98d6e0f28fa42b87969093bc326eae939`。归档下载验证 GitHub artifact digest，每份原始 JSON 原样保存并记录 rawSha256；不格式化原始记录。详细数据、逐平台日志链接、配置/脚本摘要及隐私审计见[机器可读汇总](acceptance/p18-2026-10-15.json)。

三平台的 HTTP/3 信息性探测均记录 compiledWithQuic=false、`ERR_UNKNOWN_BUILTIN_MODULE`，不计作 HTTP/3 互通。实现路径和工程估计见 [HTTP/3 评估](HTTP3_FEASIBILITY.zh-CN.md)。HTTP/3、跨节点 downloadSettings 和 XHTTP+REALITY 仍未实现。
