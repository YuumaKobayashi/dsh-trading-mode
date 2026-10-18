# dsh-trading-mode

**本地运行、由 DSH（DeepSeek Harness）宿主承载的行情研究面板**：覆盖美股（US）、港股（HK）、A 股（CN）、日股（JP）与加密货币（CRYPTO）**五个市场**，提供报价、K 线、技术指标与公司档案，外加一个跑在宿主 `llm` 服务上的 AI 分析。当前版本 **`0.8.1`，处于 Beta / 0.x 阶段** —— 版本号一律以 `package.json` 为准，运行时可用围栏无关的 `GET /api/trading/health` 读到。它**不下任何订单**，也不提供投资建议：所有内容仅供个人研究。

## 使用限制

- **不下单、不接券商**：插件没有任何能触达市场的写操作，也没有持仓、盈亏、组合与回测。
- **不保证实时**：数据来自第三方公开网页接口，通常有延迟。每条行情都带时间戳与新鲜度：`Updated HH:MM:SS` + `Data may be delayed`，用过期缓存时标 `Last available data`。时效分级是 **`fresh`（≤5 分钟）/ `delayed`（≤30 分钟）/ `stale`（≤24 小时）/ `historical`（更旧）**；界面**从不**标注 Live / Real-time / Tick-level，也**不承诺** tick / Level-2 / 全市场覆盖。同一时刻只显示一种状态 —— `Updated` 与 `Last available data` 不会同时出现。
- **不保证上游可用**：源站会限流、重置连接、改版，或对某些网络区域返回 403。可用时插件自动降级到备用源；不可用时给明确错误并标注降级，**不编造数据**。
- **没有盘中基本面**：没有财报日历、公告流、新闻流，也没有盘中估值刷新。
- **不承诺跨设备同步**：自选、语言与配色偏好只落在**本机**的那个 DSH profile 里（配色偏好由 DSH 自己的主题设置保存）；跨设备同步需要宿主存储后端自己提供，本插件不承诺。
- **上游端点可能失效**：这些都是未鉴权的公开接口，随时可能改版或封锁，属已知风险而非缺陷。
- **界面语言只有 `en` / `zh`**：`SUPPORTED_LANGS = ['en', 'zh']`（`lib/trading/config.js`），其它语言返回 `BAD_REQUEST`，不会被静默忽略。
- **AI 不取价**：报价与成交量由上游取得、经插件校验与归一化后写进快照；技术指标（SMA / EMA / RSI / MACD / ATR / 枢轴等）由插件**本地计算**。两类数据都是组装成快照后交给模型的，模型不访问任何财经网站。
- **日股（JP）不与 US / HK / CN 同级**：JP 的**历史 K 线、技术指标与全量清单都记 `不保证`**（没有可达的历史 K 线源；清单只有东财一个源）。不要把 JP 与其它市场读成同一档能力，逐格依据见下方「功能范围」。
- **指数点位不是可交易价格**；加密货币一律以 USDT 现货计价。
- **宿主请求围栏缺失时默认拒绝服务**：插件 fail closed —— 宿主没提供可用的请求围栏时，除 `GET /api/trading/health` 外的所有路由返回 **503 `HOST_SECURITY_UNAVAILABLE`**。唯一例外是你**显式**在插件配置里写下的 `security.allowUnfencedLoopback: true`：它只对回环来源生效、每次使用都打一条 error 级 `SECURITY` 日志、远端来源照旧拒绝，默认关闭 —— 换句话说，没有任何「开发模式」会自动放行请求。
- **没有可靠身份时不写用户数据**：拿不到可信的每用户身份时，读行情照常，但自选 / 偏好的**写**路径返回 **503 `NO_IDENTITY`**，不会把所有浏览器混进同一个存储桶。

## 安装三步

安装入口是 **DSH 内部的一次工具调用**（`plugin_manager`），不是终端命令。本目录**不是 git 工作树、没有远程仓库（remote）、也没有发布到任何 registry** —— 所以本文档**不提供**下载 URL、npm 包名、版本锁定或发布产物校验和的写法：你拿到的是这份目录本身（或别人给你的打包副本），校验和请在你自己的副本上用下面的 `npm run smoke:artifact` 现算。

先确认三件事：

- **运行环境**：这是一个 DSH **bundle**，必须由宿主加载、**不能独立运行**；`package.json` 声明 `engines.node >= 20`（Node 20 或更高），而实测过的是 Node `v24.15.0` + DSH `0.2.0-rc.2` 与 `0.2.1-rc.2`（完整矩阵见「兼容性」）。
- **当前运行的是哪个 profile**：DSH 可以有多个 profile，插件管理器只作用于**当前运行的那个**。装错 profile 的典型症状是「Loader 里没有这一行、页面上也没有按钮」，而日志里往往什么也看不到。
- **`target` 必须是绝对路径**：`~` 不会被展开。

**步骤 1 — 拿到目录，确定它的绝对路径。**

把这份 `dsh-trading-mode` 目录放在本机任意位置（例如 `<你的插件目录>\dsh-trading-mode`）。可以先用只读检查看现状：

```text
npm run inspect:profile
```

不要执行 `npm install dsh-trading-mode`、`npx dsh …` 或 `dsh plugin install …` —— 这三条命令都不存在，本仓库也没有任何已发布的包名可以这样装（`npm install` 只装开发依赖，见「开发与文档索引」，它**不是**安装插件的方式）。

**步骤 2 — 在 DSH 里安装：一次受审批的工具调用。**

```text
plugin_manager({ action: "install_bundle", target: "<PATH TO YOUR COPY>" })   // 换成你的绝对路径
```

- 插件管理属于**受审批操作**：DSH 会先向你请求许可，批准后才执行。
- 安装动作由 **DSH 自己**完成：它会写当前 profile 的 `package.json` 与 `cordis.patch.yml`（本 bundle 的 patch 入口是包内的 `cordis.patch.yml`）。**不要手改 profile** —— 不要往 `cordis.yml`、profile 的 `package.json` 或 `dsh.profile.bundles` 里手动加行；手动写出来的半装状态正是「装错 profile / Loader 里没有这一行」的主要来源。
- 宿主侧代码只在 DSH 进程启动时加载：装完**重启一次 DSH**；客户端 bundle 按请求提供，浏览器刷新即可。

**步骤 3 — 确认已加载。**

- `plugin_manager({ action: "list_bundles" })` 里出现 `dsh-trading-mode`；profile 的 `dsh.profile.bundles` 里出现该条目，Loader 里出现 `include:trading-mode`。
- 打开任意会话后，标题栏出现 **Trading Mode** 按钮。它挂在 `conversation.session.header.actions` 这个 session 级 list slot 上，空状态不渲染，所以「没有会话时看不到按钮」是正常的。
- 只读复核：`npm run inspect:profile`；更严格的一致性检查见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的 `npm run verify:install`。

### 升级 / 禁用 / 卸载

- **升级**：对新的目录再调一次 `install_bundle`（`target` 指向新副本），然后重启 DSH。自选、偏好与缓存都在 bundle **之外**，升级不会丢。
- **禁用（不删除）**：`plugin_manager({ action: "set_bundle", target: "dsh-trading-mode", enabled: false })`。
- **卸载**：`plugin_manager({ action: "remove_bundle", target: "dsh-trading-mode" })`，然后重启 DSH。
- **卸载不删数据**：自选 / 偏好 / 行情缓存 / 目录快照都在 bundle **之外**的 `<DSH_HOME>/trading-mode/`（`<DSH_HOME>` = `$DSH_HOME`，否则 `$DSH_DIR`，否则 `~/.dsh`；路径解析见 `lib/index.js` 的 `resolveHomeDir()`）。`remove_bundle` 只移除插件，**不会**删除这些文件；要彻底清理需要你手动删该目录，或按 [docs/PRIVACY.md](docs/PRIVACY.md) 的流程处理。
- **备份 / 迁移**：备份 = 复制 `<DSH_HOME>/trading-mode/`；数据按 DSH user id 隔离，只属于**那一个 profile**，换 profile 或换机器不会自动带走，也不承诺跨设备同步。

### 只读自检工具（`package.json` 里的两个脚本）

这两个脚本只读 / 只在临时目录工作，不改动任何 profile，也不安装任何东西：

```text
npm run inspect:profile   # scripts/inspect-profile.mjs：只读，报告哪个 profile 装了这个插件、版本是多少、是 junction 还是 copy
npm run smoke:artifact    # scripts/smoke-artifact.mjs：打包产物并审计文件白名单与机器路径，打印 sha256 与体积
```

### 安全围栏（fail closed）

- 每个 `/api/trading/*` 请求都先过**宿主自己的**围栏 `connection.requestRejection(req)`（与 DSH API 网关同一道判据）；插件不自行解析 `Origin` / `Host`，没有 IP 白名单，也没有第二套鉴权。
- 围栏**缺失或抛错**时，**除 `GET /api/trading/health` 外的所有路由返回 503 `HOST_SECURITY_UNAVAILABLE`**。`health` 是唯一豁免：它围栏无关、不带用户数据、不读配置、不打上游，只回答 `{plugin, version, api, fence, identity, note}`（`lib/trading/api.js`）。
- 唯一例外是显式的 `security.allowUnfencedLoopback` 开关（默认 **`false`**，**只对回环地址生效**，首次放行时以 `SECURITY` 级别打醒目告警）。它是需要刻意打开的本机调试例外，**不是 “开发模式”**，不会被任何其它配置、环境变量或缺失的服务自动打开。
- 反向代理若把 `/api/trading` 暴露给未认证来源，同源强度就等于不存在；代理必须原样转发 `Host` / `Origin` 与浏览器会话。

## 首次使用

- 打开任意会话 → 标题栏 **Trading Mode** → 面板首屏一次往返（`GET /api/trading` 等价 `/api/trading/bootstrap`）：自选表 + 每行报价 + 推荐池 + 状态 + AI 状态 + 偏好。取价失败的行 `quote:null` 并带错误码，不影响首屏。
- 界面语言只有 `en` / `zh`；其它语言返回 400 `BAD_REQUEST`。
- **配色可切换（0.8.1）**：面板头部的「深色 / 浅色」把窗口在**黑底白字**与**白底黑字**之间切换。所有面板表面都用自己的**不透明**调色板上色，因此窗口永远不会透出背后的对话；宿主提供 `theme` 服务时这个选择会写进 **DSH 自己的主题偏好**并随宿主设置持久化，宿主没有该服务时仅在本会话内生效（面板照常可切换）。
- **身份决定能不能写用户数据**。解析顺序（`lib/index.js` 的 `resolveIdentity()` + `lib/trading/config.js` 的 `IDENTITY_POLICY`）：① 宿主模块 `@deepseek-ai/dsh-anonymous-user-id`（可用时就是它）；② 操作者显式声明的 `identity.localBucket`（等于声明「这个部署是单用户」，需要你自己承担该前提）；③ 没有身份。第 ③ 种情况下**读行情照常可用**，但自选与偏好的**写**路径、以及按用户计量的路径返回 **503 `NO_IDENTITY`**，不会把所有人混进同一个桶。当前身份来源可在 `GET /api/trading/status` 的 `identity` 字段与启动日志行里看到。
- **自检入口**：`GET /api/trading/health`（围栏无关，只有版本与围栏 / 身份状态）；完整状态 `GET /api/trading/status`（provider 逐能力健康度、`ai.reason`、配额余量；诊断字段已脱敏，可整段贴进 issue，见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)）。
- **时效标注**：每条报价带 `Updated HH:MM:SS` 与 `Data may be delayed`，使用过期缓存时标 `Last available data`；AI 分析按 `meta.dataQuality.grade`（`fresh` / `delayed` / `stale` / `historical`）在卡片上显示时效提示条，非 `fresh` 时禁止把数据表述为 now / today / live。界面**从不说**实时。
- **「核心插件可用」与「AI 已配置」是两件事**：装上插件、宿主围栏可用就能读行情；AI 分析需要宿主 `llm` 服务与一个可用的模型路由，否则回答 `AI_UNAVAILABLE`，具体原因在 `ai.reason`。**可选配置（含 AI 路由说明）见下方「功能范围」**；provider / 路由内部结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)。
- **启动日志行**（`lib/index.js`）一次回答三件事 —— 数据后端、AI、身份与围栏：

  ```text
  trading-mode: ready (… ; ai: available|unavailable — <reason>; identity: <source>…; request fence: host|unavailable — the API refuses with 503)
  ```

## 兼容性

- **实测过的环境**：Windows 11 x64（`win32` x64，`Microsoft Windows NT 10.0.26300.0`）+ Node `v24.15.0`（npm 11.12.1）；DSH 桌面宿主 `0.2.0-rc.2`（内含 `@deepseek-ai/cordis@4.0.4`，2026-10-10）与 **`0.2.1-rc.2`（内含 `@deepseek-ai/cordis@4.0.5`，2026-10-18 升级复测）**，两者都满足 peer `^4.0.1`。两个宿主上离线套件都是 **`13 passed, 0 failed, 0 skipped`**（13 个套件、153 项检查，`npm run test:release` 输出 `release gate: PASS`），装机校验 `6/6 install checks passed`，AI 路由 `deepseek-official/deepseek-flash`；`0.2.1-rc.2` 上 `/api/trading/health` 回 `api:"ready"`、两处客户端 slot 均 `active:true`。
- **`engines.node: ">=20"` 是声明，不是测试结论**：只跑过 Node **24.15.0**。Node 20 / 21 / 22 / 23 / 25、macOS、Linux、WSL / WSL2、Windows ARM64、DSH CLI、`0.2.0-rc.2` / `0.2.1-rc.2` 之外的其它 DSH 版本、公司网络 / 反向代理 / VPN 出口一律 `未验证`，**不作支持承诺**。完整矩阵与量法见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。
- **宿主要求**：必须同时提供宿主侧 `connection`（提供 `requestRejection(req)`）与 `webServer`（前缀路由注册），以及客户端 `ui-slots`（标题栏按钮与 `shell.overlay` 浮层）。`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-anonymous-user-id` 都是**可选** peer，缺失只降级（AI 报 `AI_UNAVAILABLE` / 自选回落到本机 JSON 文件 / 无身份时写操作被拒），不会让插件加载失败。唯一非可选 peer 是 `@deepseek-ai/cordis`（`^4.0.1`）。
- **运行时依赖为空**（`dependencies` 为空）；`react` / `react-dom` / `zod` 只在开发与测试时需要（`devDependencies`）。

## 功能范围

取值只有四种：`支持` = 有实测出数的路径且多半还有第二源兜底；`部分支持` = 只有一个上游，或只覆盖部分区间 / 板块 / 查询写法；`不保证` = 依赖单一上游且实测常不可达，可用性随网络变化；`不支持` = 没有实现。

| 市场 | 报价 | K 线 | 技术指标 | 公司档案 | 全量清单 | 搜索 |
| --- | --- | --- | --- | --- | --- | --- |
| US | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| HK | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| CN | 支持 | 支持 | 支持 | 部分支持 | 支持 | 部分支持 |
| JP | 支持 | 不保证 | 不保证 | 部分支持 | 不保证 | 部分支持 |
| CRYPTO | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |

逐格依据（`lib/trading/config.js` 的 `MARKET_DATA_CONFIG` / `UNIVERSE_PROVIDERS`）：

- **报价**：US / HK / CN / JP 走东财（主力）+ 腾讯（备用）；CRYPTO 走 Binance + Gate（USDT，7×24）。
- **K 线 / 技术指标**：US = 东财日 / 周 + 新浪美股日线兜底（**美股分钟线仅东财**）；HK = 东财 + 腾讯 + stooq；CN = 东财 + 腾讯 + 新浪日线；CRYPTO = Binance / Gate 全历史分页。**JP 没有可达的历史 K 线源**（腾讯东京接口任何区间只回 1 根、东财 `push2his` 会 RST），图表只显示极少数根并标 `partial history`，MA200 一类指标也算不出 —— 所以 JP 的这两格是 `不保证`，**明显弱于 US / HK / CN**。
- **公司档案**：US / HK / CN / JP 都依赖东财（Yahoo 在实测网络下 403）→ `部分支持`；CRYPTO 由 CoinLore 提供名称 / 中文名 / 市值 / 排名，未收录的小币种回落目录合成档案。
- **全量清单**：源顺序 `UNIVERSE_PROVIDERS` —— US `eastmoney → nasdaq`、HK `eastmoney → sina`、CN `sina → eastmoney`、JP 仅 `eastmoney`、CRYPTO `coinlore → binance`。JP 清单源不可达时该板块报「清单源不可用」，而不是造行。
- **搜索**：US / HK / CRYPTO 走东财 suggest 或 CoinLore 榜单；JP 上游只认**东京代码**与**中文名**，假名 / 罗马字靠本地目录补 → `部分支持`；CN 只有东财 suggest 一条路（外加中文名种子目录）且无第二源 → `部分支持`。证券类型见 `SEARCH_SECURITY_TYPES`，上限 `SEARCH_RESULT_LIMIT = 100`。
- **可浏览板块**（`UNIVERSE_BOARDS`）：US 三个（NASDAQ / NYSE / AMEX）、HK 三个（主板 / GEM / 基金信托）、CN 五个（沪市主板 / 科创板 / 深市主板 / 创业板 / 北交所）、JP 一个（东证）、CRYPTO 一个（市值榜 `TOP`）。港股债券 / 权证 / 牛熊证被显式排除。
- **AI 分析**：五个市场都走宿主 `llm` 服务；取不到报价即失败，不会拿陈旧价格糊过去。
- **时效分级**：`fresh`（≤5 分钟）/ `delayed`（≤30 分钟）/ `stale`（≤24 小时）/ `historical`（更旧），阈值在 `lib/trading/config.js` 的 `AI_CONFIG`（`freshMaxAgeMs` / `staleWarnMs` / `staleHistoricalMs`）；非 `fresh` 时系统提示禁止把数据表述为 now / today / live。
- **入站配额与并发闸**（`lib/trading/config.js` 的 `API_POLICY`，由 `lib/trading/limits.js` 执行；滑动 60 秒窗口）：**每身份 240 次/分钟、全局 1200 次/分钟**；昂贵端点 `analyze` 20/60、`brief` 6/30、`universeRefresh` 2/4（每身份 / 全局）；同时在飞的 AI 分析 ≤ **2**（全局 ≤ **4**）。超限返回 **HTTP 429 `RATE_LIMITED`** 与 `Retry-After` 头；被拒请求不消耗额度、也不会打到上游。
- **长任务有预算且可取消**：全市场目录扫描受 `UNIVERSE_POLICY.budgetMs` = **15 分钟**墙钟预算约束，超预算即停止翻页并报 `complete: false` + `reason: "budget"`；`DELETE /api/trading/universe` 可取消正在进行的扫描。

### 可选配置（不配也能用）

配置写在 profile patch 层的插件 entry 上（loader id 为 `trading-mode`）。**出厂默认已经可用**，核心插件装上即可读行情，以下键全部可选；不写任何配置就是默认值：

```yaml
- id: trading-mode
  config:
    networkMode: auto      # auto | standard | compatibility，默认 auto
    providers:             # 逐市场覆盖数据源顺序（可选；下面是示例覆盖，不是出厂默认）
      US: ['yahoo', 'eastmoney', 'tencent', 'sina', 'stooq']
      CRYPTO: ['binance', 'gate', 'coinlore']
    identity:
      localBucket: my-single-user-box   # 仅单用户部署：无宿主匿名 id 时用它落库（等于声明「单用户」）
    security:
      allowUnfencedLoopback: false      # 默认 false；唯一放行开关，只对回环来源生效，需自担风险
```

- **`networkMode`**：`standard` 是朴素 `node:http(s)`（用运行时自己的 DNS 顺序，不钉地址族）；`compatibility` 记住上次应答的地址族并在每次重试时钉死 / 翻转；`auto` 从 `standard` 起步，**只把真正在传输层失败的 host** 提升到 `compatibility`。取其它值直接被拒绝：`networkMode must be one of auto, standard, compatibility (got "fast")`。
- **`providers`**：市场 → provider id 的有序数组，覆盖 `MARKET_DATA_CONFIG` 的出厂链。合法 id 只有 `yahoo`、`eastmoney`、`tencent`、`stooq`、`sina`、`nasdaq`、`binance`、`gate`、`coinlore`。
- **`identity.localBucket`**：只给**单用户**部署用。设置它就等于你声明「这个 DSH 只有一个用户」；多用户共享一个 DSH 时不要设。
- **`security.allowUnfencedLoopback`**：**唯一的放行开关，默认 `false`，正常使用不要打开**。宿主没提供请求围栏时，设为 `true` 会让**回环来源**（`127.0.0.1` / `::1`）的请求绕过围栏、其它来源照旧 503；插件在启动与每次实际放行时都会写一条 error 级 `SECURITY` 日志，`GET /api/trading/health` 会显示 `api: "ready-on-loopback-only"` / `fence: "loopback-exception"`。取非布尔值会被拒绝：`security.allowUnfencedLoopback must be true or false (got …)`。
- **非法值不会生效**：未知市场 / 未知 provider / 重复项 / 空数组 / 非数组都会被拒绝，出厂默认继续生效，并写一条日志 `trading-mode: invalid configuration — <problem> (the shipped default stays in force)`。
- **AI 配置**：`AI_CONFIG` 的 `provider` / `model` 可用时优先，其次取 DSH 当前默认模型，再退到 `llm.listProviders()` 里第一个匹配 `/deepseek/i` 的模型；`maxTokens` 2400、`temperature` 0.2、超时 120 s。插件只调用宿主公开服务 `ctx.get('llm').stream({...})`，**不 import 任何宿主私有包，也不需要、不存储任何 API 凭据** —— 鉴权与计费都在宿主侧。provider / 路由内部结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，逐源清单见 [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)，出错怎么办见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 故障处理

先拿 `GET /api/trading/status`：它已经脱敏，可以直接贴进 issue；围栏与身份状态也可以只看 `GET /api/trading/health`。

**Q1：装完了，页面却什么都没有？**
最常见的原因是**装进了另一个 profile**。用 `npm run inspect:profile` 看哪个 profile 里有这个插件、版本是多少、是 junction 还是 copy；再用 `plugin_manager({ action: "list_bundles" })` 复核，并确认 Loader 里有 `include:trading-mode`。

**Q2：所有接口都回 503 `HOST_SECURITY_UNAVAILABLE`？**
说明宿主没有提供可用的请求围栏（`connection.requestRejection` 不存在或调用抛错）。这是**设计上的 fail closed**：除 `GET /api/trading/health` 外一律拒绝，而不是放行未认证来源。此时不要把端口暴露到本机以外；只有在确认端口不可从外部到达时，才考虑那个显式的本机调试例外 `security.allowUnfencedLoopback`（默认关闭，只对回环生效）。启动日志里对应 `request fence: unavailable — the API refuses with 503` 与一条 `SECURITY` 告警。

**Q3：自选 / 设置报 503 `NO_IDENTITY`？**
说明这台部署拿不到可信身份：既没有宿主 `@deepseek-ai/dsh-anonymous-user-id`，也没有声明 `identity.localBucket`。读行情不受影响。二选一：让宿主提供匿名用户 id 模块，或在**确认是单用户部署**时声明 `identity.localBucket`。插件不会退回到「所有人共用一个桶」。

**Q4：上游返回 403，或者报 `UPSTREAM_BLOCKED`？**
说明这个源对你的网络不友好（Yahoo / Stooq 对未鉴权请求返回 403 很常见）。插件会按健康度自动换到链上的下一个源；全部失败时给出 `DATA_UNAVAILABLE` / `UPSTREAM_BLOCKED`，而**不会编造数据**。换一条网络或调整 `providers` 顺序通常能改善。

**Q5：429 是什么？`Retry-After` 怎么用？**
429 表示超过**入站**配额（默认每身份 240 次/分钟，全局 1200，昂贵端点另有专项额度），不是上游限流。响应头 `Retry-After` 给出建议等待秒数；被拒的请求不消耗额度，等一会儿重试即可，不需要改配置。

**Q6：数据是实时的吗？**
不是。每条行情都带数据时间戳与新鲜度标识：`Updated HH:MM:SS` + `Data may be delayed`，使用过期缓存时显示 `Last available data`；分级为 `fresh` / `delayed` / `stale` / `historical`。界面**从不**标注 Live / Real-time / Tick-level。

**Q7：AI 面板显示 `AI_UNAVAILABLE`？**
`GET /api/trading/status` 的 `ai.reason` 会直接说明原因：没拿到 `llm` 服务 / 服务未注册（dsh-llm 插件没加载）/ 服务没有 `stream()` / 没有可用的 DeepSeek 模型路由。插件本身不需要密钥，AI 是否可用取决于宿主。

**Q8：图表上方出现「历史数据不完整」横幅，指标也变少了？**
说明该标的的 K 线根数不够（JP 最常见）。指标按样本量分级：`full` ≥200 根、`partial` ≥50、`limited` ≥20、`insufficient` <20；算不出的指标会列进 `unavailable`，而不是静默变成 0 或空值。

**Q9：公司网络 / 带证书检查的代理下取不到数据？**
先分清两类故障，它们不是一回事：

- **TLS 信任失败**（证书链问题）：报错形如 `SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`。修法是**让 Node 信任企业根证书**：把根证书 PEM 交给启动 DSH 的那个进程（例如 `NODE_EXTRA_CA_CERTS` 指向 PEM 文件），或在宿主侧配置证书。这属于环境修复，不在插件内。
- **DNS / socket 层失败**：报错形如 `EAI_AGAIN`、`ECONNRESET`、`ETIMEDOUT`、`socket hang up`。此时把 `networkMode` 设为 `compatibility`（或先设 `standard` 做对照，证明问题不是这套兼容逻辑造成的）；`auto` 只把真正在传输层失败的 host 升级为兼容模式，所以大多数环境保持默认即可。

**绝不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0`**（或任何等价的「关掉证书校验」开关）来绕过上面第一类问题：它把整条链路的证书校验关掉，制造的安全问题远大于它掩盖的报错，插件不支持也不推荐这种修法。

## 开发与文档索引

### 从源码开发与测试

`npm install` 在这里的意义只有一个：装**开发与测试依赖**（`react`、`react-dom`、`zod`）。它**不是安装插件的方式**（安装见「安装三步」）。不装 devDependencies 时客户端套件会 SKIP（缺 `react`），`npm test` 仍容忍该 SKIP，但**发布门禁 `npm run test:release` 会因此判失败**。

仓库已提交 `package-lock.json`，复现安装请用 `npm ci`；由于 `@deepseek-ai/cordis`（以及可选 `dsh-*` peer）由 DSH 运行时提供、并不在公共 registry 上，npm 的 peer 解析需要显式放行：

```text
npm ci --legacy-peer-deps
```

```text
npm test                 # 离线套件：syntax / config / transport / limits / router / api / fence / identity / watchlist / ai / client / release-scripts / repo
npm run test:release     # 发布门禁：任何失败或跳过都判失败
npm run test:offline     # 等价于 npm test
npm run test:config      # 单跑某一套（test:transport / test:router / test:api / test:fence / test:identity / test:watchlist / test:ai / test:client / test:repo / test:limits）
npm run test:network     # 在线探针：非阻断，上游不可达时记 DEGRADED
npm run check            # 只跑语法检查
```

- 套件退出码：**`0` PASS、`1` FAIL、`3` SKIP**（缺少可选前置条件，例如客户端套件找不到 react）。普通 `npm test` 容忍 SKIP；`npm run test:release` **不允许任何 SKIP**，会打印 `release gate: FAIL — a release must not contain failed or skipped checks`。
- `npm run test:network` 依赖第三方站点，**不作为门禁**：源站可用时断言真实数据，不可用时断言「抛出带类型的 `TradingError`，而不是编造或挂起」，因此结果不会随上游抖动红绿翻转。
- 从工作区源码运行（link 进 profile、重启时机、profile 位置）见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；`npm run verify:install` 校验当前 profile 装的就是这份代码，`npm run inspect:profile` 是只读版（列出每个 profile 是否指向本 checkout、版本与 `lib/index.js` 的 sha256 是否一致，退出码 `0` 已安装 / `1` 未安装或不存在 / `2` 参数错误）。

### 打包

```text
npm pack --dry-run --json   # 只应包含 lib/、docs/、scripts/、tests/、cordis.patch.yml、若干 markdown 与 package.json
npm run smoke:artifact      # 打包后审计文件白名单与机器路径，打印 sha256 与体积
```

### 文档索引

[架构](docs/ARCHITECTURE.md) · [开发](docs/DEVELOPMENT.md) · [排障](docs/TROUBLESHOOTING.md) · [数据源](docs/DATA_SOURCES.md) · [HTTP API](docs/API.md) · [兼容性](docs/COMPATIBILITY.md) · [隐私](docs/PRIVACY.md) · [数据合规](docs/DATA_COMPLIANCE.md) · [发布模板](docs/RELEASE_TEMPLATE.md) · [发布清单](docs/RELEASE_CHECKLIST.md) · [路线图](docs/ROADMAP.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md) · [变更记录](CHANGELOG.md) · [Round-3 审计](docs/AUDIT-ROUND3.md)

### 截图

只收录**真实截图**，政策见 [docs/screenshots/README.md](docs/screenshots/README.md)。该目录当前**没有任何真实截图**，因此本 README 不嵌入图片，也不放占位图或示意图。

### 许可（License）与合规边界

本项目源码为 **MIT**（见 [LICENSE](LICENSE) 与 `package.json` 的 `license` 字段），该许可**只覆盖本仓库的源码**：**不覆盖**上游行情数据，**不覆盖**各上游名称 / 商标，也**不覆盖**页面中嵌入的 TradingView 内容（iframe 由你的浏览器直接从 `s.tradingview.com` 加载，插件不代理、不改造、不剥离其品牌与署名）。逐源条款状态、复用范围与 MIT 的完整范围声明以 [docs/DATA_COMPLIANCE.md](docs/DATA_COMPLIANCE.md) 与 [docs/PRIVACY.md](docs/PRIVACY.md) 为准 —— 那两份文档里 9 家上游与 TradingView 的条款**逐条都带 `not verified` 标记**：本仓库没有读到可引用的条款文本，因此 README 不复述任何条款结论，也不暗示任何授权。公开网页接口只用于你本机安装里的个人研究：不绕过鉴权、不抓登录页、不重新分发数据。
