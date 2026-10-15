# P6 验收范围

传统 reverse 参考固定 V2Ray `app/reverse/{bridge,portal,reverse}.go` 及 `config.proto`。控制目标为 TCP 配置 domain:0；Portal 在该流上发起 Mux，Bridge 接受 Mux；保留的 `reverse.internal.v2fly.org:0` UDP 会话承载逐帧 protobuf Control（ACTIVE=0，DRAIN=1）。普通 outbound mux=false 不影响 reverse 内部 Mux。

验收包含 js2ray Bridge→参考 Portal、参考 Bridge→js2ray Portal、js2ray 双端三类拓扑，HTTP、HTTPS、流数据、并发、控制状态、传输中断、Portal 重启、退避重连和清理。Mux 的 END 为会话双向关闭；不承诺任意应用协议的 TCP 半关闭响应，必须记录实际测试行为。运行时状态、reverse 传输状态和业务结果分别报告。进程内服务由调用者显式注册，配置固定允许目标，不开放任意处理器分发。

已执行 `test/reverse.test.js`、`test/interop/reverse.test.js`、`test/interop/reverse-http.test.js`：三种拓扑的并发、HTTP/HTTPS 256 KiB 分块响应、Portal 重启后旧业务关闭与新业务恢复、缺失/非法服务处理器、精确目标范围和释放。两个固定参考 Bridge 均没有入站监听；测试通过固定版本的明确启动日志判定就绪。Bridge、库 HTTP/HTTPS 适配均无需本地 SOCKS/HTTP 代理端口。长连接及每两秒控制心跳由独立 30 分钟测试记录。

排空回归实际创建 258 次短业务并保留一条长业务，等待 DRAIN 后验证该长业务仍可传输，再关闭它并确认旧承载释放。该用例与 Portal 重启和 30 分钟长连接分开，避免仅用健康连接负载推断故障/排空行为。

连接失败采用指数退避，基准默认从 100 ms 到最多 30 秒，再加 ±20% 抖动（实际间隔最多 36 秒）；已建立承载失效后由有界监视周期检测并补充连接。控制握手受 handshakeTimeoutMs 限制；失去控制会话会终止承载并恢复。Portal 累计超过 256 次会话后发送 DRAIN，拒绝向该承载加入新业务，已有业务结束后回收。
