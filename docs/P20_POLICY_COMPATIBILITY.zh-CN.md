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

hosts 别名最多 16 层并检测循环；固定内核的 hosts 展开深度为 5，深链/循环作为 JS 明确有界差异，不宣称逐错误一致。DNS domainMatcher 为 V2Ray 原生字段、Xray 档案中的 JS 扩展，选择服务器 domains 的扫描或索引实现；不改变 hosts/服务器的优先级。`disableFallbackIfMatch` 只在存在优先服务器时抑制普通回退；显式每服务器策略优先。同层混用新旧策略字段时，JS 对冲突的 cacheStrategy/disableCache 报错，fallbackStrategy 枚举优先于旧布尔开关；建议每层使用一种策略写法。固定 Xray 会忽略非法 user 正则，JS 统一在配置阶段拒绝。兼容档案只覆盖本页列出的静态语义，不模拟两个内核的全部内部调度、缓存并发合并、日志或管理 API。

`HTTP/3`、`DoQ` 继续暂缓；不支持动态 balancer/observatory、进程条件、Starlark/Lua、FakeDNS、DoT、任意新版本新增字段。本阶段不启动这些原型。

专项命令：`node --test --test-concurrency=1 test/policy-compat.test.js test/dns-compat.test.js`；固定对照：`node --test --test-concurrency=1 test/interop/policy-compat.test.js`。完整验收使用全量 CI 和 `npm run test:stability:policy`，后者 100 个持续 TCP 业务会话、另 4 个持续 UDP 会话、30 分钟、DNS/缓存/超时回退、每分钟凭据轮换和新连接，并记录源码/依赖/脚本/配置摘要、延迟、内存、队列及清理结果。短跑不能计作正式验收。P17/P18/P19 长时负载因共享产品变化继续全量重跑。

验收状态：本机专项和固定对照已通过，三平台全量与正式长时结果待本轮运行后记录。
