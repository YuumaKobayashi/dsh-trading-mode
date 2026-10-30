# dsh-trading-mode

一个运行在 [DSH（DeepSeek Harness）](https://github.com/YuumaKobayashi/dsh-trading-mode) 里的行情研究面板。

支持美股、港股、A 股、日股和加密货币，可以查报价、看 K 线和技术指标、浏览标的资料，也可以调用 DSH 的 `llm` 服务生成一份基于当前数据快照的分析。

当前版本为 **0.8.2（Beta）**。实际版本以 `package.json` 为准，也可以通过 `GET /api/trading/health` 查看。

> 这是研究工具，不是交易客户端。插件不接券商、不下单，也不提供投资建议。行情可能延迟，使用前请留意数据时间。

## 安装

插件必须由 DSH 加载，不能单独启动。需要 Node.js 20 或更高版本；目前实际测试的版本是 Node.js 24.15.0，宿主是 DSH `0.2.0-rc.2` 和 `0.2.1-rc.2`。其他环境见[兼容性](#兼容性)。

安装前先确认 DSH 正在使用哪个 profile。插件只会装进当前运行的 profile；如果装完找不到按钮，这是最值得先检查的一项。

### 1. 选择安装来源

在 DSH 的 **设置 → 插件 → 添加插件 → 安装第三方插件** 中，可以填以下任意一种来源。

| 来源 | 填入内容 | 适合场景 |
| --- | --- | --- |
| Release 包（推荐） | `https://github.com/YuumaKobayashi/dsh-trading-mode/releases/download/v0.8.2/dsh-trading-mode-0.8.2.tgz` | 普通安装，无需 git |
| Git 仓库 | `github:YuumaKobayashi/dsh-trading-mode#v0.8.2` | 已安装 git 的机器 |
| npm registry | `dsh-trading-mode` | 可访问 npm registry 的环境 |
| 本地目录 | 插件源码所在的**绝对路径** | 离线安装、开发调试 |

Git 地址也可以写成 `https://github.com/YuumaKobayashi/dsh-trading-mode#v0.8.2`。建议固定 tag；不指定时会安装 `main` 的最新提交。本地路径中的 `~` 不会自动展开。

npm 包名安装会在安装前做版本兼容性预检；Release、Git、本地目录这三种方式的检查发生在安装后。

注意：`npm install dsh-trading-mode` 只会把包装进普通 Node.js 项目，**不会把插件安装到 DSH**。也不要使用 `npx dsh …` 或 `dsh plugin install …`，这两种命令不是当前的安装入口。

### 2. 在 DSH 中安装

将地址或包名粘贴到 **Package name or address**，点击 **Install plugin**，按提示批准安装。

如果通过 DSH 助手执行插件管理操作，可以使用：

```text
plugin_manager({ action: "install_bundle", target: "https://github.com/YuumaKobayashi/dsh-trading-mode/releases/download/v0.8.2/dsh-trading-mode-0.8.2.tgz" })
```

按 npm 包名安装时，使用：

```text
plugin_manager({ action: "install_bundle", target: "dsh-trading-mode", registry: "https://registry.npmjs.org" })
```

`plugin_manager(...)` 是 DSH 内部操作，不是需要复制到终端执行的 shell 命令。安装过程中 DSH 会更新当前 profile 的配置；不需要手动修改 `cordis.yml`、profile 的 `package.json` 或 `dsh.profile.bundles`。

安装完成后**重启 DSH**。宿主侧代码只在进程启动时加载；浏览器端刷新页面即可。

### 3. 检查是否安装成功

1. `plugin_manager({ action: "list_bundles" })` 中能看到 `dsh-trading-mode`，Loader 中有 `include:trading-mode`。
2. 刷新页面后，左侧栏（插件 / 插件市场 / 自动化任务 / 技能中心 那一列）能看到 **Trading Mode** 图标行；点击即可进入，不需要先打开会话。
3. 查看 `GET /api/trading/health`。它会返回插件版本、API、请求围栏和身份状态。

如果手边有源码副本，还可以运行：

```bash
npm run inspect:profile
npm run verify:install
```

前者只读检查哪些 profile 安装了插件，后者检查已安装副本和当前源码是否一致。详细说明在 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

### 升级、禁用和卸载

升级时改用新版本的 tag 或 `.tgz` 地址重新安装，再重启 DSH。自选、偏好和缓存放在 bundle 外，不会因为替换 bundle 而删除。

```text
plugin_manager({ action: "set_bundle", target: "dsh-trading-mode", enabled: false })
plugin_manager({ action: "remove_bundle", target: "dsh-trading-mode" })
```

第一行用于禁用，第二行用于卸载。卸载后也需要重启 DSH。

**卸载不会清除本地数据。** 数据默认放在 `<DSH_HOME>/trading-mode/`，其中 `DSH_HOME` 的解析顺序是 `$DSH_HOME`、`$DSH_DIR`、`~/.dsh`（见 `lib/index.js` 的 `resolveHomeDir()`）。需要彻底清理时，请自行删除该目录，或按照 [隐私文档](docs/PRIVACY.md) 处理。备份和迁移也可以复制这个目录，但数据仍与对应 DSH profile 和用户身份有关，不会自动跨设备同步。

## 开始使用

在左侧栏点击 **Trading Mode** 进入，这是唯一入口（不需要先打开会话，会话标题栏也不再放按钮）。首次打开时，面板会从 `GET /api/trading`（也就是 `/api/trading/bootstrap`）读取自选列表、报价、推荐池、状态和偏好。某条报价获取失败时，该行会返回 `quote: null` 和错误码，不会拖垮整个面板。

面板支持中文和英文（`zh` / `en`），其他语言参数会得到 `400 BAD_REQUEST`。可以在面板头部切换深色和浅色主题；如果宿主提供 `theme` 服务，选择会通过 DSH 的主题偏好保存，否则只在当前会话生效。

行情不是实时推送。正常报价旁会显示 `Updated HH:MM:SS` 和 `Data may be delayed`；使用过期缓存时改为 `Last available data`，不会同时显示两种时间状态。具体时效分为：

| 状态 | 数据年龄 |
| --- | --- |
| `fresh` | 不超过 5 分钟 |
| `delayed` | 不超过 30 分钟 |
| `stale` | 不超过 24 小时 |
| `historical` | 超过 24 小时 |

面板不标注 Live、Real-time 或 Tick-level，也不提供 Level-2 行情。指数点位不代表可交易价格；加密货币使用 USDT 现货报价。

### AI 分析怎么工作

报价和成交量来自第三方数据源，经过插件校验、归一化后放入快照；SMA、EMA、RSI、MACD、ATR、枢轴等指标由插件本地计算。AI 只接收整理好的快照，通过 DSH 的 `llm` 服务分析，**不会自己访问财经网站取价**。

AI 是可选能力。即使宿主没配模型，行情面板仍可以使用；AI 区域会显示 `AI_UNAVAILABLE`，具体原因在 `GET /api/trading/status` 的 `ai.reason` 中。没有可用报价时，分析也会失败，不会生成一个看似完整但没有价格依据的结论。数据不够新时，AI 卡片会显示时效提示，并避免把旧数据描述成当前实时情况。

## 各市场支持情况

这里的“支持”表示已有实测可用的数据路径；“部分支持”通常表示覆盖不完整或缺少备用源；“不保证”表示当前上游在实测网络中经常不可达；“不支持”表示尚未实现。

| 市场 | 报价 | K 线 | 技术指标 | 公司档案 | 全量清单 | 搜索 |
| --- | --- | --- | --- | --- | --- | --- |
| 美股 US | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| 港股 HK | 支持 | 支持 | 支持 | 部分支持 | 支持 | 支持 |
| A 股 CN | 支持 | 支持 | 支持 | 部分支持 | 支持 | 部分支持 |
| 日股 JP | 支持 | 不保证 | 不保证 | 部分支持 | 不保证 | 部分支持 |
| 加密货币 CRYPTO | 支持 | 支持 | 支持 | 支持 | 支持 | 支持 |

**日股需要单独说明。** JP 报价可以通过东财和腾讯获取，但目前没有可靠的历史 K 线来源：腾讯东京接口通常只返回一根，东财 `push2his` 在实测环境中会重置连接。因此图表可能只显示少量数据并提示 `partial history`，MA200 等长周期指标也可能无法计算。日股完整标的清单只有东财一个来源，失效时会明确提示不可用。

各市场的数据链路如下：

| 能力 | 数据来源和限制 |
| --- | --- |
| 报价 | US / HK / CN / JP：东财优先，腾讯备用；CRYPTO：Binance、Gate，USDT 现货，7×24 小时 |
| K 线 | US：东财日/周线，新浪日线备用（分钟线只有东财）；HK：东财、腾讯、Stooq；CN：东财、腾讯、新浪日线；CRYPTO：Binance、Gate 历史分页；JP：不保证 |
| 公司档案 | US / HK / CN / JP 依赖东财；Yahoo 在实测网络下返回 403。CRYPTO 主要来自 CoinLore，部分小币种使用目录合成档案 |
| 全量清单 | US：东财 → Nasdaq；HK：东财 → 新浪；CN：新浪 → 东财；JP：东财；CRYPTO：CoinLore → Binance |
| 搜索 | US / HK / CRYPTO 支持上游搜索或榜单；CN 主要依赖东财 suggest 和本地中文种子目录；JP 主要识别东京代码、中文名，假名和罗马字依赖本地目录补充 |

可以浏览的板块包括：US 的 NASDAQ / NYSE / AMEX，HK 的主板 / GEM / 基金信托，CN 的沪市主板 / 科创板 / 深市主板 / 创业板 / 北交所，JP 的东证，以及 CRYPTO 市值榜 `TOP`。港股债券、权证和牛熊证不在清单中。搜索单次最多返回 100 条；类型配置见 `SEARCH_SECURITY_TYPES`。

默认源顺序和各市场配置在 `lib/trading/config.js` 的 `MARKET_DATA_CONFIG`、`UNIVERSE_PROVIDERS`、`UNIVERSE_BOARDS` 中。更详细的接口和来源说明见 [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)。

### 当前没有做的功能

插件不支持下单、券商账户、持仓、盈亏、投资组合或回测；也没有财报日历、公告流、新闻流、盘中估值刷新、tick 行情或全市场实时覆盖。自选和偏好只在当前 DSH profile 的本地存储中保存，不承诺跨设备同步。

## 配置

默认配置即可使用行情功能。以下都是可选项，配置位置是 profile patch 中 loader id 为 `trading-mode` 的插件 entry。修改前建议先参考 [开发文档](docs/DEVELOPMENT.md)；不要为了安装插件手动编辑 profile 配置。

```yaml
- id: trading-mode
  config:
    networkMode: auto  # auto | standard | compatibility
    providers:         # 示例：覆盖默认数据源顺序
      US: ['yahoo', 'eastmoney', 'tencent', 'sina', 'stooq']
      CRYPTO: ['binance', 'gate', 'coinlore']
    identity:
      localBucket: my-single-user-box  # 只适用于单用户部署
    security:
      allowUnfencedLoopback: false    # 默认关闭
```

`networkMode` 默认是 `auto`：平时使用 Node.js 标准 HTTP(S) 网络行为，只有某个 host 真正发生传输层失败时才切到兼容模式。`standard` 始终使用默认 DNS/连接策略；`compatibility` 会记录上次可用的地址族，并在重试时尝试固定或翻转。非法值会报配置错误。

`providers` 可以为每个市场指定有序的数据源列表。可用 id：`yahoo`、`eastmoney`、`tencent`、`stooq`、`sina`、`nasdaq`、`binance`、`gate`、`coinlore`。未知市场、未知 provider、重复项、空数组或非数组都不会覆盖默认配置，日志会说明原因。

`identity.localBucket` 只能用于你明确知道 **DSH 部署只有一个用户** 的场景。共享部署不要设置，否则不同用户会进入同一个存储桶。

`security.allowUnfencedLoopback` 是缺少宿主请求围栏时的本机调试例外，默认 `false`。仅在显式设置为 `true` 后允许回环来源（`127.0.0.1` / `::1`）绕过围栏；远端请求仍被拒绝。启动及每次实际放行都会写 error 级 `SECURITY` 日志。正常使用不建议开启。

AI 模型路由优先使用 `AI_CONFIG` 中可用的 `provider` / `model`，然后尝试 DSH 当前默认模型，最后寻找 `llm.listProviders()` 中第一个匹配 `/deepseek/i` 的模型。默认 `maxTokens` 为 2400、`temperature` 为 0.2、超时 120 秒。插件只调用宿主的 `ctx.get('llm').stream({...})`，不保存 API Key；鉴权和计费由 DSH 处理。

## 安全、存储和请求限制

### 请求围栏

插件依赖 DSH 的 `connection.requestRejection(req)` 检查 `/api/trading/*` 请求，与宿主 API 网关使用同一套判断，不另行实现 Origin/Host 检查或 IP 白名单。

如果围栏缺失或调用失败，除 `GET /api/trading/health` 外的路由都返回 **503 `HOST_SECURITY_UNAVAILABLE`**。这是有意设计的默认拒绝行为。`health` 是唯一例外：不读取用户配置、不访问上游、不返回用户数据，只返回 `{plugin, version, api, fence, identity, note}`。

如果使用反向代理，请确保它正确转发 `Host`、`Origin` 和浏览器会话，也不要将 `/api/trading` 暴露给未认证来源。

### 用户身份与本地数据

插件按以下顺序确定身份：

1. 宿主提供的 `@deepseek-ai/dsh-anonymous-user-id`。
2. 操作者显式配置的 `identity.localBucket`（仅单用户部署）。
3. 两者都没有时视为无身份。

没有可信身份仍可读取行情，但自选、偏好写入和按用户计量的路径会返回 **503 `NO_IDENTITY`**。插件不会默认为所有访问者共用同一份用户数据。当前身份来源可以在 `GET /api/trading/status` 或启动日志中查看。

可选的 `@deepseek-ai/dsh-storage-domain` 缺失时，本地存储会回落到 JSON 文件。卸载后存储文件仍保留在 `<DSH_HOME>/trading-mode/`。

### 速率限制与长任务

默认使用滑动 60 秒窗口：每身份 240 次请求/分钟、全局 1200 次/分钟。开销较大的接口有单独额度：

| 接口 | 每身份 / 全局额度 |
| --- | --- |
| `analyze` | 20 / 60 |
| `brief` | 6 / 30 |
| `universeRefresh` | 2 / 4 |

同时运行的 AI 分析每身份最多 2 个、全局最多 4 个。超限返回 `429 RATE_LIMITED` 和 `Retry-After`，被拒请求不会再访问上游或消耗配额。规则见 `API_POLICY` 和 `lib/trading/limits.js`。

全市场目录扫描最多运行 15 分钟。超过预算会停止翻页，返回 `complete: false`、`reason: "budget"`；也可以调用 `DELETE /api/trading/universe` 取消扫描。

## 出问题时先看这里

优先检查 `GET /api/trading/status`，其中包含各数据源的健康状态、AI 原因和配额余量；诊断字段已经脱敏，适合贴到 issue。只想看插件版本、围栏和身份状态，则用 `GET /api/trading/health`。

| 现象 | 排查方向 |
| --- | --- |
| 左侧栏没有 Trading Mode 行 | 刷新页面；确认当前 profile、`list_bundles`、Loader 的 `include:trading-mode`，运行 `npm run inspect:profile`。宿主过旧、没有 `sidebar.panellist` slot 时该插件没有入口可用 |
| 所有 API 返回 `503 HOST_SECURITY_UNAVAILABLE` | 宿主没有提供可用的 `connection.requestRejection`。不要直接对外暴露端口；优先修复宿主围栏 |
| 自选或偏好写入返回 `503 NO_IDENTITY` | 检查匿名用户 ID 服务；确认单用户部署后才考虑 `identity.localBucket` |
| 数据源返回 403 / `UPSTREAM_BLOCKED` | 上游可能屏蔽当前网络。插件会尝试备用源；可检查网络或调整 `providers` 顺序 |
| 返回 `429 RATE_LIMITED` | 触发插件入站配额，按 `Retry-After` 头提示稍后再试 |
| AI 显示 `AI_UNAVAILABLE` | 查看 `/api/trading/status` 中的 `ai.reason`，确认 DSH 已加载 `llm` 服务并有可用模型路由 |
| 图表显示历史数据不完整 | K 线根数不够，JP 尤其常见。少于 200 根时部分指标不能计算，不会用 0 冒充结果 |

历史数据的指标可用性分为 `full`（≥200 根）、`partial`（≥50）、`limited`（≥20）和 `insufficient`（<20）；无法计算的指标会进入 `unavailable`。

公司网络和代理环境里的连接失败，先区分两种情况：

- **证书问题**：如 `SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`。应让启动 DSH 的 Node.js 进程信任企业根证书，例如配置 `NODE_EXTRA_CA_CERTS` 指向 PEM 文件。
- **DNS / socket 问题**：如 `EAI_AGAIN`、`ECONNRESET`、`ETIMEDOUT`、`socket hang up`。可以对比 `networkMode: standard` 与 `compatibility`，通常先保持 `auto` 即可。

不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过证书验证。这会关闭 TLS 证书校验，不是本插件支持的解决方式。

完整的故障排查见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 兼容性

目前实际验证的环境：

| 项目 | 已测试版本 |
| --- | --- |
| 操作系统 | Windows 11 x64（`win32` x64，`Microsoft Windows NT 10.0.26300.0`） |
| Node.js / npm | `24.15.0` / `11.12.1` |
| DSH 桌面宿主 | `0.2.0-rc.2`（Cordis `4.0.4`）、`0.2.1-rc.2`（Cordis `4.0.5`） |
| AI 路由 | `deepseek-official/deepseek-flash` |

两个宿主版本的离线测试结果均为 **13 passed、0 failed、0 skipped**（153 项检查），`npm run test:release` 通过；安装检查为 `6/6 install checks passed`。在 `0.2.1-rc.2` 上，`/api/trading/health` 返回 `api: "ready"`，两个客户端 slot 均为 `active: true`。

`package.json` 声明 `engines.node: ">=20"`，但这不代表所有 Node 20+ 环境都经过测试。Node 20–23、25，macOS、Linux、WSL、Windows ARM64、其他 DSH 版本和各类企业代理/VPN 网络均未验证，不作兼容性保证。详见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

宿主需要 `connection`、`webServer` 和客户端 `ui-slots`。唯一非可选 peer 是 `@deepseek-ai/cordis`（`^4.0.1`）；`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage-domain` 和 `@deepseek-ai/dsh-anonymous-user-id` 都是可选 peer，缺失时对应功能会降级。运行时 `dependencies` 为空；`react`、`react-dom`、`zod` 只用于开发和测试。

## 开发和测试

从源码开发时，先安装依赖：

```bash
npm ci --legacy-peer-deps
```

仓库提交了 `package-lock.json`。这里使用 `--legacy-peer-deps` 是因为 Cordis 和部分 DSH peer 应由宿主提供，不需要 npm 在开发环境另装。`npm install` / `npm ci` **不是插件安装步骤**。

常用命令：

```bash
npm test                 # 离线测试
npm run test:release     # 发布门禁；不能失败，也不能跳过
npm run test:offline     # 等价于 npm test
npm run test:config      # 只跑配置测试；其他 test:* 脚本可单独运行
npm run test:network     # 在线探针，不纳入发布门禁
npm run check            # 语法检查
npm run inspect:profile  # 只读查看 profile 安装情况
npm run verify:install   # 检查当前 profile 的插件副本
npm run smoke:artifact   # 打包审计、检查文件和机器路径
```

离线测试包括 syntax、config、transport、limits、router、api、fence、identity、watchlist、ai、client、release-scripts、repo，共 13 套。退出码为 `0`（PASS）、`1`（FAIL）、`3`（SKIP）。普通 `npm test` 容许因为缺少可选前置条件而跳过，`test:release` 不允许跳过。例如未安装 React 开发依赖时，客户端测试可能 SKIP，发布门禁会失败。

在线探针依赖第三方网站，失败时会记录 DEGRADED，并检查插件能否正确返回有类型的 `TradingError`，不会把外部服务临时不可用当成发布阻断。

打包前可以运行：

```bash
npm pack --dry-run --json
npm run smoke:artifact
```

Release `.tgz` 是 `npm pack` 产物，当前版本包含 74 个文件、纯 JavaScript，无额外构建步骤。打包检查会审计文件白名单、机器本地路径并输出 SHA-256 和体积。源码联调、profile 链接和安装校验见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 文档

- [架构](docs/ARCHITECTURE.md) · [HTTP API](docs/API.md) · [数据源](docs/DATA_SOURCES.md)
- [开发](docs/DEVELOPMENT.md) · [排障](docs/TROUBLESHOOTING.md) · [兼容性](docs/COMPATIBILITY.md)
- [隐私](docs/PRIVACY.md) · [数据合规](docs/DATA_COMPLIANCE.md) · [安全](SECURITY.md)
- [路线图](docs/ROADMAP.md) · [变更记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)
- [发布模板](docs/RELEASE_TEMPLATE.md) · [发布清单](docs/RELEASE_CHECKLIST.md) · [Round-3 审计](docs/AUDIT-ROUND3.md)

### 截图

目前仓库还没有可用的真实产品截图，因此 README 暂时不放图片或占位图。截图收录规则见 [docs/screenshots/README.md](docs/screenshots/README.md)。

## License 与数据使用

项目源码采用 [MIT License](LICENSE)，但 MIT 只覆盖本仓库的源码，不代表上游行情数据、商标或第三方嵌入内容也采用 MIT。

TradingView 内容由浏览器直接通过 `s.tradingview.com` 加载，插件不代理或修改其内容，也不移除其品牌和署名。当前 [数据合规文档](docs/DATA_COMPLIANCE.md) 对九家上游和 TradingView 的条款均标记为 `not verified`，不据此宣称取得数据使用或再分发授权。

本项目面向本地个人研究使用。不绕过上游鉴权、不抓取登录页，也不重新分发行情数据。使用前请自行确认适用的数据源条款。
