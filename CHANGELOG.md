# Changelog

本文件记录 `dsh-trading-mode` 的对外变更。版本号遵循 semver；`0.x` 期间 minor 版本可能含行为变更。

## 0.8.1

面板配色补丁：窗口可以在**黑底白字**与**白底黑字**之间切换，并且**不再透明** ——
原先面板底色取自宿主主题别名 token（`--dsw-alias-bg-overlay` / `-bg-layer-1` / `-label-primary` …），
一旦该别名在当前主题作用域内没有定义，CSS 的 `var(..., fallback)` 属于
*invalid at computed-value time*：**fallback 不生效、属性直接失效**，背景就变成透明，背后的对话穿透上来。
0.8.1 给面板一套**自有的字面 hex 调色板**，并显式提供 `dark` / `light` 两套取值，把宿主别名映射到自己的变量上。

### 新增

- **主题切换（`lib/client.js`）**：面板头部新增「深色 / 浅色」开关（`ThemeToggle`，`role="group"`、
  `aria-pressed`、中英双语），把浮层根节点在 `tm-scheme--dark` / `tm-scheme--light` 之间切换。
  `dark` = 黑底白字（`--tm-bg:#000000` / `--tm-text:#ffffff`），`light` = 白底黑字（`--tm-bg:#ffffff` / `--tm-text:#101014`）。
- **跟随宿主主题偏好**：宿主提供客户端 `theme` 服务时，插件在绑定阶段读取 `getTheme()` 的
  `active.colorScheme` 并订阅 `theme/change`；用户点过一次开关后（`themeSet: true`）**不再被宿主快照覆盖**，
  选择通过 `service.setTheme()` 写回 DSH 自己的主题设置（由宿主持久化）。宿主没有该服务时全部静默降级为
  面板内切换，仅本会话生效，不报错、不影响加载。

### 变更

- **面板不再依赖宿主主题 token 上色**：`.tm-window`、`.tm-status__pop` 及所有卡片 / 输入框 / 弹出层surface
  改用 `var(--tm-*)`；宿主别名（`--dsw-alias-bg-*`、`-label-*`、`-border-l*`、`-brand-primary`、`-state-warn-primary`）
  只在 `.tm-layer` 作用域内被**映射**到自有调色板，便于已有的上百条规则继续沿用别名。
- **浅色下可读的语义色**：涨跌 / MA20·50·200 / 警示 / 错误 / 成交量 / 支撑阻力标签等
  硬编码色改为 `var(--tm-*, <原值>)`，浅色方案给出加深后的对应值（如 `--tm-up` 由 `#35c98a` → `#0f7a4d`）。
- `lib/index.js` 的客户端入口 `apply()` 现在调用 `bindPlatformTheme(ctx)`（与既有 `bindPlatformLocale(ctx)` 同级），
  并在 `_internals` 中导出新增的 `ThemeToggle` / `bindPlatformTheme` / `applyThemeSnapshot` / `persistTheme` /
  `effectiveTheme` / `normalizeTheme` / `THEME_SCHEMES` 供测试使用。

### 修复

- **对话框透明**：面板窗口与其弹出层此前可能因主题别名缺失而整体变透明（表现为「面板像毛玻璃、背后的聊天透出来」）。
  现在背景、边框与文字色都由面板自有调色板给出**不透明**取值，`transparent` 不可能再出现。
- **TradingView iframe 保持白底**：`.tm-frame` 仍为 `#fff`（第三方图表自带配色），并加注释说明这是刻意为之。
- **CI 的在线探针不再给构建画红叉**：`network-probe` 步骤设置 `DSH_TRADING_PROBE_NONBLOCKING=1`，探针照常
  打印每条 `FAIL` / `DEGR` 与 report 文件，但退出码为 `0`；本地直接 `npm run test:network` 仍保留严格退出码。
- **在线探针里 6 条环境相关断言改为降级/容忍**（GitHub runner 首跑 `88/95` 的全部失败项）：provider 主机
  DNS 不可达 → `DEGRADED`；技术面 `bars >= 250` → `>= 200`（港股一年窗口只有 247 根日线）；报价缺
  `previousClose` 时跳过算术对比（Yahoo 部分延迟载荷）；VIX 只要**不是** eastmoney 供给即可（`tencent`
  才要求 `stale`）；`^VIX` 蜡烛从「必须报错」改为「要么 typed capability miss 且不消耗 provider 失败预算，
  要么由新 fallback feed 供给成功」；目录 venue 按族名比较（`NasdaqGS` 视作 NASDAQ 族）。

### 测试

- `tests/offline/client.test.mjs` 新增 3 项检查（25 → **28**）：切换按钮与互斥类、宿主偏好被跟随直到用户显式选择、
  以及**静态 CSS 断言**（两套调色板存在、`.tm-window`/`.tm-status__pop` 不透明且不引用 `--dsw-alias-*`、
  所有仍被使用的宿主别名都已在映射块里定义）。离线总数 150 → **153** 项，13 个套件，0 failed。
- **宿主升级复测（2026-10-18）**：DSH 桌面宿主从 `0.2.0-rc.2` 升到 **`0.2.1-rc.2`**（内含 `@deepseek-ai/cordis@4.0.5`，
  取代 4.0.4），同一份 0.8.1 代码**不改任何配置**即可加载：`/api/trading/health` 回 `api:"ready"` / `fence:"host"` /
  `identity:"host-anonymous-id"`，客户端 `shell.overlay` 与 `conversation.session.header.actions` 两处注册均 `active:true`；
  13 套件 153 项与 `verify:install` 6/6 在新宿主上重跑通过（`docs/COMPATIBILITY.md` 已验证矩阵已补第二行）。

## 0.8.0

面向「别猜、别漏、别蒙」的第三轮改造（修改案3）：宿主围栏从「缺了就开放」改成 **fail closed**，
按用户存储不再回落到共享桶，时效措辞不再使用 `live`，并把发布工程补到可复现（lockfile + 工件冒烟）。
**0.8.0 含两处行为不兼容**：① 缺少宿主 `connection.requestRejection` 时，除 `GET /health` 外所有端点返回
503 `HOST_SECURITY_UNAVAILABLE`（0.7.0 是放行）；② 没有可信身份时 watchlist/settings 的读写返回
503 `NO_IDENTITY`（0.7.0 回落到字面量 `local`，即所有浏览器共用一个桶）。

### 新增

- **fail-closed 围栏 + `/health` 存活探针（`lib/trading/api.js`）**：`fence()` 不再把「没有围栏」当作放行。
  `connection` 缺失、`connection.requestRejection` 缺失、或该函数抛错，都在入站配额与业务代码之前拒绝，
  并记录 `refusing <METHOD> <path>` 与 `fenceFailures` 计数。新增 `GET /api/trading/health`
  （**围栏之前应答**，仅 GET，不触上游、不写存储、不消耗配额），返回
  `{plugin, version, api: ready|ready-on-loopback-only|blocked, fence: host|loopback-exception|unavailable, identity, note}`
  —— 这是唯一用于区分「插件没起来」与「插件起来了但宿主围栏不可用」的端点，且不发布 id 值、路径或计数。
  调试用的 `security.allowUnfencedLoopback`（默认 false）只在显式开启且对端是回环地址时放行，并高亮打日志。
- **可信身份策略（`IDENTITY_POLICY` + `lib/index.js resolveIdentity()`）**：身份来源依次为
  ① 宿主 `@deepseek-ai/dsh-anonymous-user-id` 的匿名 id；② 操作者显式声明的 `identity.localBucket`
  （单用户 profile 用）；③ 都没有 → 无身份。`/status` 与 `/bootstrap` 新增
  `identity: {id, source, persistent, storesPerUserData}`；无身份时 `userId: null`、自选表为空、
  设置返回内置默认值（`storage: "no-identity"`），**绝不读共享桶**。
- **工件冒烟与 profile 只读检测（`scripts/smoke-artifact.mjs`、`scripts/inspect-profile.mjs`）**：
  `npm run smoke:artifact` 打包 → 解包 → 校验文件白名单/机禁项/无绝对路径 → 对每个打包的 `lib/**/*.js`
  跑 `node --check` → 打印 tarball 名、sha256、文件数与解包体积；`npm run inspect:profile` 只读地报告
  每个 DSH profile 是否安装本插件、是 junction 还是拷贝、装的是哪个版本、`lib/index.js` 是否与本检出同源。
- **发布工程**：`package-lock.json`（lockfileVersion 3，7 个 dev 依赖，均带 `integrity`）+ CI 改为阻断式
  `npm ci`，并新增阻断式 `npm run smoke:artifact`。注意 `npm ci` **必须**带 `--legacy-peer-deps`：`@deepseek-ai/cordis`
  等 peer 由 DSH 运行时提供，公共 registry 上没有对应 packument。`docs/RELEASING.md` 记录「本目录不是 git 仓库，
  因此溯源 = 打包 tarball 的 sha256 + 文件清单」，并明确 CI 的首次真实 runner 运行在本机**无法验证**
  （无网络、`zod` tarball 不在本机缓存）—— 这一条保持「未实测」状态，不当作已验证。
- **合规与协作模板**：`docs/DATA_COMPLIANCE.md` 扩写为逐源条款与访问方式明细（含 46 处显式 `not verified`，
  每处带核查日期与检索词、绝不替上游下结论）；新增 `.github/ISSUE_TEMPLATE/*`、`docs/RELEASE_TEMPLATE.md`、
  `docs/screenshots/README.md`（只接受真实截图，没有就不放图）。

### 变更

- **时效分级最年轻档 `live` → `fresh`（`AI_CONFIG.freshMaxAgeMs`）**：`meta.freshness`、`meta.dataQuality.grade`
  与客户端文案统一改名。`fresh` 只表示「上游时间戳较新」，插件在任何档位都不声称实时；系统提示里
  `now` / `today` / `live` 的禁用改为**与 grade 无关**的硬约束。
- **客户端 0.8.0 文案**：`HOST_SECURITY_UNAVAILABLE`、`NO_IDENTITY`、`FORBIDDEN`、`UNAUTHENTICATED`
  都有面向用户的中英说明；自选表卡片在无身份时显示醒目提示；时效提示条区分 `delayed` 与「无法判定数据年龄」。
- **README**：按「先说不支持什么 → 安装 → 首次使用 → 兼容性 → 功能范围 → 故障处理 → 开发/文档索引」重排，
  安装路径改为 DSH 工具调用 `plugin_manager` + `install_bundle`（本包未发布到任何 registry，本目录也不是 git 仓库），
  并写明「Node 24.15.0 + DSH 0.2.0-rc.2 是实测环境，`engines >=20` 只是声明」。

### 修复

- **`summary.rows` / `info().size` 只统计 US+HK**：改为 `totalRows()` 按 `MARKETS` 求和，
  `/status` 与 `/info` 现在覆盖 CN/JP/CRYPTO。
- **`docs/API.md` 的 universe 分页默认值写错**（`size` 缺省 50 → 实际 100），已按 `UNIVERSE_PAGE_SIZE` 更正。
- **测试基线诚实化**：`tests/offline/api.test.mjs` 原先断言「宿主没有围栏时是放行的」，与 0.8.0 的
  fail-closed 设计相反；改为断言两次 503 + 日志含 `refusing` + 配额零消耗。`tests/network/host.test.mjs`
  的 7 处构造改为注入放行围栏与测试身份，不再依赖「无围栏也能用」。
- **旧断言跟上改名与门禁**：`tests/offline/ai.test.mjs` 的 4 处在 0.8.0 改名后仍写 `live`（应
  `fresh`）与旧措辞正则；`tests/offline/identity.test.mjs` 里一个名为 `secret` 的合成 fixture 会命中
  `repo.test.mjs` 的凭据扫描；`README.md` 首屏缺少「需要什么环境」一句，导致发布卫生套件判失败。
  三处都已修正（改名、改措辞、README 首屏补 `engines.node >= 20` 与实测环境）。
- **文档与实现对齐**：`docs/RELEASE_CHECKLIST.md` §1 原先把 `smoke:artifact` 描述成「在临时 profile 里安装
  并加载 tarball」，与实际行为（打包、读 tar 头、解包、扫描、`node --check`，从不安装/加载）不符，已按实现改写，
  并把 `run.mjs` 的套件计数、`docs/COMPATIBILITY.md` 的测试证据更新为 13 套件的真实输出。

### 测试

- 新增 `tests/offline/fence.test.mjs`（8 项：无围栏 7 条路由全 503、无 `requestRejection` 亦 503、
  围栏抛错 → 503 且不计内部失败、403/401 透传与三种放行值、`/health` 围栏前应答且键集合恰好 6 项、
  `/health` 仅 GET 且不消耗配额、回环例外默认关闭、`security.allowUnfencedLoopback` 校验与非布尔拒绝）。
- 新增 `tests/offline/identity.test.mjs`（7 项：无身份时行情可读而 7 条按用户路由全 503 `NO_IDENTITY`、
  被拒的 brief 不消耗额度、`/status`+`/bootstrap` 诚实报告、声明式 `localBucket` 可用、宿主 id 用作存储键
  而 `/health` 只发布来源、身份解析器抛错按无身份处理、6 种畸形身份全部拒绝）。
- 新增 `tests/offline/release-scripts.test.mjs`（**22 项**）：两个脚本存在且可解析、`package.json` `files[]` 含
  `scripts`、`package-lock.json` 可解析且 `lockfileVersion >= 3`、`ci.yml` 含 `npm run test:release` 且不含
  「no lockfile」旧句、`docs/RELEASING.md` 与门禁一致，并含**负控制**（删掉 `lib/client.js` 的副本必须让
  smoke 失败；植入机器路径的副本必须被扫描抓到）与 `inspect-profile` 的**只读证明**（运行前后逐文件
  `path|size|sha256` 深度相等）。`tests/offline/run.mjs` 接线 fence / identity / release-scripts 三个套件，
  离线套件总数 10 → **13**（`13 passed, 0 failed, 0 skipped`；`release gate: PASS`）。

## 0.7.0

面向「一个宿主、多个客户端与多个用户」的上限、可取消性与数据可信度改造。默认数据源链、配置项与
0.6.x 保持兼容；新增的都是**默认开启的保护**（入站配额在 240 次/分钟/用户以上才生效，正常使用感知不到）。

### 新增

- **入站配额与并发闸（`lib/trading/limits.js` + `API_POLICY`）**：`QuotaLimiter` 用滑动窗口限制
  「每用户 240 次/分钟、全局 1 200 次/分钟」，并对昂贵端点单独设桶 —— `analyze` 20/60、
  `brief`（自选简报）6/30、`universeRefresh` 2/4（每用户/全局）。`ConcurrencyGate` 限制同时在飞的
  AI 分析数为 2（全局 4）。超限返回 **HTTP 429 `RATE_LIMITED`** 与 `Retry-After` 头；**被拒的请求不消耗额度**，
  也不会到达 service 层（因此不会白打上游）。`GET /api/trading/status` 新增 `limits` 余量快照。
- **长任务可取消 + 墙钟预算（`UNIVERSE_POLICY`）**：全市场目录扫描新增 15 分钟预算
  （`budgetMs`）与 `DELETE /api/trading/universe` 取消入口；`POST /api/trading/universe` 现在把请求的
  abort 信号透传给扫描，被取消 / 超预算时返回 `complete: false` 并带 `reason`（`cancelled` / `budget`），
  不再出现「点了一次全量刷新就再也停不下来」。
- **`/status` 诊断脱敏**：新增 `sanitizeStatus()` / `redactDiagnostic()`。上游 URL 收敛为 `origin/…`、
  IPv4 变为 `[redacted-ip]`、裸主机名变为 `[redacted-host]`、绝对路径只留 `…/basename`；
  provider id、健康度与 `600519.SH` / `BTC-USD` 这类代码**不会被误伤**。
- **AI 回答的时效分级（`AI_CONFIG` 阈值 + `RECENCY_DIRECTIVE`）**：插件现在按数据年龄给每次分析定级
  （`live` ≤5 分钟 / `delayed` ≤30 分钟 / `stale` ≤24 小时 / `historical` 更旧 / `unknown`），
  把 `dataRecency` 作为输入交给模型，并在系统提示里追加「非实时数据不得表述为 now / today / live」的约束。
  分析返回值新增 `meta.dataQuality = { grade, ageSeconds, stale, staleReason, qualification, historyGrade, historyBars }`，
  客户端在非 live 时显示时效提示条。
- **技术指标的样本量分级（`technicalQuality()`）**：`computeTechnicals()` 返回值与
  `getTechnicals()` 的 `meta` 新增 `quality`（`full` ≥200 根、`partial` ≥50、`limited` ≥20、
  `insufficient` <20，含 `required` / `unavailable` / `note`）。客户端在历史不足时显示醒目横幅并弱化指标网格，
  不再让「只有 30 根 K 线」的 MA200 静默变成空值。
- **发布门禁区分「必需」与「可选」（`tests/offline/harness.mjs`）**：套件可声明 `required: false`；
  跳过会记录原因。`npm run test:release` 在**任何套件跳过时也判失败**，并打印
  `release gate: FAIL — a release must not contain failed or skipped checks`；普通 `npm test` 仍容忍可选套件的 SKIP。
- **围栏缺失不再静默（`ApiRoutes.fence()`）**：宿主若没提供 `connection.requestRejection`，这道同源围栏从设计上就是开放的（插件不自行判断同源）。现在首次触发会打一条
  `request fence is open` 警告，README 与 `docs/COMPATIBILITY.md` 同步写明「同源强度 = 宿主认证强度，不
  多也不少」，并指出此时唯一的边界是入站配额、不要把端口暴露给未认证来源。
- **新文档**：`docs/API.md`（完整 HTTP 契约）、`docs/PRIVACY.md`（本地优先与出站数据）、
  `docs/DATA_COMPLIANCE.md`（逐数据源的合规边界、逐源发布决策、代码内建的节流，以及 TradingView 第三方嵌入的单列说明）。

### 变更

- `package.json`：版本 `0.7.0`；新增 `test:release`、`test:limits`；`devDependencies` 增加 `zod`
  （自选股套件现在真的跑一遍存储域 schema，而不是因解析不到 zod 而 SKIP）。
- 分析方法守卫的语义写清楚了：不支持的方法返回 `BAD_REQUEST` 与 `method not allowed here; use …`，
  代码里**没有**独立的 `METHOD_NOT_ALLOWED` 错误码（`docs/API.md` 同步说明）。
- README 重写为「是什么 → 支持范围矩阵与核心限制 → 前置条件 → 安装/验证/卸载 → 必需配置 → 隐私与数据源 → FAQ」，
  完整 HTTP 契约移入 `docs/API.md`；版本号一律取自 `package.json`。
- README 把三处容易误读的表述写准：**报价与成交量是上游取得并归一化、只有技术指标由插件计算**；
  界面新鲜度状态（`live` / `delayed` / `closed-session` / `stale` / `unknown`）**互斥**，`Updated` 与
  `Last available data` 不会同时出现；数据来源分成**官方 API / 非官方可访问端点 / 第三方嵌入**三类。
  安装章节补上「拿到目录 → `npm install`（仅 devDependencies）→ 安装到 profile」的完整入口。

### 修复

- **目录统计漏算三个市场**：`lib/trading/universe.js` 的 `loadAll()` 用
  `summary.rows = this.loadedCount('US') + this.loadedCount('HK')` 汇总，`info().size` 同样只算两个市场 ——
  A 股 / 日股 / 加密的目录行数被静默丢弃。现在统一走 `totalRows()`（`MARKETS` 求和）。
- **AI 分析的时效分级恒为 `unknown`**：`analyzeStock()` 读取的是不存在的 `input.dataRecency`（正确路径为
  `input.data.dataRecency`），导致 `meta.dataQuality` 永远无法反映真实数据年龄。
- **自选简报把陈旧数据当成实时**：`buildBriefInput()` 用请求组装时刻（`snapshot.asOf`）而非最旧一行的
  时间戳定级，刷新页面就能把 2 天前的报价说成 live；现在按最旧行定级并附 `staleStocks` / `totalStocks`。

### 测试

- 离线十套件：新增 `tests/offline/limits.test.mjs`（10 项，含假时钟验证窗口滑动、被拒不消耗额度、
  user/global 隔离、并发闸释放与按桶隔离）；`api.test.mjs` 扩到 14 项（429 + `Retry-After`、
  专项额度先于通用额度、并发上限、`/status` 脱敏、`redactDiagnostic` 单测、无宿主围栏时「开放但只警告一次且仍受配额约束」）；
  `ai.test.mjs` 扩到 21 项（时效分级、`qualityFor` 措辞、`RECENCY_DIRECTIVE` 不改写原提示、两个已修缺陷的回归）；
  `config.test.mjs` 扩到 10 项（`API_POLICY` / `UNIVERSE_POLICY` 形状、三档时效阈值排序）；
  `repo.test.mjs` 的必需文档清单扩到 16 项（含 `docs/API.md` / `PRIVACY.md` / `DATA_COMPLIANCE.md` / `DELIVERY-REPORT.md`）。
- 实测（2026-10-10，Windows 11 / Node v24.15.0 / DSH 0.2.0-rc.2）：`npm test` →
  `10 passed, 0 failed, 0 skipped`（syntax 2、config 10、transport 8、limits 10、router 9、api 14、
  watchlist 4、ai 21、client 25、repo 9）；`npm run test:release` 输出
  `release gate: PASS — no failures and no skipped checks` 并以 0 退出。

## 0.6.0

面向公开发布的可用性改造：把「只有作者本机能跑」的部分改成**可配置、可复现、有文档**。行为向后兼容，
`providers` 与 `networkMode` 都是可选配置，默认数据源链与 0.5.x 完全一致。

### 新增

- **配置化数据源链**：插件配置支持 `providers: { US: ['yahoo', 'eastmoney', …], HK: […], … }`。
  合法覆盖立即生效；非法值（未知市场 / 未知 provider / 重复项 / 空数组 / 非数组）**不会生效**，保留出厂默认，
  并写入日志 `trading-mode: invalid configuration — <原因> (the shipped default stays in force)`。
  `GET /api/trading/status` 与客户端配置快照新增 `providerChains`（每市场当前链）与 `providerChainProblems`。
- **传输策略可插拔 `networkMode`**：`auto`（默认，通用 HTTP，仅把**真正失败过**的主机升级为兼容模式）、
  `standard`（始终通用 HTTP）、`compatibility`（强制启用 IPv4/IPv6 地址族记忆与翻转）。
  解决「某些网络到某个源站必然 RST、换地址族就正常」的环境差异，同时不再默认对所有主机做地址族翻转。
  `status()` 新增 `transport: { mode, compatibilityHosts, workingFamilies }`。
- **按能力（端点）隔离的供应商健康度**：健康键从 `provider` 变为 `provider::feature`
  （`healthScope(id, feature)`）。K 线失败不再连带禁用同一供应商的搜索 / 报价；`status()` 的每个 provider
  新增 `degraded` 与 `scopes`（逐能力的 calls / failures / 冷却剩余），`healthy` 只在该 provider 的所有
  已记录能力都冷却时才为 false。
- **离线的、可复现的测试入口**：`npm test` 依次运行 `tests/offline/` 下的
  syntax / config / transport / router / api / watchlist / ai / client / repo 九套件，无网络依赖；单命令、可单独运行
  （`npm run test:config` 等）。套件退出码语义：`0` PASS、`1` FAIL、`3` SKIP（缺少可选前置条件，如客户端
  套件找不到 react），SKIP 不会让 `npm test` 失败。
- **发布卫生门禁（`tests/offline/repo.test.mjs`）**：自动检查发布物里没有密钥 / API key / Bearer 令牌、
  没有作者私人绝对路径与个人数据、LICENSE 是完整 MIT、CHANGELOG 含当前版本、`.gitignore` 覆盖机器状态、
  文档齐备、README 首屏回答了「是什么 / 怎么装 / 不支持什么 / 需要什么版本 / 怎么验证」。
- **在线探针可移植化并降级为非阻断**：`npm run test:network`（宿主端到端 + 装机校验）改为按
  `DSH_HOME` / profile 结构自动定位，找不到宿主模块或 react 时报 SKIP；上游不可达时按 DEGRADED 报告，
  不计入失败，因此不会让 CI 随上游抖动红 / 绿翻转。
- **文档与治理**：新增 `docs/ARCHITECTURE.md`、`docs/COMPATIBILITY.md`、`docs/DATA_SOURCES.md`、
  `docs/DEVELOPMENT.md`、`docs/TROUBLESHOOTING.md`、`docs/ROADMAP.md`、`docs/RELEASE_CHECKLIST.md`、
  `CONTRIBUTING.md`、`SECURITY.md` 与 GitHub Actions（离线套件为门禁，在线探针 `continue-on-error`）。
  README 首屏重写：一句话定位、**「它不支持什么」**、最短安装、如何验证、文档索引；
  作者本机的排障内容移入开发 / 排障文档，且不再出现绝对私人路径。

### 变更

- `package.json`：版本 `0.6.0`；新增 `engines.node >= 20`、`scripts`（test / test:* / check / verify:install）
  与 `devDependencies`（`react`、`react-dom`，仅客户端离线套件需要）；`files[]` 纳入 `tests`、
  `CONTRIBUTING.md`、`SECURITY.md`。`cordis` 仍是唯一的**非可选** peer 依赖。
- README 不再把设计文档编号（「策划案 V0.1」）当作版本号；版本一律以 `package.json` 为准。
- 数据源健康度语义变细（见上）：从「一个供应商一个断路器」改为「一个供应商 × 一个能力一个断路器」，
  供应商更容易保持可用，不会更容易熔断。

### 修复

- **自选股（看板）在宿主存储域后端下会丢 A 股 / 日股 / 加密行**：`lib/trading/watchlist.js` 的行 schema 仍写着
  `market: z.enum(['US', 'HK'])`（五市场之前的历史遗留），而宿主以 `invalidRecords: 'backup-and-skip'` 打开域表 ——
  于是同一份代码「文件后端正常、存储域后端悄悄备份并跳过」，属于最难自查的一类数据丢失。现在市场取值从
  `MARKETS` 单一来源派生（导出为 `WATCHLIST_MARKET_VALUES`），schema 与产品能力不可能再各自漂移。
- **`makeWatchlistItem` 可能写入 `market: undefined`**：输入是「带 symbol 的对象但没带 market」时，原实现直接把输入当解析结果，
  行里没有市场字段（存储域 schema 会拒绝它）。现在一律经 `parseSymbol(symbol, hint)` 推导：带市场提示时以提示为准，
  否则由 symbol 决定（`0700.HK` → HK，裸代码 `BTC` 仍是美股，与目录层语义一致）。

### 测试

- 离线九套件全部通过（无网络）；在线探针按上游可用性报告 PASS / DEGRADED，非阻断。
- 实测（2026-10-10）：`npm test` → `9 passed, 0 failed, 0 skipped`（syntax 2/2、config 8/8、transport 8/8、router 9/9、
  api 8/8、watchlist 4/4、ai 14/14、client 25/25、repo 9/9）；`npm run test:network` → 宿主端到端 **95/95 PASS，0 FAIL**，
  上游不可达项记 DEGRADED（数量随上游波动）；`npm run verify:install` → **6/6 PASS**（链接指向工作区、profile 版本 0.6.0、
  AI 层直连宿主 llm、五市场宿主代码、客户端五市场标记、6 个已发布文件逐字节一致）。
- 上游类失败（东财 kline/push2 主机的 `socket hang up`、Yahoo/Stooq 403、日股无历史源）全部按 DEGRADED 记，
  它们断言的是「抛出具类型 `TradingError` 而不是编造或挂起」的降级契约。
- 新增 `tests/offline/watchlist.test.mjs`（4/4 PASS）：断言存储市场列表与 `MARKETS` 不漂移、逐市场建行时币种正确、
  文件后端能存取五个市场并隔离用户，并在 zod 可解析时**真正跑一遍域表 schema**（五市场逐行通过、`MARS` 被拒），
  解析不到则记 SKIP 而不是假装通过。

## 0.5.1

### 修复

- **AI 简报 / 单股分析完全无法生成**（用户报告：trading 模式 AI 生成简报功能有问题）。根因有两个，都在 AI 调用路径上：
  1. **插件硬依赖宿主内部包**：`ai.js` 用 `await import('@deepseek-ai/dsh-llm')` 取 `BlockAssembler` / `createUserMessage`。
     该包是 DSH 自带依赖，只存在于应用包内（`app.asar` 的 `dsh/node_modules/@deepseek-ai/dsh-llm`，0.2.0-rc.2），
     **既没有装进 profile（`pnpm-workspace.yaml` 里 `autoInstallPeers: false`，插件是 `link:` 进来的、没有自己的 `node_modules`），
     也无法从一个应用包之外的插件里解析** —— 实测 `node -e "import('@deepseek-ai/dsh-llm')"` 报
     `ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/dsh-llm'`。于是每次调用都在真正发请求之前就抛
     `AI_UNAVAILABLE: @deepseek-ai/dsh-llm is not resolvable from this plugin (…)`。
     现在**不再 import 任何宿主包**：`ChunkAssembler` 按公开的 `StreamChunk` 契约（`block-start` / `text-delta` /
     `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）在插件内自己拼装，只依赖
     `ctx.get('llm').stream()` 这一条公开接口，因此宿主升级也不会再把插件打断。
  2. **服务在 apply 时被一次性捕获**：`index.js` 把 `llm` / `agentDefaultModel` 当作**值**传入，而插件是在
     `ready` 里同步构造 `TradingAi` 的 —— 服务晚于此时注册就会永久 `available: false`。现在改为传**取值函数**
     （`llm: () => ctx.get('llm')`），每次调用重新解析。
- **`watchlistBrief` 的 `dataAsOf` 读错字段**：写成 `input.data.asOf`（`input` 来自 `buildBriefInput`，没有 `data` 字段），
  于是简报在模型返回成功后仍然抛 `TypeError: Cannot read properties of undefined (reading 'asOf')`，
  `/api/trading/watchlist/analyze` 永远 500。已改为 `input.asOf`。
- **请求消息不符合宿主契约**：`GenerateOptions.messages` 的元素类型是 `Message | RequestUserInput`，其中
  `RequestUserInput` 明确声明 `id?: never`、`source?: never`。原实现给用户消息加了
  `source: {kind:'plugin', plugin:'dsh-trading-mode'}`，现改为 `{role:'user', content:[{type:'text', text}]}`。
- **路由发现没有 await**：宿主 `llm.listModels(provider)` 是 **async**，原实现按同步取值 → 拿不到模型列表。
  `resolveRoute()` 现为 async（`resolveRouteSync()` 保留给 `status()`），逐 provider `await listModels()` 并优先选
  `/deepseek/i` 的模型；首选仍是 DSH 的当前默认模型（本机为 `deepseek-official` / `deepseek-flash`）。
- **错误提示可诊断**：`status()` 新增 `reason`（为什么不可用：没拿到 llm 服务 / 服务未注册 / 无 stream() / 无模型路由），
  宿主日志的 ready 行也会打印该原因；`askJson` 在缺 llm 时**只报一次**、不再做三次无意义重试。

### 测试

- 新增 `.trading-research/test-client.mjs` 检查 `0.5.1 AI: an unavailable DeepSeek explains itself in both panels`
  （客户端 **25/25 PASS**）：把 `BriefCard` / `AiAnalysisSection` 从 `_internals` 导出，SSR 断言 AI 不可用时
  两个面板都渲染 `Reason: ` 与具体原因、可用时不渲染，并断言该标签有中文译文。
- 新增 `.trading-research/test-ai.mjs` → **14/14 PASS**：用「只实现公开契约的假 llm」驱动 `TradingAi`，
  覆盖 chunk 拼装（含推理块不得混入答案、`block-end` 覆盖文本、`usage`、缺 `finish` 时按文本推断 `stop`）、
  `analyzeStock` / `watchlistBrief`（中英本地化指令）、**延时注册的 llm 服务（0.5.0 回归）**、缺服务时单次失败、
  async 模型发现、可重试失败第二次成功、`max-tokens` / `aborted` / `error` 的错误映射、空流、`status()`，
  以及**默认模型选择的容错读取**（`{provider, model}` 与 `{providerId, modelId}` 都认；选择不完整或
  `currentSelection()` 抛异常时退回异步发现，而不是让 `status()` 崩掉）。
  这一套补上了 0.5.0 的漏测：`test-host.mjs` 一直只用 stub ai 对象，从未真正调用 `askJson`。

## 0.5.0

### 新增

- **五市场覆盖**：在美股、港股之外新增 **A 股（沪 / 深 / 北交所）、日股（东证）与加密货币**，行情、K 线、市场指数、清单浏览、搜索、AI 分析全部按市场路由。
  - 交易时段与计价：`MARKETS = ['US','HK','CN','JP','CRYPTO']`，各自货币 `USD/HKD/CNY/JPY/USDT`，加密为 7×24 现货。
  - 清单来源：A 股用新浪（沪市主板 2319 只等），日股走东财清单，加密用 CoinLore 市值榜（Top 1078，`TOP` 板块）。
  - 搜索：A 股支持 `600519` / `600519.SH` / `浦发银行`，日股支持 `7203` / `7203.T` / `Toyota` / `トヨタ` / `丰田`，加密支持 `BTC` / `bitcoin` / `比特币`（CoinLore 提供中文名）。
    **东财 suggest 接口只认东京代码与中文名，对日文假名（`トヨタ` / `ソニー`）返回 0 行**，因此本地目录为东证权重股补了
    假名 / 罗马字 / 中文别名（`トヨタ` / `トヨタ自動車` / `toyota` / `丰田` → `7203.T`，另含索尼、基恩士、软银、任天堂等 30 余只），
    A 股同理补了 `茅台` → `600519.SH`、`宁德时代` → `300750.SZ` 等中文名种子行。
- **市场感知的目录元数据**：`directory.lookup(symbol, market)` 新增市场提示，A 股 / 日股 / 加密行不再被标记成 `NASDAQ` + `USD`；`enrich()` 会纠正上游漏发的美元默认值。`BTC` 这类裸代码必须带市场提示，否则仍按美股解读（已在测试中固定该语义）。
- **加密档案改由上游提供**：`coinlore` 现在参与 `profile` 链（`candidates('profile','CRYPTO') === ['coinlore']`），此前该分支无条件返回目录合成档案（已过时的短路）。
- **加密 K 线按日历日 sizing**：新增 `CRYPTO_RANGE_DAYS` 与按市场区分的 `BARS_PER_DAY`（加密 1 天 = 24 根小时线，而非 7 根）；`candleLimit(range, interval, market)` / `minBars(range, interval, market)` 接受 market。实测 `1mo/1h` = 730 根（原 164）、`6mo/1d` = 190 根（原 142），股票口径不变。
- **数据来源链接按实测收口**：A 股 `tradingview / yahoo / eastmoney / sina / tencent`；北交所为 `tradingview / eastmoney(/bj/) / sina / tencent`（北交所无 Yahoo 页）；日股 `tradingview / yahoo / finance.yahoo.co.jp`（东财无东京页，已删除）；加密 `tradingview / yahoo / binance / gate`。
- **K 线不完整可见化**：路由返回 `degraded` 时图表图例显示「历史数据不完整 / partial history」徽标（带说明 tooltip），不再静默显示 1 根 K 线。

### 修复

- `PROVIDER_CONFIG.CRYPTO.chain` 缺少 `coinlore`，导致加密搜索命中 `NO_PROVIDER no provider can serve search for CRYPTO`；现为 `binance → gate → coinlore`（`supports()` 仍按能力过滤，coinlore 不会被问行情）。
- `CoinLore.boards()` 的板块 id 与共享配置不一致（`CRYPTO-ALL` vs `TOP`），现统一为配置驱动的 `TOP`。
- `directory` 对 A 股 / 日股 / 加密硬编码 `HKEX : NASDAQ` 与 `HKD : USD`，现改用 `exchangeOf(market, board)` / `currencyOf(market)`。

### 测试

- `test-host.mjs` → **95/95 PASS**（其中 8 项依赖上游的检查在源站不可达时按 `DEGR` 记：断言的是「抛出具类型 `TradingError` 而不是编造或挂起」的降级契约，不计失败）。
  修正过时断言：`sina.listingMarkets` → `['HK','CN']`、指数 8 → 15 并断言市场分布 `{US:5,HK:3,CN:6,JP:1}`、
  `router.candidates()` 返回对象需按 `.id` 比较（原写法 `Array.includes('coinlore')` 恒为 false）；新增四组 0.5.0 检查：
  加密一等公民（链 / 板块 / market-aware 区间）、目录逐市场 venue 与货币、**日股假名 / 罗马字与 A 股中文名本地可搜**
  （`トヨタ` → `7203.T`，且不得命中外市场搜索）、加密档案由上游撰写。
- 上游抖动不再翻红：`upstreamGap()` 除类型化错误码外还识别路由器折叠出的复合文案
  （`every provider in the chain refused` / `not found on any provider` / `responded 40[13]` / `socket hang up`），
  「加宽搜索」与东财 DNS 两项检查在**东财断路器冷却**（该源的 `clist`/`kline` 被 RST 会连带冷却搜索）时记 `DEGR`。
- `test-client.mjs` → **24/24 PASS**：新增五市场链接与格式化检查、加密/A 股/日股链接集合、清单浏览器五市场 chip、K 线 `degraded` 徽标与其中文翻译。
- `verify-install.mjs` → **5/5 PASS**：确认 desktop profile 的 Junction 指向工作区、版本 0.5.0、按 profile 路径加载宿主端五市场代码、客户端 bundle 含 0.5.0 标记且逐文件哈希一致。
- `probe-five-markets.mjs` → 最新 **44 passed / 0 failed / 7 degraded**，同样按上游可用性区分：`DEGR` = 日经指数条（东财单源）、日股东证 1 根 K 线（已文档化降级）、A/日/美股档案（yahoo 403 + 东财 RST）、东财清单与中文名搜索（断路器冷却）。
- 探针清单：`probe-market-metadata.mjs`（25/25）、`probe-crypto-providers.mjs`、`probe-source-links.mjs` / `probe-link-candidates.mjs`、
  `probe-jp-candles-ea.mjs` / `probe-jp-profile-gaps.mjs` / `probe-jp-fallbacks.mjs` / `probe-jp-index-sources.mjs` / `probe-nikkei-truth.mjs`、
  `probe-jp-search-coverage.mjs`（东财 suggest 对 `7203`/`丰田`/`SONY` 有答案、对 `トヨタ`/`ソニー`/`7203.T` 返回 0 行的实测记录）、
  `probe-search-sqqq.mjs`（搜索链路逐层诊断）。

### 已知限制

- **日股东证 K 线无可用历史源**：腾讯的东京接口任何区间只返回 1 根，东财 K 线主机（`push2his`）当前对本网络重置连接，stooq 403，Yahoo 403，日经中文页无结构化数据。图表因此会显示「历史数据不完整」徽标，报价与档案正常。
- **日股东证指数 `^N225`** 只有东财一个源；东财报价接口不可达时该指数条为空（其余四个市场的指数条正常）。
- **A 股 / 日股 / 美股的 `profile` 依赖东财**（新浪、腾讯不提供公司档案），东财不可达时该面板报数据不可用。
- 东财 `clist`（清单）与 `kline`（K 线）接口会周期性对该网络 RST，属上游限流；行情 `stock/get` 通常仍可用。
- **断路器按数据源而非按接口**：东财被 RST 到阈值后整体冷却约 60 秒，冷却期内它的行情 / 搜索 / 档案一并被跳过（这是设计如此：
  该源当时确实不可用），因此 `search SQQQ`、中文名搜索等依赖 suggest 的检查在上游抖动时会显示 `DEGR`，冷却后自动恢复。
- **日文假名搜索依赖本地种子**：东财 suggest 对 `トヨタ` 返回 0 行（代码 `7203`、中文名 `丰田` 正常），
  目录外的中小型日股只能用代码或中文名检索。

## 0.4.1

### 修复

- **「抓取失败」的根因有两个，均已修复。**
  1. **地址族不稳定**：本机 `push2.eastmoney.com` 的 IPv4 / IPv6 两条路径会**轮流**不可用 ——
     坏的那条 TCP 连接本身能建立，随后被 RST，因此 `fetch()`（undici）不会换地址，只报
     `TypeError: fetch failed (UND_ERR_SOCKET)` / `socket hang up`。传输层不再使用全局 `fetch`，
     改为 `node:http(s)` + 共享 keep-alive agent，并记住**上一次真正返回响应的地址族**（`workingFamily`）；
     每次重试钉死并翻转地址族（attempt≥1 交替 IPv4/IPv6），两向都能覆盖。插件不会去改宿主进程的
     `dns.setDefaultResultOrder()`。
  2. **东财批量端点被上游间歇性阻断**：`/api/qt/clist/get`（清单）与 `/api/qt/stock/kline/get`（K 线）
     会在一段时间内对本机**所有**客户端（fetch / curl / 各镜像域名）返回 RST，而
     `/api/qt/stock/get`（报价）、`searchapi`（搜索）仍然正常 —— 这正是「报价正常、抓取失败」的原因。
- 新增两个**兜底数据源**（原 provider 失败时自动接管，前端无需干预）：
  - `lib/trading/providers/nasdaq.js`：Nasdaq 官方 screener 一次取回约 6600–7000 只美股（含 NYSE/AMEX），
    作为美股清单的兜底（东财 clist 被阻断时接管浏览面板）。
  - `lib/trading/providers/sina.js`：新浪财经，承担两件事 —— 港股清单（每页 60 条，中文名）与
    **美股日线兜底**（`US_MinKService.getDailyK`，全量历史，按区间切尾），另可提供
    `^IXIC` / `^NDX` / `^DJI` 三个指数的日线（`.IXIC` / `.NDX` / `.DJI`）。
- **K 线最小根数校验**：路由新增 `validate` / `sizeOf` 语义 —— provider 返回的蜡烛数低于
  `minBars(range, interval)`（如 6mo 日线要求 ≥17 根）时**视为数据不足并继续尝试下一个源**，
  但**不计入 provider 健康失败**（校验不符不是传输故障；否则腾讯会因只回 2 根而被冷却 60 秒，
  连它擅长的港股 K 线与全部报价一起失效）。全部源都不足时返回最大的一份并标记 `degraded: true`。
  该修复同时解决了「美股 6 个月图只剩 2 根」（此前腾讯的美国 K 线接口 count 参数失效，只回首末两根，
  却被当作成功）。

### 变更

- `MARKET_DATA_CONFIG.US.chain` → `yahoo → eastmoney → tencent → sina → stooq`（港股链路不变）。
- 新增 `UNIVERSE_PROVIDERS`（US：eastmoney → nasdaq；HK：eastmoney → sina）与 `minBars()`。
- `StockUniverse` 支持**按市场多源链**：记住上次成功的源、按源切换板块、请求的板块在兜底源上不存在时
  回落该源默认板块并返回 `boardFallback: true`；`status()` 暴露每市场的数据源链。
- 清单浏览器在全部源都失败时不再只显示原始报错，改为提示「可直接用上方搜索框（覆盖全市场），
  或稍后点『载入整个板块』重试」；翻页在兜底源（无总页数）下用「整页=还有更多」判断。

### 测试

- `test-host.mjs` 新增 `transport fallbacks` 段 6 项：兜底源注册与能力边界、`minBars` 阈值、
  「2 根被跳过且不触发断路器」「全不足时返回最大 partial 并 `degraded`」、清单多源回落
  （stub 东财被拒 → Nasdaq 接管、板块回落、无源时 `NO_PROVIDER`）、真实 nasdaq / sina 清单、
  真实 `GET /universe` 的 provider 与板块一致性。
- `test-client.mjs` 的清单浏览器断言覆盖新的兜底提示与无总页数翻页。

### 已知限制

- 标普 500 `^GSPC` 与恐慌指数 `^VIX` 仍**没有可用的日线源**（东财无这两个指数，新浪只有
  `.IXIC` / `.NDX` / `.DJI`）：它们的报价正常，但点击查看 K 线会明确显示数据不可用，而不是猜测。
- 兜底源的清单均为**英文名**（Nasdaq 官方表无中文名），东财恢复后中文名会回来。

## 0.4.0

### 新增

- **全量美股 / 港股清单浏览器**：`Add Stock` 面板新增 `浏览全部美股与港股` 卡片，覆盖
  **NASDAQ（6065）/ NYSE / AMEX** 与**港交所主板（2619）/ GEM（315）/ 基金信托（490）**共约 1.7 万只证券。
  - 新增 `lib/trading/universe.js`（`StockUniverse`）：按页抓取并累积索引、本地模糊搜索、磁盘快照、
    后台整板块遍历（每 20 页落盘一次）、同一时刻只允许一个遍历。
  - 新增 **`GET /api/trading/universe`**（`market` / `board` / `page` / `size` / `q`）；
    `q` 命中本地索引，缺省则返回一页上游清单。新增 **`POST /api/trading/universe`** 启动后台整板块遍历。
  - 新增 `lib/trading/config.js` 的 `UNIVERSE_BOARDS` / `UNIVERSE_PAGE_SIZE(100)` / `universeBoard()`。
- **搜索范围放宽**（这是「能添加的股票太少」的主因）：东方财富 suggest 接口的 `count` 由 20 提到 **100**，
  并把证券类型过滤从「仅普通股」放宽到 **普通股 + 存托凭证 + 封闭式基金 + ETF/ETN**
  （`TypeUS ∈ {1,3,4,5}`）。此前 `SPY`/`QQQ`/`SQQQ`/`ICLN`/`ARKK` 等 ETF 完全搜不到。
- **类别股与港股 5 位代码**：`BRK.B` / `BF.B` 这类类别股现在可以搜索、添加、取行情
  （上游只认 `BRK_B` 写法，适配器会自动重试下划线拼写；`^` 与 `.` 的显示形态保持规范）；
  港股 **5 位人民币柜台**（如 `80700` 腾讯控股-R）不再被截断成 4 位而与 `0700.HK` 冲突。

### 修复

- 中文查询不再被 A 股淹没：`银行` 现在能返回港股（`0011.HK` / `0023.HK` / `0939.HK` / `0998.HK`）。
- 港股代码解析补零规则统一（`00001` → `0001.HK`，`08003` → `8003.HK`，`80700` → `80700.HK`）。

### 测试

- `test-host.mjs` 74 → **81/81 PASS**（新增 7 项：板块配置、代码方言、`GET /universe` 真实翻页、
  本地索引搜索、放宽后的搜索覆盖、`POST /universe` 后台遍历与失败上报、快照重启存活）。
- `test-client.mjs` 21 → **22/22 PASS**（新增 1 项：清单浏览器渲染、本地化与「已添加」态）。

## 0.3.0

### 新增

- **市场指数（Market Overview）**：首页新增指数卡片，覆盖 8 个常用指数 ——
  纳斯达克综合 `^IXIC`、纳斯达克 100 `^NDX`、标普 500 `^GSPC`、道琼斯工业 `^DJI`、恐慌指数 `^VIX`（VIX）、
  恒生指数 `^HSI`、国企指数 `^HSCEI`、恒生科技指数 `^HSTECH`。
  - 新增 `lib/trading/indices.js`（指数目录 + 解析 + 搜索 + Provider 能力矩阵）；
  - 新增 **`GET /api/trading/indices`**（可用 `?symbols=^VIX,^IXIC` 过滤）；
  - 指数可像个股一样打开详情页（行情 / 个人资料 / K 线 / 技术指标 / AI 分析），`GET /search?q=` 也能搜到
    （`vix` / `恐慌指数` / `纳指` / `恒生` / `^SPX` 等写法均可解析，裸 `DOW` 仍解析为道琼斯公司而非指数）；
  - 指数点位不是可交易价格：卡片与个人资料页均标注 `Index levels, not tradable prices`。
- **数据来源页面跳转**：详情页与指数卡片新增来源链接（**新标签打开，`rel="noopener noreferrer"`**）——
  TradingView 图表、Yahoo Finance、东方财富（仅个股）、腾讯财经；宿主侧只提供链接，不抓取、不代理任何第三方页面。
- **Provider 能力过滤**（`MarketDataProvider.supportsSymbol()`）：东方财富没有 VIX / 恒生科技指数、腾讯没有美股指数 K 线，
  这些组合直接从候选 Provider 中剔除，避免把「源本身没有这个标的」记成 Provider 故障并触发 60s 冷却。

### 修复

- **东方财富报价缩放错误（严重）**：此前请求带 `fltt=2`（服务端已缩放），代码又按 `10^f59` 再除一次，导致
  **所有指数点位被缩小 100 倍**（纳斯达克显示 273.83 而非 27385）、并且**所有标的的涨跌幅被缩小 100 倍**
  （`+0.72%` 显示成 `0.0072%`）；个股价格只是碰巧未受影响。现已改用原始请求 + 无条件按 `10^f59` 缩放。
  新增回归断言：`price ≈ previousClose + change` 且 `changePct ≈ change / previousClose × 100`。
- `lookupIndex` 补上去 caret 回退：`^SPX` 现在正确解析为标普 500 `^GSPC`。
- `searchIndices` 修正排序：精确别名优先于模糊前缀（`纳斯达克100` → `^NDX`，不再被 `^IXIC` 抢走）。

### 测试

- `test-host.mjs` 70 → **74/74 PASS**（新增 4 项：指数目录与 Provider 能力、`GET /indices`、指数端到端
  quote/profile/search/candles、报价算术一致性回归）。
- `test-client.mjs` 19 → **21/21 PASS**（新增 2 项：Market Overview 渲染、来源链接集合与 `target="_blank"`）。

## 0.2.2

### 新增

- **中英双语界面**（`EN / 中文` 切换，面板右上角）：
  - 默认语言跟随 DSH 界面语言（`ctx.get('locale')` → 浏览器语言 → 英文），中文环境开箱即用；
  - 手动选择持久化到宿主 `<DSH home>/trading-mode/settings.json`（按 DSH User ID 隔离，不写 localStorage），
    新开面板、重启 DSH 后仍然生效；
  - 优先级：**手动选择 > 宿主存储值 > DSH/浏览器语言 > 英文**；非法语言返回 `BAD_REQUEST`。
- **新增 `GET|PATCH /api/trading/settings`**：读取/写入语言偏好；`bootstrap` 与 `/api/trading/status` 也返回 `settings`，
  且 `status.config` 暴露 `languages` / `defaultLang`。
- **AI 输出跟随界面语言**：`POST /analyze/:symbol` 与 `POST /watchlist/analyze` 接受 `{ lang }`（缺省用已存偏好）。
  System Prompt 只在末尾追加本地化指令，**策划案 §34/§40 的 prompt 原文不变**；JSON 键名、代码、数字与单位不翻译。
- **新增 `lib/trading/settings.js`**（`UserSettingsStore`）：原子写（临时文件 + rename）、损坏文件降级为只读而非崩溃。
- 客户端新增 `LangToggle` 组件、`ZH` 字典（以英文源串为 key，约 110 条，缺条目回落英文原文）与
  `makeT/translate/normalizeLang/effectiveLang/applyServerLang/persistLang` 工具函数；
  `technicalCells(tech, t)` 支持注入翻译器（§31 指标与趋势排列词表全部本地化）。

### 修复

- 客户端修正两处响应解包：`/analyze/:symbol` 返回 `{symbol, analysis, meta}`、`/watchlist/analyze` 返回 `{brief, meta}`，
  此前会落到「未返回摘要」兜底（并可能抛 `TypeError`）。

### 测试

- `test-host.mjs` 63 → **70/70 PASS**（新增 7 项：语言码归一化、默认值、`PATCH /settings` 落盘与重启恢复、
  bootstrap/status 暴露偏好、非法语言拒绝、prompt 本地化只追加不改写、语言透传到 AI 层）。
- `test-client.mjs` 14 → **19/19 PASS**（新增 5 项：字典完整性与无裸露 key、`makeT` 插值/回落、
  §31 网格随语言变化且数值不变、平台语言被采用直到用户手动选择、切换控件与优先级）。

## 0.2.1

按《DSH Trading Mode V0.1 产品与技术策划案》全量重写后的**首个可安装版本**。

### 新增（宿主半侧）

- **Market Data Service / Provider 抽象**（§4、§14、§15、§16）：`yahoo`、`eastmoney`、`tencent`、`stooq`
  四个 Provider 统一 `searchStocks / getQuote / getCandles / getCompanyProfile` 四个方法；
  `MarketDataRouter` 按 market × 能力 × 区间 × 健康度选源，连续失败进冷却并自动降级，单个 Provider 失效不会影响整体（§44）。
- **统一数据格式**（§17–§20）：`StockSymbol` / `MarketQuote` / `Candle`，行情一律带
  `source` / `timestamp` / `delaySeconds` / `stale` / `freshness`。
- **服务端指标引擎**（§29、§31）：MA5/10/20/50/60/200、EMA12/26、RSI14、MACD+Signal+Histogram、ATR14、
  20 日均量、Volume Ratio、52 周高低，并附趋势排列与支撑/压力位；指标由系统计算，DeepSeek 不参与（§4）。
- **DeepSeek 分析**（§34–§40）：单股分析与 Watchlist Brief 使用策划案给定的 System Prompt 原文，
  输出强制结构化 JSON 并做归一化/修补；输入**只投喂系统归一化后的数据**（§16），模型无从编造价格、成交量、指标或新闻。
- **Watchlist**（§10–§13）：绑定 DSH User ID，字段 `id/user_id/symbol/market/position/is_favorite/created_at/updated_at`；
  公共行情与私人关注列表分离，同一标的只向上游取一次。
- **行情缓存**（§41–§43）：`quote:/candles:/profile:/technical:/search:` 分级 TTL（开盘短、休市长、上限兜底），
  失败链为 重试 → 回退 Provider → 过期缓存（`stale=true`）→ `Data unavailable`。
- **HTTP API**（§45–§49）：注册单一前缀路由 `/api/trading`，承载策划案给出的 search / quote / candles /
  watchlist CRUD + order + analyze / analyze/:symbol，并复用宿主同源会话鉴权。
- **`/api/trading/status`**：Provider 健康度、缓存统计、数据源链路与 AI 状态的只读快照（§3.1 数据源状态）。

### 新增（客户端半侧）

- 会话标题栏 **Trading Mode** 按钮 + `shell.overlay` 全帧浮层（Home / Detail 两个视图）。
- Home：Search Stocks、My Watchlist（价格 / 涨跌% / 数据时间戳 / 收藏 / 排序 / 删除）、Add Stock、AI Watchlist Brief。
- Detail：区间 `1D 5D 1M 3M 6M 1Y 5Y`、自绘 SVG K 线（含 MA20/50/200 与成交量）、
  Market Data、Technical、AI Analysis（Trend / Momentum / Volume / Support / Resistance / Risk / Key Observations）、Ask DeepSeek。
- **保留原功能**：一键切换内嵌 TradingView 图表（`s.tradingview.com/widgetembed`）。
- 措辞合规（§21、§26、§53）：只显示 `Updated …` / `Data may be delayed` / `Last available data`；
  不出现 Live / Real-time / Tick-level / Portfolio / Holdings。

### 变更 / 修复

- 安装契约：不再声明会导致**版本门禁拒装**的客户端运行时 peer（`^0.1.1-rc.2` 永远不满足 0.2.0）；
  宿主侧可选依赖改为 optional peer + 动态 `import()` + 明确降级。
- 客户端 slot 注册改为运行时实证形式 `ctx.slots.inject(key, () => ctx.slots.register(options, Component))`。
- 全局命名收敛：keyframes 更名 `dsh-trading-mode-pulse`，浮层 `position: fixed`，
  CSS 全部限定在 `.tm-` 前缀内，避免与其他插件冲突。
- 移除死代码根目录 `client.js`（真正的客户端入口是 `exports["./client"]` = `lib/client.js`）。

### 已知限制

见 [`docs/DELIVERY-REPORT.md`](docs/DELIVERY-REPORT.md) 的 Known Limitations：
本机网络下 Yahoo / Stooq 403（实际由东方财富 → 腾讯出数）、东财美股 PE 恒为 0 且无公司简介、
腾讯无分钟级端点、DSH 无 Redis（缓存为进程内 LRU + 可选 JSON 持久化）、
`delaySeconds` 保持 `null` 不谎称实时。
