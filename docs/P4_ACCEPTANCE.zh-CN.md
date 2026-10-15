# P4 验收范围

基线提交：`ee6f59e`。参考实现沿用 `test/fixtures/reference-cores.json` 锁定的 V2Ray/Xray。

本阶段接受按序、字段内 OR、字段间 AND 的 `field` 规则：inboundTag、domain、IP/CIDR、port、network；域名支持 full/domain/keyword 与固定 GeoSite 资源。仅接受 `domainStrategy: AsIs`，不为匹配 IP 规则解析域名。GeoIP 的 `!` 取反和 GeoSite 类别名中的 `!` 分别处理。

DNS 支持 hosts/别名、A/AAAA、UDP、截断后 TCP、DoH、匹配服务器、expectIPs、回退、缓存、取消和超时。普通 DNS 与 https DoH 经运行时路由；显式 https+local/localhost 使用本地路径。代理节点和 DNS 引导只使用 hosts/注入的系统解析器，避免再次查询正在使用的代理 DNS。Freedom 默认 AsIs 按系统解析，UseIP/UseIPv4/UseIPv6 显式使用内部 DNS。

GeoIP/GeoSite 使用标准 protobuf `.dat`，资源必须给出版本和 SHA256；缺失资源、类别、校验失败及超限均失败。测试使用合成固定资源，不将真实节点或私有配置写入样例。

验证入口：`test/routing.test.js`、`test/dns.test.js`、`test/geodata.test.js`、`test/sniff.test.js`、`test/interop/routing.test.js`。Blackhole、Freedom redirect、TCP 转发入站及首包保留与上述规则一并验证。HTTP/TLS 嗅探受大小与时间限制；routeOnly 只修改路由域名。SOCKS 嗅探需先回复 CONNECT 成功再读取应用首包，之后连接失败时关闭流。

2026-10-15 Windows / Node 24.20.0：普通回归 88 项、参考互通 32 项通过；新增对照用例在 V2Ray 5.14.1 和 Xray 24.11.5 上验证同一目标集、标准合成 Geo 资源、DNS 分服务器及 Freedom UseIPv4。资源版本和 SHA256 保存在 `test/fixtures/geodata/manifest.json`。命令：`npm test`、`npm run test:interop`、`npm run check:types`。

DNS 默认每服务器 3 秒，整体预算为服务器数加一倍单服务器预算；缓存有容量及 TTL 上限，不缓存失败。代理节点与 DNS 引导使用 hosts/系统解析；普通 DNS、https DoH 使用配置路由；https+local 不经代理。DoH 目标 TLS 与代理节点 TLS 分别验证。Geo 正则来自已校验资源；用户直接 regexp 规则、IPIfNonMatch/IPOnDemand、非 TCP 转发、HTTP Blackhole 响应、VMess 嗅探仍显式拒绝。reverse 和悬空 api 规则留待后续阶段诊断。
