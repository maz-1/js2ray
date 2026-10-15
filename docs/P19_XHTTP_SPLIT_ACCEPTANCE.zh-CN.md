# P19 XHTTP 上下行分离验收

基线：Node 24.20.0、Xray 25.3.6、Caddy 2.10.0，HTTP/3 继续暂缓。产品保持纯 JavaScript，运行依赖仅 ws；参考内核和 Caddy 只在测试中使用。[三平台全量回归](https://github.com/maz-1/js2ray/actions/runs/38771437742) 每平台 339 项普通/202 项参考互通、实际 tarball 安装及配置/类型/格式全部通过，无失败、跳过或取消。三平台的分离、XMUX 和混合传输共九组 100 会话/30 分钟正式长时也全部通过，原始记录已保存。

原生 `option.downloadSettings` 为完整 XHTTP Network；传统字段为含 address/port 的 Xray StreamSettings。上行与下行分别校验地址、TLS/SNI、Host、路径、请求头、HTTP 版本和 XMUX。下行使用同一 UUID 的 GET，上传模式由上行决定；拒绝 stream-one 分离、嵌套配置、HTTP/3、REALITY 和非 XHTTP 下行。服务端不共享跨监听器会话，两条代理入口必须汇聚至同一后端监听器。

普通专项 `test/xhttp-split.test.js` 覆盖四种 HTTP 版本组合、auto、明文和严格 TLS、双向 HTTP 版本转换、二进制与独立入口、取消隔离、两侧错误 TLS 名称及 CA、独立域名引导解析、503/302/响应头超时、上传缓冲死锁、单侧断链、packet-up 请求退役、下行 GOAWAY、跨代下行地址更换与失败回滚。物理客户端关闭通知绑定当前租约；上传迁移后取消旧通知，避免旧连接影响仍在工作的分离连接。释放租约时移除通知，不保留额外用户引用。body 在空 readable 通知时调用 read(0)，保证 EOF 可被观察且不消费业务数据。

参考互通 `test/interop/xhttp-split.test.js` 包含 Node 代理和 Caddy 两类部署，每类 16 项：packet-up/stream-up、四种严格 TLS 上下行版本组合和两个方向。每项并发持有两条流，逐字节比较二进制，跨越上传池复用时限后继续传输并检查取消隔离。Node 代理另外提供有界的故障注入和 HTTP/2 上游转换；Caddy 终止前端 TLS 并转 HTTP/1.1 后端，不把两个进程内端点的自测代替参考互通。

Caddy 的三个归档先与官方 SHA512 发布表比对，再记录归档 SHA256 和提取后二进制 SHA256，见 `test/fixtures/reference-proxies.json`。安装器和互通入口均校验固定摘要，缺失工具直接失败。测试配置关闭管理 API、自动证书申请及 HTTP/3；临时存储和子进程均由测试清理。HTTP/1.1 流式代理启用 full duplex、即时 flush 和上游 Connection: close；各入口固定 ALPN，以避开固定 Xray 指纹提供 h2 但采用 HTTP/1 客户端时的协商不一致。

`npm run test:stability:xhttp-split` 默认 100 条持久会话/30 分钟，八种模式/HTTP 版本组合；前四组通过 Node 代理，后四组通过固定 Caddy 和可注入故障的 HTTP 网关。包含 10 个慢消费者、临时连接、两侧独立 XMUX 预算退役、每分钟路径/UUID 轮换以及每个部署的新 GET 拒绝/恢复；旧流继续逐字节工作。记录源码/配置/负载/代理脚本摘要、RSS/heap、队列、连接池、时延及退出后的管理器与 Caddy 进程状态。Node RSS 不含独立 Caddy 进程，不作为全部署内存或吞吐承诺。小于 30 分钟标记 formalAcceptance=false。

实际 tarball 安装检查补充独立代理入口的 HTTP/2 上传和 HTTP/1.1 下载、两池计数、业务完整性、零本地客户端监听及关闭归零。文档修复历史“逻辑连接独占池”描述；XMUX 长时触发包含所有产品目录、fixture 及依赖，P19 独立工作流沿用相同范围。

复现命令：

```sh
npm run check
npm run check:types
npm run format:check
npm run check:config
node --test --test-concurrency=1 --test-timeout=15000 test/*.test.js
npm run test:tools
npm run test:interop
npm run test:package
npm run test:stability:xhttp-split
npm run test:stability:xmux
npm run test:stability:transports
```

首轮正式长时在约 330 秒失败：Node 测试代理的 HTTP/1 整请求期限仍为默认 300 秒。修正测试代理的 requestTimeout=0 后重新执行正式长时；产品入站原已关闭整请求期限，仍保留握手、取消及逻辑空闲预算。首轮失败与短跑均不作为正式通过证据。

## 正式结果（2026-10-16）

[上下行分离正式长时](https://github.com/maz-1/js2ray/actions/runs/38772075331) 使用八种模式/HTTP 版本组合，结果如下：

| 平台        | 实际时长 ms | 往返校验次数 | 临时连接 | 轮换次数 | 代理故障恢复 | Node RSS 峰值 MiB |
| ----------- | ----------: | -----------: | -------: | -------: | -----------: | ----------------: |
| Windows x64 |     1800494 |      1109243 |    11952 |       29 |          232 |             250.6 |
| Linux x64   |     1800893 |      1355179 |    12392 |       29 |          232 |             332.6 |
| macOS x64   |     1801026 |       778359 |     4886 |       29 |          232 |             339.2 |

三平台的池异常关闭计数均为零，16 个管理器关闭后 generations/connections/pendingDials/listeners 全部归零，四个 Caddy 子进程全部退出。各侧的配置和脚本摘要保存在原始记录中。故障恢复计数表示每次轮换的八个新下行拒绝与恢复检查，既有会话同时继续校验；不对已发送业务数据重试。临时连接计数不含初始会话和 readiness 探测，字节总量按校验 payload 统计，不把双向线速相加。Node RSS 不包含 Caddy 的进程内存，结果不用于跨平台性能排名。

同一产品源码的 [XMUX 正式回归](https://github.com/maz-1/js2ray/actions/runs/38770712593) 和 [P14–P16 混合传输正式回归](https://github.com/maz-1/js2ray/actions/runs/38770712799) 结果如下；每组均为 100 持久会话：

| 负载     | 平台        | 实际时长 ms | 往返校验次数 | 轮换次数 | cover 故障恢复 | Node RSS 峰值 MiB |
| -------- | ----------- | ----------: | -----------: | -------: | -------------: | ----------------: |
| XMUX     | Windows x64 |     1800338 |      1208821 |       29 |              — |             266.2 |
| XMUX     | Linux x64   |     1800543 |      1394325 |       29 |              — |             283.2 |
| XMUX     | macOS x64   |     1800735 |      1346568 |       29 |              — |             264.4 |
| 混合传输 | Windows x64 |     1800171 |      1179622 |       29 |             29 |             246.5 |
| 混合传输 | Linux x64   |     1800280 |      1382097 |       29 |             29 |             295.6 |
| 混合传输 | macOS x64   |     1800318 |      1319354 |       29 |             29 |             279.7 |

XMUX 的池异常关闭计数均为零，12 个管理器关闭归零；混合传输的 18 个管理器也全部关闭归零。队列、heap、时延及每次采样的原始数据均保留，队列指标表示脚本可见的 Node 流缓冲，不代表所有内核或代理内部缓冲。

全量回归及分离长时对应提交 `617d2a69361d9508a13b0081ef8376f657390043`，另两组长时对应 `4456d6807cc6f144f68ac7f8b53461cda957c216`。80 个产品源码在所有验收提交、当前 HEAD 和工作区逐文件一致，UTF-8/CRLF→LF 汇总 SHA256 为 `5d13786a11049bc5783b1e475bdf0386f08be57b4bbffac565cba4a3f12e5492`；对应负载脚本也一致。下载时验证 GitHub artifact digest，九份原始 JSON 按字节保存，并记录 rawSha256，排除自动格式化和换行改写。逐平台作业链接、参考工具摘要、产品及负载源码摘要、隐私审计见 [机器可读汇总](acceptance/p19-2026-10-16.json)。

三平台信息性探测均为 compiledWithQuic=false；HTTP/3 继续等待 Node.js 原生 QUIC 支持稳定，不计作本轮支持或互通结果。
