# ChatRoom 后续整合规划

前置基线为 js2ray P0–P8 已定义矩阵的验收通过，证据见 `acceptance/release-2026-10-15.json`。这是独立后续规划，本次没有修改 ChatRoom 应用、认证或部署。

## 接入前确认

- ChatRoom 的 Node.js 版本、HTTP 客户端、部署平台及进程生命周期；当前验收为 Node 24.20.0、三个系统的 x64。
- 所需范围是出站 HTTP/HTTPS、应用 WebSocket、反代服务，还是其中一部分；分别定义目标与失败语义。
- 配置与凭据从哪里注入，是否多租户，Portal 由谁管理，以及实际内核是否在当前互通清单内。

## API 与生命周期

宿主创建并持有 runtime；启动时 await start，停止接收新业务后关闭客户端连接池及 runtime。普通出站使用 createHttpAgent/createHttpsAgent 或显式可选的 Undici dispatcher；保持 inbounds 为空，不引入本地代理监听。HTTP 重定向继续使用相同适配器。应用 WebSocket 使用已验收的 createWebSocket，宿主仍需补充实际应用鉴权与业务消息测试。

每个租户持有独立 runtime 和客户端池，或先设计并验收明确的隔离接口。当前 DialTarget 不携带经过认证的用户主体，不能把 inboundTag、目标 Host 或转发头当作用户身份。禁止不同租户共享带认证上下文的池。配置替换使用 createRuntimeManager，先探测新实例、切换新请求并隔离连接池，再限时排空旧实例；已发业务字节不重放。

## 认证与反代

VLESS 身份、节点 TLS、目标 TLS、ChatRoom 应用认证分别配置和验证。真实 UUID、prefix、节点地址、端口及密钥只从宿主配置/密钥设施注入，示例与 CI 使用合成值。日志保留错误代码、阶段和脱敏 tag，不输出原始配置或 cause。

反代先选固定服务 redirect 或进程内 services 处理器，并列出精确允许的 host/port。Portal 控制入口与业务入口显式区分；先匹配控制域名，再匹配 Bridge 业务规则。处理器仅返回约定的 Duplex，应用层仍执行原有认证。Portal 重启会终止已有业务，宿主决定是否对新请求重试，不重放已发送的业务数据。

## 部署与验收

Portal 独立部署并明确暴露端口、TLS 与配置更新责任；Bridge 运行在 ChatRoom 所在网络，默认没有代理监听。先用部署的实际固定内核和资源摘要补充互通，再扩大正式支持矩阵；ARM、较新 reverse 变体不由当前结果推断支持；UDP/XUDP 的具体矩阵见 P12。

后续任务依次为：盘点宿主接口与身份边界；提供一个最小出站适配；加入实际 HTTP/HTTPS、重定向、取消、流式聊天和应用 WebSocket 的端到端测试；按需求接入单服务反代；验证租户隔离、错误证书、Portal 重启、配置替换与关闭；最后再设计部署与灰度回滚。

出口证据包含实际部署版本、脱敏配置和资源摘要、零代理监听检查、认证/隔离结果、流式响应、失败恢复和负载/关闭记录。整合实施应由单独任务确定范围后开展。
