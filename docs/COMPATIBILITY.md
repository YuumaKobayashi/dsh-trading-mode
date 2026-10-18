# 兼容性：已验证环境与能力边界

本文件只写**实测过**的东西：跑过的命令、量到的版本、真实出数的数据源；没实测的一律标 `未验证`。**未经测试的平台
不作为支持承诺**，只按社区反馈逐步加入。当前插件版本 `dsh-trading-mode@0.8.1`。

## 已验证环境矩阵

| 平台 | 操作系统版本 | Node | DSH | 安装方式 | 离线测试 | 装机校验 | AI | 验证日期 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64（`win32` / `x64`） | `Microsoft Windows NT 10.0.26300.0`；注册表 `CurrentBuild=26300`、`UBR=9550`、`DisplayVersion=26H2`、`EditionID=CoreCountrySpecific`、`ProductName=Windows 10 Home China` | `v24.15.0`（npm 11.12.1） | 桌面宿主 `0.2.0-rc.2`（`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`，内含 `@deepseek-ai/cordis@4.0.4`，满足 peer `^4.0.1`） | 工作区以 `link:` 装进 profile 的 `node_modules` + `dsh.profile.bundles`，DSH 进程重启后加载 | `13 passed, 0 failed, 0 skipped` | `6/6 install checks passed` | 可用；实测路由 `deepseek-official/deepseek-flash` | 2026-10-10 | 单机桌面场景；`verify-install` 报 junction → working tree |
| Windows x64（`win32` / `x64`） | 同上（同一台机器，宿主升级后复测） | `v24.15.0`（npm 11.12.1） | 桌面宿主 `0.2.1-rc.2`（`dsh --version` → `0.2.1-rc.2`；`app.asar` 根 `package.json` = `@deepseek-ai/dsh-desktop@0.2.1-rc.2`；内含 `@deepseek-ai/cordis@4.0.5`，满足 peer `^4.0.1`） | 工作区仍以 `link:` 装进同一 profile，宿主升级后**不改任何配置**直接加载 | `13 passed, 0 failed, 0 skipped`（153 项检查） | `6/6 install checks passed` | 可用；`GET /api/trading/health` → `api:"ready"` / `fence:"host"` / `identity:"host-anonymous-id"`；客户端两处 slot 均 `active:true` | 2026-10-18 | 升级复测：同一份 0.8.1 代码、同一 profile |

量法（`0.2.0-rc.2`，2026-10-10）：`node -v` → `v24.15.0`、`process.platform/arch` → `win32 x64`；版本细节取自注册表
`HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion`（`Get-CimInstance Win32_OperatingSystem` 在本机返回 `拒绝访问`
`HRESULT 0x80041003`，故 `Caption` / `Version` / `OSArchitecture` **未取到**）；DSH 版本取自 `app.asar` 内
`dsh/package.json`（与 `FileVersion=0.2.0-rc.2` 一致）；`cordis_inspect_query(host, Service, listService)` 里能看到
`connection` / `webServer` / `llm` / `storageDomain`。

量法（`0.2.1-rc.2`，2026-10-18）：三处独立取证，结论一致 —— `dsh --version` → `0.2.1-rc.2`；
`resources/runtime/primary-runtime/runtime.json` 的 `desktopVersion` 同为 `0.2.1-rc.2`（该文件同时报 Node 24.21.0、
pnpm 11.28.5）；`app.asar` 根 `package.json` = `@deepseek-ai/dsh-desktop@0.2.1-rc.2`。宿主内部包直接读 asar
文件树（`ELECTRON_RUN_AS_NODE=1` + Electron 的 asar 支持，普通 `node` 读不进去）：`@deepseek-ai/cordis@4.0.5`、
`@deepseek-ai/dsh@0.2.1-rc.2`，`@deepseek-ai` 作用域下 **306** 个包全部是 `0.2.1-rc.2`；插件声明为 peer 的
`@deepseek-ai/dsh-anonymous-user-id` / `dsh-llm` / `dsh-storage-domain` 都在。
运行时复测：`GET http://127.0.0.1:52476/api/trading/health` → `200` 且 `api:"ready"` / `fence:"host"` /
`identity:"host-anonymous-id"`；`cordis_inspect_query(client, Slots, listSubTree)` 在 `shell.overlay`（order 500）
与 `conversation.session.header.actions`（order 30）都看到 `registrant:"trading-mode"`、`active:true`；插件用到的宿主
能力签名未变 —— `connection.requestRejection(ConnectionTrustRequest)`、`connection.createSharedFetchHandler('/api')`、
`webServer.register(WebRoute)`、`storageDomain.open/get/closeAll`、`llm` 服务在列；`lib/client.js` 只 `require('react')`，
不绑定其它客户端包。

## 已知的宿主侧变动（`0.2.0-rc.2` → `0.2.1-rc.2`）

- `@deepseek-ai/cordis` 4.0.4 → **4.0.5**：仍满足 peer `^4.0.1`，插件未依赖 4.0.5 新增能力。
- 客户端 `theme` 服务的 `setFontSize(role, px)` 带 `role` 参数（此前文档写作 `setFontSize(px)`）；本插件不调用它，无影响。
- 插件注入的客户端模块 id `@deepseek-ai/dsh-client-ui-slots` 仍由客户端模块图提供（`0.2.1-rc.2` 的多个客户端包把它列为
  client 依赖，不再是可单独安装的 npm 包）；运行时两处 slot 注册成功即为证据。
- 未认证的裸 HTTP 探测 `GET /api/trading/status` 返回 `401` 属设计行为（身份头由浏览器客户端携带），不是兼容性问题。

## 未验证的环境

下表每一项都是 `未验证`：没跑过就是没跑过，不推断、不假设。

| 环境 | 状态 | 说明 |
| --- | --- | --- |
| macOS（darwin，arm64 / x64） | `未验证` | 宿主传输与客户端 bundle 都没在 darwin 上跑过 |
| Linux（x64 / arm64） | `未验证` | 同上 |
| WSL / WSL2 | `未验证` | 按独立平台处理 |
| Windows ARM64 | `未验证` | 本次是 `win32 x64` |
| 真正的 Windows 10（19041–19045） | `未验证` | 注册表名与内核版本不一致，只声明实测到的那组字段 |
| DSH CLI `0.1.5-rc.3` | `未验证` | CLI 在本机存在，但联调的是桌面宿主 `0.2.0-rc.2` / `0.2.1-rc.2` |
| 其它 DSH 版本（0.3.x 及以后、其它渠道；`0.2.1-rc.2` 已于 2026-10-18 补测，见上表） | `未验证` | 只承诺「同时提供 `connection` / `webServer` 与客户端 `ui-slots`」的版本 |
| Node 20 / 21 / 22 / 23 / 25 | `未验证` | `engines` 声明 `>=20`，但只实测了 v24.15.0 |
| 公司网络 / 反向代理 / VPN 出口 | `未验证` | 只实测本机直连 |
| `en` / `zh` 之外的界面语言 | `不支持` | `SUPPORTED_LANGS = ['en','zh']`，非法语言返回 `BAD_REQUEST` |

## 运行要求

- **Node.js `>=20`**：来自 `package.json` 的 `engines.node: ">=20"`；插件**不带运行时依赖**，`npm test` 在全新 clone
  上离线可过。只有 `v24.15.0` 实测过，其余版本按上表记为 `未验证`。
- **DSH**：需要同时具备宿主侧 `connection`、`webServer` 服务与客户端 `ui-slots`（`@deepseek-ai/dsh-client-ui-slots`）。
  `connection` 提供 `requestRejection(req)`，`webServer` 提供前缀路由注册，`ui-slots` 提供 header 按钮与
  `shell.overlay` 浮层；`llm` / `dsh-storage-domain` 缺失只降级（AI 报 `AI_UNAVAILABLE`、自选股回落文件存储）。
- 自查：`node -v` ≥ 20；`cordis_inspect_query(host, Service, listService)` 里有 `connection` 与 `webServer`；
  `cordis_inspect_query(client, Slots, listSubTree)` 能看到 `conversation.session.header.actions` 与 `shell.overlay`；
  `GET /api/trading/status` 回 `config.networkMode` / `config.providerChains` / `ai.reason`；`npm run verify:install`
  校验 profile 装的就是这份代码。

## 市场与数据源能力矩阵

取值只有四个：`支持` / `部分支持` / `不保证` / `不支持`。`支持` = 有实测出数的路径且多半还有第二源兜底；
`部分支持` = 只有一个上游，或只覆盖部分区间 / 板块 / 查询写法；`不保证` = 依赖单一上游且本环境实测经常不可达，
可用性随网络变化，不构成承诺；`不支持` = 没有实现。

| 市场 | 搜索 | 报价 | 历史 K 线 | 技术指标 | 公司档案 | AI 分析 | 全量清单 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| US | 支持 | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| HK | 支持 | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| CN | 支持 | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| JP | 部分支持 | 支持 | 不保证 | 不保证 | 部分支持 | 支持 | 不保证 |
| CRYPTO | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |

实时可用性受 Provider 与网络影响。

逐格依据（`lib/trading/config.js` 的 `MARKET_DATA_CONFIG` / `UNIVERSE_PROVIDERS` + 各 provider 运行时 `capabilities`）：

- **搜索**：US/HK 东财 suggest（+ 本地目录 + 已载入清单）；CN 东财（+ 中文名种子目录）；JP 上游只认**东京代码**与
  **中文名**，假名 / 罗马字靠本地目录补 → `部分支持`；CRYPTO 用 CoinLore 榜单本地过滤。
- **报价**：US/HK/CN/JP 东财（主力）+ 腾讯（本环境 Yahoo 实际 **403 不出数**）；CRYPTO 为 Binance + Gate（USDT，7×24）。
- **历史 K 线 / 技术指标**：US 东财日/周 + 新浪美股日线兜底（**美股分钟线仅东财**）；HK 东财日/周；CN 东财 + 新浪 +
  腾讯日线；**JP 没有可达的历史 K 线源**（腾讯东京接口只回 1 根、东财 `push2his` 会 RST，图表只有极少数根并标
  `partial history`，MA200 之类也算不出）→ 两者都 `不保证`；CRYPTO 为 Binance/Gate 分页全历史。指标由插件本地算
  （`getTechnicals` → `candles('1d','1y')` → `computeTechnicals`）。
- **公司档案**：US/HK/CN/JP 都依赖东财（Yahoo 403）→ `部分支持`，北交所在 Yahoo 无对应页面；CRYPTO 由 CoinLore 提供
  名称 / 中文名 / 市值 / 排名，未收录的小币种回落目录合成档案。
- **AI 分析**：走宿主 `llm` 服务，价格与指标由插件先算好再交给模型。
- **全量清单**：US 东财 `clist` → Nasdaq；HK 东财 → 新浪；CN 新浪 → 东财；JP **仅东财**（不可达时该板块报「清单源
  不可用」）→ `不保证`；CRYPTO CoinLore → Binance。
- **指数不计入本表**：`^N225` 只有东财一个源；加密货币没有指数条，用现货价格条（USDT 计价）。

## 网络模式

`networkMode` 取 `auto | standard | compatibility`，默认 `auto`：`standard` 是朴素 `node:http(s)`、用运行时自己的
DNS 顺序、不钉地址族；`compatibility` 记住上次应答过的地址族并在每次重试钉死 / 翻转；`auto` 从 `standard` 起步，
**只把真正在传输层失败的 host** 提升到 `compatibility`。

诚实的部分：**可用性取决于网络，不取决于插件**。项目记录（2026-10-07，本机网络）里 Yahoo 与 Stooq 对未鉴权请求
返回 **403**，东财批量端点 `clist` 与 K 线主机 `push2his` 会在一段时间内对同一网络下的所有客户端返回 **RST**。
**2026-10-10 本次没有重跑在线探针**，这两个数字按项目记录引用，属 `未实测`。

配置写在插件 entry 的 `config.networkMode` / `config.providers` 下。非法配置不打断插件：未知 mode / 市场 /
provider、重复项、空链都会被报告并忽略，出厂默认继续生效，日志记录 `trading-mode: invalid configuration — <problem> …`。

## 反向代理 / 远程访问

代码实际只做一件事：把请求交给**宿主自己的判据**，没有第二套鉴权。

- `lib/trading/api.js:309-322` 的 `fence(req)` 直接调用 `this.connection.requestRejection(req)`；宿主回的 `403` /
  `401` 被映射成同源错误码 `FORBIDDEN`（`lib/trading/api.js:262`）与 `UNAUTHENTICATED`（`lib/trading/api.js:263`）。
- 所以**同源只是和宿主自己的认证一样强**，不多也不少：插件不做额外 header / Origin 校验、不做 IP 白名单。反向代理
  如果把 `/api/trading` 暴露给未认证来源，同源保护就等于不存在；代理必须原样转发 `Host` / `Origin` 与浏览器会话，
  否则会被宿主判据拒绝（403 / 401）。
- **0.8.0 起围栏 fail closed**：宿主没有 `connection`、没有 `requestRejection`、或该判据抛错时，`fence()`
  返回 `503`，除 `GET /api/trading/health` 外的所有路由回答 `HOST_SECURITY_UNAVAILABLE`，请求在配额、service
  与 store 之前就被拒（日志 `refusing <METHOD> <path>`）。0.7.0 在这种情况下是放行的 —— 这是本版本唯一的行为不兼容。
- 唯一的例外是操作者**显式**写下的 `security.allowUnfencedLoopback: true`（默认关闭）：只对回环对端生效、每次放行
  打一条 error 级 `SECURITY` 日志、远端对端照旧 503（`lib/trading/api.js:330-343`）。在无围栏宿主上，这就是
  「别把 `/api/trading` 暴露到本机以外」的唯一可行做法。
- `GET /api/trading/health` 是唯一免围栏端点（`lib/trading/api.js:251-254`、`350+`）：只支持 GET，只回
  `{plugin, version, api, fence, identity, note}`，不触上游、不读存储、不含用户数据或路径。

## 存储范围（同机 / 跨设备）

| 数据 | 后端 | 位置 |
| --- | --- | --- |
| Watchlist（只存成员关系：symbol / market / order / favourite） | 宿主 `dsh-storage-domain` 可用时用它，否则 JSON 文件 | 域表 `trading_watchlist@1`（在 `<profile>` 内），否则 `<DSH home>/trading-mode/watchlist.json` |
| 界面偏好（显示语言） | 原子写 JSON | `<DSH home>/trading-mode/settings.json` |
| 行情缓存（报价 / K 线 / 档案） | 进程内存，可选 JSON 快照 | `<DSH home>/trading-mode/market-cache.json` |
| 全量清单索引（浏览过的板块） | JSON 快照 | `<DSH home>/trading-mode/universe.json` |

**同机 / 单机**：以上数据都保存在运行 DSH 的**那台机器上的那个 profile 里（单机 / 本机 / 同一台机器）**，没有插件
自己的服务器、也没有账号。每行都带 DSH User ID，读取按该 ID 过滤，同一 profile 的两个用户互相看不到对方的自选。

**0.8.0 起身份是硬前提**：宿主提供不出匿名用户 id、你也没有声明 `identity.localBucket` 时，插件**没有**可用的存储键，
于是自选与偏好的读写一律 `503 NO_IDENTITY`（不会退回一个所有人共用的 `local` 桶）；行情类只读端点照常工作且不落任何
按用户数据。单用户部署要恢复自选，需显式声明 `identity.localBucket`，并在文档与心里都承认「这台机器只有一个用户」。

**跨设备同步不承诺**：只有当宿主 profile 存储自己提供同步时才可能 —— 用 `dsh-storage-domain` 时继承该服务的行为，
JSON 兜底就是本机文件，始终留在本机。不要把「另一台电脑上也有同样的自选」当成受支持的功能。

## 测试证据（本次实测）

`node tests/offline/run.mjs`（摘录，末行原文）：

```
== offline suite summary ==
  PASS  syntax      2 passed, 0 failed, 0 skipped
  PASS  config     11 passed, 0 failed, 0 skipped
  PASS  transport   8 passed, 0 failed, 0 skipped
  PASS  limits     10 passed, 0 failed, 0 skipped
  PASS  router      9 passed, 0 failed, 0 skipped
  PASS  api        14 passed, 0 failed, 0 skipped
  PASS  fence       8 passed, 0 failed, 0 skipped
  PASS  identity    7 passed, 0 failed, 0 skipped
  PASS  watchlist   4 passed, 0 failed, 0 skipped
  PASS  ai         21 passed, 0 failed, 0 skipped
  PASS  client     28 passed, 0 failed, 0 skipped
  PASS  release-scripts  22 passed, 0 failed, 0 skipped
  PASS  repo        9 passed, 0 failed, 0 skipped
  13 passed, 0 failed, 0 skipped
```

`npm run test:release`（同一批检查，额外规则是任何 SKIP 即失败）末行原文：

```
  release gate: PASS — no failures and no skipped checks
```

`node tests/network/verify-install.mjs`（摘录，末行原文）：

```
  PASS  the profile sees package.json version 0.8.1 — name=dsh-trading-mode version=0.8.1
  PASS  the installed AI layer talks to the host llm service without importing host packages — local chunk assembly · route deepseek-official/deepseek-flash
  PASS  the installed host half loads the five-market code — markets US/HK/CN/JP/CRYPTO · indices 15
  PASS  the installed client half carries the five-market UI markers — 124 KB, five markets + partial-history badge
  PASS  every shipped file is byte-identical to this working tree
  6/6 install checks passed
```

`node scripts/smoke-artifact.mjs`（打包审计，不安装、不加载）末行原文：

```
  verdict: SHIPPABLE
```

它同时打印 tarball 的 `sha256`、字节数与文件数（本次 **74 files**，73 个文本文件扫描无机器路径、
32 个 packed `lib/**/*.js` 全部通过 `node --check`）。`sha256` 随源码变动而变，因此本文件不固化该值，
每个 release 以当次输出为准（`docs/RELEASING.md` §5）。

- `tests/network/host.test.mjs`（在线探针，非阻断）：**本次实测** `95/95 PASS, 0 failed, 10 degraded`，exit `0`
  （上游不可达项按 `DEGRADED` 记，provider health 全部 `healthy`）；该退出码不参与门禁。
- 其余未实测项均只出现在「未验证的环境」里，不在支持范围内。
