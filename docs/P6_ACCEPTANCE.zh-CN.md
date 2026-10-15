# P6 验收范围

传统 reverse 参考固定 V2Ray `app/reverse/{bridge,portal,reverse}.go` 及 `config.proto`。控制目标为 TCP 配置 domain:0；Portal 在该流上发起 Mux，Bridge 接受 Mux；保留的 `reverse.internal.v2fly.org:0` UDP 会话承载逐帧 protobuf Control（ACTIVE=0，DRAIN=1）。普通 outbound mux=false 不影响 reverse 内部 Mux。

验收包含 js2ray Bridge→参考 Portal、参考 Bridge→js2ray Portal、js2ray 双端三类拓扑，HTTP、HTTPS、流数据、并发、控制状态、传输中断、Portal 重启、退避重连和清理。Mux 的 END 为会话双向关闭；不承诺任意应用协议的 TCP 半关闭响应，必须记录实际测试行为。运行时状态、reverse 传输状态和业务结果分别报告。进程内服务由调用者显式注册，配置固定允许目标，不开放任意处理器分发。
