# 运行时接口与迁移

当前版本为 `4.0.0-dev.0`，Node.js 运行基线为 24。本文件说明已经实现的接口；完整开发计划的未完成项见 `IMPLEMENTATION_STATUS.zh-CN.md`。

## 生命周期

`createRuntime(config, { logger, lookup, baseDir })` 进行配置校验并创建独立实例。构造不拨号、不监听、不读写存储、不启动定时器，也不修改进程信号处理。配置中的相对文件路径按 `baseDir` 解析，默认是当前工作目录；CLI 使用配置文件所在目录。

状态依次为 `created → starting → running → closing → closed`。`start()` 返回 Promise，只有所有显式入站成功监听才成功；失败回滚到 `closed`。启动中的并发调用共享启动结果。空入站可以正常运行。关闭后的实例不能重启，必须创建新实例。

`close({ drainTimeoutMs = 0 })` 幂等。关闭时停止接受连接并取消未完成拨号；已有连接可在给定时间内自然结束，之后强制销毁。所有跟踪的监听器、流、数据报会话、用户校验任务和存储定时器均被释放。`close()` 在 `start()` 尚未完成时也可调用。

`runtime.listenersInfo` 返回监听地址和 tag，适合测试中读取端口 0 分配的临时端口。`runtime.stats` 返回状态、跟踪流数、待完成拨号数和监听器数。内部包装流和其传输不会重复计数；一次入站转发仍同时持有入站和出站两个流。

## 字节流和数据报

`await runtime.dial({ host, port, network: "tcp", outboundTag, inboundTag, signal })` 返回二进制 `Duplex`。指定出站 tag 会绕过路由函数，未指定时使用路由结果或第一个出站。未知 tag 和拒绝决策均失败，不会隐式直连。节点列表在每次拨号时随机选择一个，传输设置与选中的地址配对，不做失败重试。

`AbortSignal` 取消未完成拨号，也在拨号成功后继续控制该连接，流关闭时移除订阅。TCP/TLS 保留半关闭。WS/WSS 遵循 WebSocket 关闭语义，`end()` 完成整个 WebSocket；不能以它表达仅关闭写方向。

返回的虚拟流提供 `setTimeout`、`setNoDelay`、`setKeepAlive`、`ref` 和 `unref`，支持标准 Node.js HTTP Agent 接口；HTTPS 目标应通过 `tls.connect({ socket: stream, ca, servername })` 另建目标 TLS。节点 TLS 和目标 TLS 必须各自验证。当前提供接口契约测试，公共 Agent/Undici 工厂仍属于后续阶段。

写入者必须处理 `write()` 的布尔返回值或使用 `pipeline()`。协议读队列、握手缓冲和数据报队列受 `maxBufferBytes` 限制；调用方无视标准流背压反复写入，仍可能在调用方的 Node.js Writable 队列中积压数据。

`await runtime.openDatagram({ host, port, network: "udp", outboundTag, inboundTag, signal })` 支持 Freedom 与 VLESS 的固定目标会话。它不是任意字节流：`send(Buffer)` 发送一个数据报，异步迭代产生 `{ data, host, port }`。也可以监听 `message(data, target)`。`close()`/`destroy()` 幂等；更换目标需要另建会话。入站 SOCKS UDP 与 VMess UDP 尚未通过新运行时验收，显式拒绝。

传统 VLESS 帧最大为 65535 字节，直接 UDP 发送最多为 65507 字节；单次写入还受队列限制。对 V2Ray 5.14.1 的兼容记录仅承诺不超过 2046 字节的 UDP 数据报，该版本会拆分或丢弃较大数据报，不能将本库两端互通的长度范围套用到该参考内核。

## 错误、日志与限制

`Js2rayError` 提供稳定的 `code`、`phase`、`cause` 和 `context`。`toJSON()` 不输出原始 cause。常见代码为 `ERR_CONFIG`、`ERR_TARGET`、`ERR_STATE`、`ERR_CLOSED`、`ERR_LISTEN`、`ERR_DNS`、`ERR_TRANSPORT`、`ERR_TLS`、`ERR_AUTH`、`ERR_PROTOCOL`、`ERR_CANCELLED`、`ERR_TIMEOUT`、`ERR_LIMIT` 和 `ERR_ROUTING`。

上述结构覆盖拨号、配置和库产生的错误。已建立的原生 Socket 仍可能发出 Node.js 标准网络错误；这部分错误的统一包装仍待完成，调用方应保留标准 `error` 处理。

注入的日志可以是函数，或提供 `error(record)` 的对象；旧 `debug` 回调映射为该函数。日志接收脱敏结构，不依赖 `global.log`。`diagnostic` 事件保留结构化错误供宿主检查。事件、VMess 用户账户和校验器各实例独立。

默认限制为：TCP 连接超时 10000 ms、TLS/Upgrade/协议握手阶段超时 10000 ms、空闲超时 0（关闭空闲计时）、跟踪连接 1024、未完成拨号 128、协议队列 1 MiB。整体拨号预算为连接与握手超时之和。设置非零 `idleTimeoutMs` 后，超时销毁连接。VMess 为避免重复使用分块加密 nonce，每个方向最多处理 65536 个加密块，达到上限后失败，不自动重试业务数据。

## 配置与迁移

`checkConfig(config, { baseDir })` 返回 `{ ok, diagnostics, metadata, config, capabilities }`，诊断包含字段路径、原因和修改建议。`normalizeConfig()` 在无效配置时抛出 `ERR_CONFIG`。规范化结果可以再次传给 `createRuntime()`。`redact()` 适合输出报告；不要直接输出包含凭据的原始或规范化配置。

已支持原生 `networks/users` 配置，以及传统 JSON 的单服务器 VLESS/VMess/SOCKS 出站、相应入站、基本 Freedom、TCP/WS 与 TLS 设置。VLESS 用户的 `encryption` 必须为 `none`，`flow` 为空；它与 TLS `security` 独立。`wsSettings.host` 与 `headers.Host` 必须一致。VLESS 上遗留的用户 `security: "auto"` 会被记录为已识别但无行为的元数据，其他值报错。未知行为字段不会被丢弃。

本版本有破坏性变更，因而使用 4.x 开发版本号：

- `config(data)` 返回运行时，必须 `await config(data).start()` / `await runtime.stop()`；`stop` 是 `close` 的兼容别名。
- 模块级 `on` 和共享 `protocols` 被实例事件替代。启动后可通过 `runtime.protocols.vmess.api` 使用实例的用户管理接口；它与原来的自定义 HTTP 管理 API 不等价。
- 不再创建 Linux systemd 文件，不注册宿主异常或退出处理。部署服务由操作者显式配置。
- 原 HTTP 伪装、XHTTP、自定义管理 API、`security: "zero"` 等未验收能力在新入口中明确拒绝。旧实现源码保留，但不列为新接口正式支持能力。
- `routing` 函数仅用于库模式。声明式路由、DNS、Geo 资源、Mux 和 reverse 仍待实现，完整参考配置目前必须报错。
