# P5 验收范围

参考固定 V2Ray 提交 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec` 的 common/mux frame、reader、writer、client、server、session。新增 Mux.Cool TCP，VLESS 命令 3 作为普通复用承载；reverse 将直接复用已有 TCP 流。UDP 业务与 XUDP 显式拒绝；reverse 专用 UDP 控制会话单独处理。

验收需覆盖固定字节向量、任意分片、并发隔离、会话关闭与 ID 回收、底层中断、慢读者队列限制，以及 V2Ray/Xray 的双向 VLESS Mux TCP。单会话拥塞将终止该会话；底层发送队列超限将终止整条承载，均不得自动重放应用数据。
