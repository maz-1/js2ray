# P7 验收范围

提供 createHttpAgent、createHttpsAgent、createUndiciConnector、createUndiciDispatcher。Undici 是调用者可选依赖，仅开发测试锁定 7.30.0；dispatcher 接收显式 `{ undici }`。无默认全局 dispatcher/agent 修改，无本地代理监听。

每个适配器固定运行时、出站和入站 tag；连接池按目标及 Node TLS 参数分开，每个适配器持有自己的池。HTTPS 在 dial 返回的流上独立建立目标 TLS，默认验证证书链及目标名称。连接与目标 TLS 共用超时预算；请求总预算由上层 AbortSignal/HTTP 客户端控制。重定向需继续传递同一适配器。adapter.destroy/dispatcher.close/destroy 与 runtime.close 均清理持有资源；主动重定向、全局设置、Unix socket、httpSocket 升级、本地绑定、HTTP/2 不属于该接口范围。

验收覆盖 HTTP/HTTPS、跨目标重定向、大响应流、虚拟 Mux 流、证书失败、取消、连接预算、池复用/关闭及无本地代理监听。Undici Connector 依据固定版本官方接口说明实现：https://github.com/nodejs/undici/blob/v7.30.0/docs/docs/api/Connector.md 。
