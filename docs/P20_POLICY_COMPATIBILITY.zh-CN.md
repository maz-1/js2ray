# P20 常用路由与 DNS 兼容

范围为前两批：常用静态路由和 DNS。固定 V2Ray 5.14.1 与 Xray 25.3.6，使用 `compatibility: "v2ray-5.14.1"` 或 `"xray-25.3.6"` 选择语义；默认 `"native"` 保持已有 js2ray 行为。此字段是 js2ray 扩展，不能原样传给参考内核。原生配置与传统 JSON 共用检查器，不静默忽略未知行为。

源码锁见 [逐文件来源与 SHA256](../test/fixtures/policy-references.json)，二进制三平台锁见 [reference-platforms.json](../test/fixtures/reference-platforms.json)。V2Ray 提交 `1f1ff246ddebb530d8fadeb49ffd32b8617e64ec`，Xray 提交 `2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4`。旧 Xray 24.11.5 互通继续保留，但新增配置语义不以它为基线。

| 能力           | 支持及固定语义                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由条件       | `domain`/`domains` 同时存在时合并 OR；`ip`、`port`、`network`、`inboundTag`、`source`、`sourcePort`、`user`、`protocol`、Xray 对象 `attrs`；字段间 AND，规则依配置顺序首个命中         |
| 域名形式       | 无前缀 keyword、`keyword:`、`domain:`、`full:`、`regexp:`、`dotless:`、`geosite:`、`ext:`/`ext-domain:`；Geo 属性选择与排除仍支持                                                      |
| 来源 IP        | CIDR、GeoIP、反选、`ext:`/`ext-ip:`；`sourceIP` 是 JS 接受的扩展别名，不声称固定 Xray 原生接受                                                                                         |
| 匹配器         | `linear` 扫描；`mph`/`hybrid` 使用 JS 哈希/后缀索引和有界关键词自动机。匹配结果兼容，不承诺 Go 内部 MPH 数据结构或性能                                                                 |
| 正则           | 纯 JS `re2js@2.8.6`，RE2 语义；不支持回溯引用、环视或任意 JS 正则行为。表达式最长 2048 字符，无原生/WASM/安装脚本依赖                                                                  |
| 资源           | 主 Geo 与显式 `geodata.external[filename]` 固定 path/version/SHA256/maxBytes；拒绝未声明外部文件，文件名不允许目录穿越                                                                 |
| 用户           | 已认证 VMess/VLESS email、SOCKS 用户名。V2Ray 用户值精确比较；Xray/native 接受 `regexp:`。缺少认证身份不会通配                                                                         |
| 协议/HTTP 属性 | 显式开启嗅探后支持 HTTP/1.0、HTTP/1.1、TLS、BitTorrent，HTTP 属性含小写请求头与 `:method`/`:path`；Xray 对象所有属性正则均需命中。V2Ray Starlark 字符串不在范围内                      |
| 路由元数据     | 普通 TCP、WS、XHTTP 的真实对端来源；UDP 与 Mux/XUDP 继承已认证外层来源/用户，TCP 子会话分别嗅探。反向业务的原始来源/用户不在既有线格式中，保持缺失，不伪造；库拨号可显式传入可信上下文 |
| `ruleTag`      | 接受并保留标识，不改变决策；不等同于参考内核统计 API                                                                                                                                   |
| DNS 通道       | IP/UDP、截断转 TCP、`tcp://`、`tcp+local://`、`localhost`、`https://`、`https+local://`；DoH 严格 TLS。local 绕过策略并用 hosts/系统引导；普通 TCP/UDP/DoH 经过路由                    |
| DNS 选择/过滤  | `hosts`、服务器 `domains`、`expectIPs`/`expectedIPs`、`skipFallback`、`disableFallback`、`disableFallbackIfMatch`，域名精确/最长后缀优先；未知脚本、FakeDNS 与新版本独有字段继续诊断   |
| 每服务器控制   | queryStrategy、clientIp；JS 额外统一支持 timeoutMs、tag、disableCache/cacheStrategy、fallbackStrategy、outboundTag、DoH tls。不能把 JS 扩展当作两个内核均原生支持                      |
| ECS            | 全局/每服务器 clientIp，IPv4 /24、IPv6 /96，EDNS OPT 只发送子网字节；本地系统 lookup 不发送 ECS                                                                                        |
| 缓存           | 按实例/代次、服务器、域名、地址族、ECS 隔离，正 TTL、上限一小时、LRU 有界，返回副本；不做负缓存、serve-stale 或请求重放。pending/maxConcurrent 统计实际服务器地址族请求                |

| 差异点                         | V2Ray 5.14.1                           | Xray 25.3.6                                      | native                                        |
| ------------------------------ | -------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| 单服务器 queryStrategy         | 覆盖全局默认，再与请求地址族求交       | 全局、单服务器、请求三者求交，hosts 也受全局限制 | 同 Xray 的上游地址族限制，保留既有 hosts 行为 |
| 所有服务器均被排除             | 失败，不查询首台                       | 仍使用首台                                       | 失败                                          |
| 空地址响应                     | 停止回退                               | 可回退                                           | 可回退                                        |
| RCODE 5 REFUSED                | 停止回退                               | 可回退                                           | 可回退                                        |
| 其他 RCODE 错误                | 停止回退                               | 停止回退                                         | 可回退                                        |
| 超时/expected IP 不匹配        | 可回退                                 | 可回退                                           | 可回退                                        |
| hosts 多个条件命中             | 合并匹配条目，单条 alias 优先于该条 IP | 同左                                             | 仅最高优先条目                                |
| cacheStrategy/fallbackStrategy | 固定版本原生支持全局及每服务器         | JS 扩展；参考只比较原生字段                      | JS 扩展                                       |

SOCKS UDP 的来源/用户采用已认证 TCP 控制连接上下文，sourcePort 是控制连接端口；不宣称与参考内核独立 UDP 入站的包来源端口完全等价。WS/XHTTP 经过反向代理时使用实际对端地址，不信任 X-Forwarded-For；不恢复被代理隐藏的原始地址。

localhost 使用宿主 lookup，不自动复制 Go 内核注入的本地域名/无点域名优先列表；需要确定性优先选择时，显式配置该服务器的 domains（例如 domain:local、dotless:）。系统 lookup 无法提供权威 TTL，JS 使用 60 秒；它不等同于上游 DNS 报文的实际 TTL。

hosts 别名最多 16 层并检测循环；固定内核的 hosts 展开深度为 5，深链/循环作为 JS 明确有界差异，不宣称逐错误一致。DNS domainMatcher 为 V2Ray 原生字段、Xray 档案中的 JS 扩展，选择服务器 domains 的扫描或索引实现；不改变 hosts/服务器的优先级。`disableFallbackIfMatch` 只在存在优先服务器时抑制普通回退；显式每服务器策略优先。同层混用新旧策略字段时，JS 对冲突的 cacheStrategy/disableCache 报错，fallbackStrategy 枚举优先于旧布尔开关；建议每层使用一种策略写法。固定 Xray 会忽略非法 user 正则，JS 统一在配置阶段拒绝。兼容档案只覆盖本页列出的静态语义，不模拟两个内核的全部内部调度、缓存并发合并、日志或管理 API。

`HTTP/3`、`DoQ` 继续暂缓；不支持动态 balancer/observatory、进程条件、Starlark/Lua、FakeDNS、DoT、任意新版本新增字段。本阶段不启动这些原型。

专项命令：`node --test --test-concurrency=1 test/policy-compat.test.js test/dns-compat.test.js`；固定对照：`node --test --test-concurrency=1 test/interop/policy-compat.test.js`。完整验收使用全量 CI 和 `npm run test:stability:policy`，后者 100 个持续 TCP 业务会话、另 4 个持续 UDP 会话、30 分钟、DNS/缓存/超时回退、每分钟凭据轮换和新连接，并记录源码/依赖/脚本/配置摘要、延迟、内存、队列及清理结果。短跑不能计作正式验收。P17/P18/P19 长时负载因共享产品变化继续全量重跑。

验收状态：全部通过，正式结果见下表和机器汇总。

中间回归曾在本机和 Linux 固定 Xray 的 TLS HTTP/2 packet-up 路径出现超时。已以真实 HTTP/2 流构造确定性时序：空确认的 EOF 先于异步续体恢复，旧代码只等未来 end 事件导致误超时。修复后接受已完成响应，提前关闭仍失败，所有监听器/计时器统一清理；不更改原有预算。失败运行 38788191414 不作为通过证据。

另一次 macOS 互通失败来自超大 XUDP 拒绝的过窄错误码断言。固定 Xray 的 [PacketReader](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/common/mux/reader.go) 对超过 buf.Size 的包报错；[ServerWorker.run 与 handle](https://github.com/XTLS/Xray-core/blob/2cba2c4d59e48a04aa5d09b8e4c2b2d26f8608a4/common/mux/server.go) 并发清理承载和响应写入，不能跨平台保证 error END 先于 EOF。测试现仅接受会话级 ERR_MUX_SESSION 或承载级 ERR_TRANSPORT 两种明确拒绝，并新增目标零超大包、会话关闭、新会话恢复及 Mux 会话归零检查。产品不将承载关闭伪装成已收到会话错误；作业 38789667818 的失败不计入最终通过结果。

## 正式验收结果

P20 全部验收通过：[三平台全量回归](https://github.com/maz-1/js2ray/actions/runs/38791828807) 每平台 372 项普通/228 项固定内核互通、类型/格式/示例与实际 tarball 安装全部通过，无失败、取消或跳过。[路由/DNS 长时](https://github.com/maz-1/js2ray/actions/runs/38789667879)、[上下行分离长时](https://github.com/maz-1/js2ray/actions/runs/38789667907)、[XMUX 长时](https://github.com/maz-1/js2ray/actions/runs/38789667673) 和 [混合传输长时](https://github.com/maz-1/js2ray/actions/runs/38789668013) 各在三个平台完成 100 会话/30 分钟验收；P20 另保有 4 个 UDP 会话，覆盖 DNS/缓存/超时回退和凭据轮换。12 份原始记录均通过自动核验，所有管理器关闭归零，Caddy 子进程退出。83 个产品文件的规范化汇总 SHA256 为 `0c02ff45b132a23efb67b1edef659f6b32c65e497849b374cd8abfc047749f08`；全量与长时作业的产品、依赖、包清单及对应负载脚本逐文件一致。

全量提交：`53859c5a23720b78c048f36da09bce3b2015cc6c`；长时负载提交：`30056fa833a6c3fddcbc8c994d59d734ae4c941b`。两者后续差异仅在测试和文档，已逐文件核对产品及负载脚本。参考内核固定为 V2Ray 5.14.1、Xray 25.3.6，并保留旧 Xray 24.11.5 回归。

| 平台    | 路由/DNS                                                                          | 上下行分离                                                                            | XMUX                                                                            | 混合传输                                                                             |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Windows | [1800620 ms / 1453394 次](acceptance/p20-policy-stability-win32-2026-10-16.json)  | [1800634 ms / 1101522 次](acceptance/p20-xhttp-split-stability-win32-2026-10-16.json) | [1800592 ms / 1201069 次](acceptance/p20-xmux-stability-win32-2026-10-16.json)  | [1800304 ms / 1145220 次](acceptance/p20-transport-stability-win32-2026-10-16.json)  |
| Linux   | [1800315 ms / 1773714 次](acceptance/p20-policy-stability-linux-2026-10-16.json)  | [1800620 ms / 1353592 次](acceptance/p20-xhttp-split-stability-linux-2026-10-16.json) | [1800315 ms / 1395939 次](acceptance/p20-xmux-stability-linux-2026-10-16.json)  | [1800262 ms / 1377203 次](acceptance/p20-transport-stability-linux-2026-10-16.json)  |
| macOS   | [1800946 ms / 1687074 次](acceptance/p20-policy-stability-darwin-2026-10-16.json) | [1801076 ms / 637537 次](acceptance/p20-xhttp-split-stability-darwin-2026-10-16.json) | [1801354 ms / 1261987 次](acceptance/p20-xmux-stability-darwin-2026-10-16.json) | [1800270 ms / 1278484 次](acceptance/p20-transport-stability-darwin-2026-10-16.json) |

每项均完成 29 次轮换；P20 DNS 超时回退每平台 116–116 次，UDP 与 DNS 验证计数、内存/队列/延迟、配置/源码/脚本/包清单摘要均在原始记录中。分离负载的代理故障与混合传输的 cover 故障也按各自原有门槛核验。

[机器汇总](acceptance/p20-2026-10-16.json) 保存作业、artifact 摘要和逐文件摘要。`scripts/collect-policy-acceptance.js` 从 GitHub 只读收集并核验，`scripts/acceptance-evidence.js` 在 CI 拒绝短时、缺少数据、源码/依赖/包清单/脚本不符或资源未清理的记录。原始 JSON 按字节保存并排除格式化及 Git 换行转换。私有配置只参与本地字段审计，CI 与产品不接触真实凭据；HTTP/3、DoQ 继续暂缓。
