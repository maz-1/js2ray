# P19 XHTTP 上下行分离验收

基线：Node 24.20.0、Xray 25.3.6、Caddy 2.10.0，HTTP/3 继续暂缓。产品保持纯 JavaScript，运行依赖仅 ws；参考内核和 Caddy 只在测试中使用。[三平台全量回归](https://github.com/maz-1/js2ray/actions/runs/38769117110) 每平台 339 项普通/202 项参考互通、实际 tarball 安装及配置/类型/格式全部通过；正式长时结果待完成后记录，未完成项见开发计划。

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
