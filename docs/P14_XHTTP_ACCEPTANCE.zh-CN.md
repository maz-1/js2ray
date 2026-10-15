# P14 XHTTP 实现与验收

2026-10-15，Node.js 24.20.0，`4.0.0-dev.0`。

本阶段在新 Runtime 中实现 XHTTP 客户端和服务端，运行时只使用 Node.js 内置 HTTP、HTTP/2、TLS、流及加密接口，未新增运行依赖。原回调式 XHTTP 源码继续保留，不用于本阶段的支持声明。

## 支持矩阵

| 传输                     | packet-up    | stream-up    | stream-one   | 独立对端验收                       |
| ------------------------ | ------------ | ------------ | ------------ | ---------------------------------- |
| 明文 HTTP/1.1            | 双向         | 双向         | 双向         | js2ray ↔ Xray 25.3.6              |
| 严格 TLS HTTP/1.1        | 双向         | 双向         | 双向         | js2ray ↔ Xray 25.3.6              |
| 严格 TLS HTTP/2          | 双向         | 双向         | 双向         | js2ray ↔ Xray 25.3.6              |
| 显式 prior-knowledge h2c | 双向 JS 自测 | 双向 JS 自测 | 双向 JS 自测 | js2ray 客户端 → Xray 25.3.6 服务端 |

固定版本的 Xray 无 TLS 出站选择 HTTP/1.1，所以反方向 HTTP/2 使用严格 TLS 验证；h2c 没有伪装成该内核的双向参考验收。每项独立对照通过 VLESS TCP 传输三条并发连接，各传输约 128 KiB 合成二进制，验证任意字节及完整顺序。

## 固定参考

Xray 25.3.6，源码 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`。官方归档摘要核对发布 `.dgst`，归档和实际二进制 SHA256 锁定于 `test/fixtures/reference-platforms.json`，测试 profile 为 `xray-xhttp`。既有 Xray 24.11.5 与 V2Ray 5.14.1 回归基线未替换。

| 平台        | 二进制 SHA256                                                      |
| ----------- | ------------------------------------------------------------------ |
| Windows x64 | `a6a37bbc73a1eaa08abf0537e1d22097afa14be0d92c3ce8b8a808c16c205366` |
| Linux x64   | `4d10fb6441551e5fcd084e473a7cf9ab1e98d361cb9ec7dfb38a6dc6bba5998f` |
| macOS x64   | `059f7f448d671ca23850a4d1ce1ca000104f5d2c3e2cb3362a8ad1c1b3c8417c` |

## 行为与边界

- 支持原生配置、传统 JSON `xhttpSettings`/`extra`、TLS ALPN、独立连接地址/SNI/Host/path、固定查询串和 Referer/旧查询参数 padding。
- 分包按序组合，拒绝重复、非法序号、超出窗口、超大请求和超量会话；未配对、缺包、未完成单包上传和响应等待均有期限。
- 顺序 packet-up 确认等待可读队列空间，流式上传和下载沿 HTTP body 传递背压；HTTP/2 单条物理连接上的逻辑会话相互隔离。
- 接收按独立窗口主动读取 HTTP body，不依赖可能被 read(n) 扩大的 Node 高水位；大块合并的确定性回归与慢消费者测试验证上限，跨平台关闭等待实际资源事件。
- 关闭幂等，释放请求、逻辑会话、物理连接、HTTP/2 session 和计时器；HTTP/2 共享请求/响应只销毁一次，避开 nghttp2 回调重入。
- HTTP/1.1 流式 POST 使用专属 `Connection: close`，避免固定 Go HTTP 服务端先消耗未结束的请求体再发送响应头造成死锁。
- 同端口轮换路径、UUID、TLS 证书后，旧 packet-up 会话继续使用原 HTTP/2 连接并排空，新连接使用新参数。HTTP 版本或 TLS 开关改变需要新端口。
- 故障不重放业务数据，不隐式直连；XHTTP 不承诺任意 TCP 半关闭语义。完整 XMUX、跨节点上下行分离、HTTP/3、REALITY 和浏览器指纹尚未实现，相关配置明确拒绝。

## 验收记录

本机 Windows 已通过：

| 命令                                                           | 结果                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `node --test test/xhttp.test.js`                               | 37/37，包括 100 条并发 TLS 连接、两种 HTTP 版本、三模式及关闭后所有内部资源计数归零 |
| `node --test test/interop/xhttp.test.js`                       | 21/21，固定 Xray 25.3.6，无跳过                                                     |
| `npm test`                                                     | 185/185，无跳过                                                                     |
| `npm run test:interop`                                         | 127/127，含全部既有版本回归，无跳过                                                 |
| `npm run check`、`npm run check:types`、`npm run check:config` | 通过                                                                                |

实际 tarball 已安装并运行包内 XHTTP/VLESS 拨号和回传，验证无本地客户端代理监听器、CJS/ESM 导出及关闭清理；运行依赖仍仅 ws，无原生运行资产。Windows/Linux/macOS CI 结果将在完成后追加，未通过前不将三平台出口条件标记为完成。测试仅使用合成凭据、本地服务及合成证书；私有配置不进入测试记录、Git 或发布包。

协议行为参考：[固定版本配置](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/transport/internet/splithttp/config.go)、[客户端](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/transport/internet/splithttp/client.go)、[服务端](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/transport/internet/splithttp/hub.go)。
