# P5 验收范围

参考固定 V2Ray 提交 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec` 的 common/mux frame、reader、writer、client、server、session。新增 Mux.Cool TCP，VLESS 命令 3 作为普通复用承载；reverse 将直接复用已有 TCP 流。UDP 业务与 XUDP 显式拒绝；reverse 专用 UDP 控制会话单独处理。

验收需覆盖固定字节向量、任意分片、并发隔离、会话关闭与 ID 回收、底层中断、慢读者队列限制，以及 V2Ray/Xray 的双向 VLESS Mux TCP。单会话拥塞将终止该会话；底层发送队列超限将终止整条承载，均不得自动重放应用数据。

已执行 `test/mux.test.js` 与 `test/interop/mux.test.js`：固定向量及每个截断位置、100 会话隔离、ID 越过 65535、等待远端 END 前不复用 ID、慢会话限额而健康会话继续、承载失效关闭全部活动会话；两个固定内核在 TCP/WSS 上均完成双向并发与 END 关闭检查。普通 Mux 并发默认 8（配置 1–128），入站最多 128 会话；默认单会话队列 256 KiB、整承载协议队列 1 MiB，均受 runtime 的 maxBufferBytes 限制。数据发送按 8192 字节分帧，解析元数据最多 512 字节、线帧数据最多 65535 字节。空闲默认 60 秒，等待关闭确认的 ID 槽最多 65536；耗尽时失败，不冒险复用。
