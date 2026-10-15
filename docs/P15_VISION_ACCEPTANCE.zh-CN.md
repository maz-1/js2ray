# P15 Vision 验收

参考行为固定为 Xray 25.3.6，源码 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`；复用 `reference-cores.json`/`reference-platforms.json` 的 `xray-xhttp` 锁定工具，保留原键名以免改变 P14 工具证据。参考内核仅是独立测试对端，不进入产品或发布包。

纯 Node.js 可行性原型先行通过，随后才接入完整 VLESS Vision。实现没有读取 Node 私有 TLS 字段：自定义 Duplex 隔开 TCP 与 TLSSocket，公开 keylog 事件的读取秘密只留在内存。记录 AEAD 校验确定当前记录应交付的明文字节数，协议解析器明确确认消费完成后才放行下一条记录；Direct 后剩余原始字节仍由原 TCP 队列持有。写方向等待最终填充写回调，再绕过外层 TLS。微任务用于串行调度，切换正确性不依赖时间延迟。

本机验证：原型 8 项包含三密码套件双向切换、未读明文、2 MiB SHA256、单字节加密输入、最终密文与原始数据合并、半关闭、固定合成 KeyUpdate/序号/认证向量、畸形/截断记录，以及延迟 keylog 时保留密文的确定性用例。协议及运行时 16 项覆盖填充分片、非法 UUID/命令、flow 协商、TLS 识别、严格证书、超时/取消、写入限制、混合用户、XUDP、UDP/443 策略、凭据及证书轮换；100 并发实际 TLS 1.3 目标连接逐一断言两个方向的 Direct，并在关闭后验证连接与队列归零。

固定 Xray 双向互通覆盖普通 TCP、内层 TLS 1.2、内层 TLS 1.3 和 XUDP，共 8 项。TLS 1.3 两个方向必须实际发生 Direct，验证多次传输至 512 KiB；普通流量与 TLS 1.2 必须保持未切换。XUDP 对照使用 1400 字节；另断言 Xray 拒绝 8193 字节，不以 JS 自测替代参考内核边界。

复现命令：

```sh
node --test test/vision-prototype.test.js test/vision.test.js
node --test test/interop/vision.test.js
npm run check
npm run check:types
npm run format:check
npm run check:config
npm test
npm run test:tools
npm run test:interop
npm run test:package
```

实际 tarball 安装后另建立 Vision 客户端、服务端和真实内层 TLS 目标，检查响应及双向 Direct。运行依赖仍仅 ws，参考二进制、测试证书、私有配置不进包。所有测试使用合成凭据；提交与推送前执行本地私有字段及历史 blob 审计。

三平台 CI 和最终数量将在实际作业完成后登记。支持限制见 [API](API.zh-CN.md#visionp15)：原始 TCP/TLS 1.3、基础 Vision flow、UDP/XUDP；REALITY、指纹伪装、WS/XHTTP Vision、TCP Mux、内核 splice 不属于本阶段。Direct 写方向后的外层 TLS 控制写入明确终止连接；同端口普通 TLS↔Vision 监听类型变更需迁移端口。

协议与 API 参考：[固定 Xray Vision 编解码](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/proxy/proxy.go)、[固定 Xray 缓冲转移与 Direct](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/proxy/vless/encoding/encoding.go)、[Node 24.20.0 TLSSocket/Duplex 与 keylog 文档](https://github.com/nodejs/node/blob/v24.20.0/doc/api/tls.md)、[RFC 8446 记录保护与流量秘密更新](https://www.rfc-editor.org/rfc/rfc8446.html)。
