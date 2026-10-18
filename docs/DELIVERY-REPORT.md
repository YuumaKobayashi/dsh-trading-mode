# DSH Trading Mode V0.1 — 交付报告（§79）

> 按策划案 §79 要求的 12 节输出。验收口径见 §67–§74，执行指令见 §77，完成定义见 §80。
> 测试证据：`.trading-research/test-host.mjs`（宿主 **91/91 PASS**）、`.trading-research/test-client.mjs`（客户端 **22/22 PASS**）、
> `.trading-research/test-host-report.json`（含每个 provider 的调用/失败计数与缓存统计）。当前版本 **0.4.1**。
>
> **0.5.0（2026-10-07）**：新增 A 股 / 日股 / 加密货币三个市场，指数扩到 15 个。测试更新为
> 宿主 **94/94 PASS**（7 项上游不可达时按 `DEGR` 记）、客户端 **24/24 PASS**。完整增量见文末
> 「0.5.0 增量交付：五天市场」。
>
> **0.5.1（2026-10-10）**：修复 **AI 简报 / 单股分析完全无法生成**（用户报告）。测试更新为
> 宿主 **95/95 PASS + 8 DEGR**、客户端 **25/25 PASS**、AI 层 **14/14 PASS**、装机校验 **6/6 PASS**。
> 完整增量见文末「0.5.1 增量交付：AI 简报接通 DSH 内部 llm 服务」。

---

## Changed Files

| 文件 | 改动 |
| --- | --- |
| `dsh-trading-mode/package.json` | v0.1.0 → **v0.4.1**；描述/关键词重写为行情研究助手（含 market-index/vix/stock-universe/listing-directory）；`files` 增加 `docs`；`peerDependencies` 增加 `@deepseek-ai/dsh-anonymous-user-id` / `dsh-llm` / `dsh-storage-domain`（均 optional）；`dsh.bundle.patch` 与 `dsh.client`（`platform:'web'`）不变 |
| `dsh-trading-mode/lib/index.js` | 宿主半侧整体重写：不再注册 Binance fetch provider / `market_data` tool；改为装配 `MarketDataService` + `WatchlistStore` + `UserSettingsStore` + `StockUniverse` + `TradingAi` + `ApiRoutes`，`inject:['connection','webServer']`，初始化失败返回 503 `INIT_FAILED`（不允许静默失败） |
| `dsh-trading-mode/lib/client.js` | 浏览器半侧整体重写（约 1500 行）：Home/Detail/Chart/AI/Brief/Watchlist + **市场指数卡片** + **数据来源跳转** + **全量清单浏览器** + **中英双语**（`LangToggle` + `ZH` 字典）+ 保留 TradingView 内嵌图表；样式、槽位契约与旧版一致 |
| `dsh-trading-mode/README.md` | 更新说明（架构、安装、API、指数、来源链接、全量清单、界面语言、缓存、限制、共存约定） |
| `dsh-trading-mode/lib/trading/config.js` | 唯一配置源增强：`providerConfig.intervals`、东财 `ulistPath/historyBase/searchUrl/clistPath/clistToken`、`RECOMMENDED_STARTERS`（§24 推荐池）、`candleLimit(range,interval)`、`SUPPORTED_LANGS`/`DEFAULT_LANG`/`normalizeLang`、**`UNIVERSE_BOARDS`/`UNIVERSE_PAGE_SIZE`/`universeBoard()`** |
| `dsh-trading-mode/lib/trading/schema.js` | `MarketDataProvider` 增加 `intervals` 与 `supportsInterval(interval)`、**`supportsSymbol(symbol, feature)`**（供路由做能力过滤） |
| `dsh-trading-mode/lib/trading/cache.js` | 增加 `backendName`（`memory` / `file:<path>`），供 `/status` 自述缓存后端 |
| `dsh-trading-mode/lib/trading/symbols.js` | 支持**指数符号**（`^IXIC`…）与中文别名的 `parseSymbol`，`providerKey` 增指数分支；**`usDisplayCode`/`usProviderCode`/`hkTickerFromCode`**（类别股 `BRK.B`↔`BRK_B`、港股 5 位柜台 `80700.HK`） |
| `dsh-trading-mode/lib/trading/router.js` | `candidates()`/`run()` 增 `symbol` 维度，剔除不支持该标的的 Provider |
| `dsh-trading-mode/lib/trading/service.js` | 指数编排：`listIndices()`、指数 profile（来自目录而非伪造上游）、搜索并入指数结果与排序修正；**清单编排：`universePage()`/`universeRefresh()`/`universeStatus()`，本地索引并入 `/search`** |
| `dsh-trading-mode/lib/trading/api.js` | 新增 `GET /indices`（0.3.0）、`GET|POST /universe`（0.4.0）与 `GET|PATCH /settings`（0.2.2）；`analyze`/`watchlist/analyze` 透传 `lang` |
| `dsh-trading-mode/lib/trading/ai.js` | `languageDirective(lang)`（只追加本地化指令，§34/§40 prompt 原文不动）、`buildUserMessage` 加固、`loadLlm` 形状校验 |
| `dsh-trading-mode/lib/trading/providers/eastmoney.js` | **修复 `fltt=2` 双重缩放**（指数点位与涨跌幅曾缩小 100 倍）；指数 secid 解析；`supportsSymbol`；**`listSecurities()` 全量清单翻页；`searchStocks` 放宽到 ETF/CEF 且 `count=100`、类别股下划线重试** |
| `dsh-trading-mode/lib/trading/providers/tencent.js` | `supportsSymbol`（美股指数 K 线不列入候选）；指数 quote（含 VIX） |
| `dsh-trading-mode/lib/trading/providers/yahoo.js` | 能力自述补 `intervals`；`looksBlocked` 判定对齐（本机 403 时归类 `UPSTREAM_BLOCKED`）；类别股用 `BRK-B` 拼写 |
| `dsh-trading-mode/lib/trading/providers/stooq.js` | 同上（历史兜底位）+ `supportsSymbol` 拒绝指数 |

**未改动**：`cordis.patch.yml`（仍是 `- insert: [{id: trading-mode, name: 'dsh-trading-mode'}]`）、
`lib/trading/{http,errors,sessions,symbols,indicators,log}.js`。

## New Files

```
dsh-trading-mode/lib/trading/providers/eastmoney.js   东方财富：search/quote/candles/profile（US+HK，5m–1wk）
dsh-trading-mode/lib/trading/providers/tencent.js     腾讯：quote + 日/周 K 线（GBK）
dsh-trading-mode/lib/trading/providers/index.js       PROVIDER_CLASSES + buildProviders()
dsh-trading-mode/lib/trading/router.js                MarketDataRouter（选源 + 健康度 + 降级聚合）
dsh-trading-mode/lib/trading/directory.js             SymbolDirectory + SEED_DIRECTORY（22 条）+ hasCjk/splitNames
dsh-trading-mode/lib/trading/indices.js               指数目录（8 条）+ lookup/search + Provider 能力矩阵（0.3.0）
dsh-trading-mode/lib/trading/universe.js              StockUniverse：全量美股/港股清单（翻页 + 本地索引 + JSON 快照）（0.4.0）
dsh-trading-mode/lib/trading/service.js               MarketDataService（编排 + 缓存 + 指标 + meta 信封）
dsh-trading-mode/lib/trading/watchlist.js             WatchlistStore（DSH User ID 绑定）
dsh-trading-mode/lib/trading/settings.js              UserSettingsStore（语言偏好，按 User ID，原子写）
dsh-trading-mode/lib/trading/ai.js                    TradingAi（Prompt + 结构化 JSON + 重试 + 语言指令）
dsh-trading-mode/lib/trading/api.js                   /api/trading/* 前缀路由
dsh-trading-mode/lib/trading/persist.js               行情缓存磁盘持久化（可选）
dsh-trading-mode/docs/IMPLEMENTATION-PLAN.md          §78 计划
dsh-trading-mode/docs/DELIVERY-REPORT.md              本文件（§79）
.trading-research/test-host.mjs / test-client.mjs / test-host-report.json / 4 份侦察报告
```

**删除**：`dsh-trading-mode/client.js`（根目录旧「动态插件」副本，不在 `files`/`exports` 中，属死代码；TradingView 功能已并入 `lib/client.js`）。

## Database Changes

DSH **没有数据库**（无 DB / ORM / Redis / User 表），故：

- 用 `@deepseek-ai/dsh-storage-domain` 定义 domain **`trading_watchlist` version 1**，
  `layout:'single'`、`invalidRecords:'backup-and-skip'`，一张表 `items`，行 schema 用 zod 动态导入校验。
- 行字段（= 策划案 §12）：`id, userId, symbol, market, name, nameZh, exchange, currency, position, isFavorite, createdAt, updatedAt`。
- **无 SQL migration**。未来演进：`version: 2` + `compatibleVersions:[1]`；行数超过 ~2k 时把 `layout` 改为 `'per-record'`（此时 key 需匹配 `SAFE_KEY_RE`，用 `${market}_${symbol}`）。
- 兜底路径（storage-domain 不可用时）：`$DSH_HOME/trading-mode/watchlist.json`（临时文件 + rename 原子写）。启动测试已验证「重启后从文件恢复」。
- 行情缓存另存 `$DSH_HOME/trading-mode/market-cache.json`（可选，≤4MB，按 `storedAt` 保留最新 500 条）。
- 界面语言偏好存 `$DSH_HOME/trading-mode/settings.json`（0.2.2 新增，`{version:1, updatedAt, users:{<userId>:{lang,updatedAt}}}`，
  临时文件 + rename 原子写；**不写 `localStorage`**，因此换会话/换设备只要 DSH User ID 相同即生效）。
- 全量证券名录存 `$DSH_HOME/trading-mode/universe.json`（0.4.0 新增，`{version:1, updatedAt, totals, rows:{US:[[symbol,name,board,exchange,industry]], HK:[…]}}`，
  上限 12MB，每 20 页或去抖 2s 后原子写；**不含行情，只含名录**，可随时删除重建）。

## APIs

前缀路由 `/api/trading`（`ctx.webServer.register({kind:'prefix'})`，长于网关的 `/api` 因而优先命中），
handler 内先 `connection.requestRejection(req)` 复刻网关鉴权（403 `FORBIDDEN` / 401 `UNAUTHENTICATED`），
统一信封 `{ok:true,value}` / `{ok:false,error:{code,message,…}}`：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/trading/`、`/bootstrap` | `userId, items[+quote], count, recommendations, backend, status, ai, settings, markets, disclaimer` |
| GET | `/api/trading/status` | 服务/Provider/缓存/AI/Watchlist 状态 + 公开配置 |
| GET | `/api/trading/search?q=&market=` | `{query, market, results[], source}` |
| GET | `/api/trading/indices[?symbols=^VIX,^IXIC]` | `{items[{symbol,name,nameZh,market,currency,kind:'index',links,quote,meta}], count, unavailable[], generatedAt, markets, disclaimer}`（0.3.0） |
| GET | `/api/trading/universe?market=&board=&page=&size=&q=` | 浏览模式 `{mode:'browse', market, board, label, exchange, page, size, total, pages, rows[], boards[], status}`；`q` 时 `{mode:'search', rows[], total, …}`（0.4.0） |
| POST | `/api/trading/universe` | `{started, running, status}`（body `{market, board}`；启动后台整板块遍历，同一时刻只允许一个） |
| GET | `/api/trading/quote/:symbol` | `{data:MarketQuote, meta}` |
| GET | `/api/trading/candles/:symbol?interval=&range=`（别名 `/chart/…`） | `{data:{symbol,market,interval,range,candles[]}, meta, technical, technicalMeta}` |
| GET | `/api/trading/profile/:symbol` | `{data:CompanyProfile, meta}` |
| GET | `/api/trading/technical/:symbol`、`/indicators/:symbol` | `{data:…, meta}` |
| POST | `/api/trading/analyze/:symbol` | §35 结构化分析 JSON（body `{lang?}`） |
| GET/PATCH | `/api/trading/settings` | `{userId, lang, supported, defaultLang, updatedAt, storage}`（PATCH body `{lang}`；非法语言 `BAD_REQUEST`，无存储 `STORAGE_ERROR`） |
| GET | `/api/trading/watchlist[?quotes=1]` | `{userId, items[], count}` |
| POST | `/api/trading/watchlist` | `{created, item}`（body `{symbol, market?}`） |
| PATCH/POST | `/api/trading/watchlist/order` | `{items[], count}`（body `{symbols:[…]}`） |
| POST | `/api/trading/watchlist/analyze` | §38 Brief JSON（body `{}` 或 `{symbols:[…], lang?}`） |
| GET/DELETE/PATCH | `/api/trading/watchlist/:symbol` | `{item}` / `{removed:true}`（PATCH body `{isFavorite}`） |

`meta`（§20）固定包含：`symbol, market, source, provider, timestamp, fetchedAt, cached, cacheAgeMs, stale, staleReason, delaySeconds, freshness, marketOpen, cacheKind, disclaimer`。

## Market Providers

| id | 声明角色 | 实际状态 | 能力 |
| --- | --- | --- | --- |
| `yahoo` | §5.1/§5.2 Primary | **403（本机网络不可达）** | search/quote/candles/profile |
| `stooq` | §5.3 Historical Fallback | **403** | quote/candles/profile |
| `eastmoney` | 实际主力 | ✅ 可用（批量端点会被上游间歇 RST） | search/quote/candles/profile/universe，US+HK，5m/15m/30m/1h/1d/1wk |
| `tencent` | 备用 | ✅ 可用 | quote + 1d/1wk K 线（GBK；分钟端点与搜索在本环境不可用；**美股日线 count 失效，只回首末两根**） |
| `sina` | 0.4.1 兜底 | ✅ 可用 | **港股清单**（60/页，带中文名）+ **美股日线**（`US_MinKService.getDailyK` 全量历史按区间切尾）+ `^IXIC`/`^NDX`/`^DJI` 日线；无港股日线、无分钟线 |
| `nasdaq` | 0.4.1 兜底 | ✅ 可用 | **美股清单**（screener 一次取一个交易所：NASDAQ 4033 / NYSE 2690 / AMEX 293），仅 `universe`，不提供报价 |

`MARKET_DATA_CONFIG`：US/HK 均为 `{ primary:'yahoo', historicalFallback:'stooq' }`；
候选链 **US `['yahoo','eastmoney','tencent','sina','stooq']`**、**HK `['yahoo','eastmoney','tencent','stooq']`**（sina 无港股日线）。
清单的源顺序 `UNIVERSE_PROVIDERS = { US:['eastmoney','nasdaq'], HK:['eastmoney','sina'] }`。
实测末次 Provider 健康：`yahoo` 4 次调用全失败（403）；`eastmoney` 72 次调用 0 次失败；`tencent` 7 次调用 0 失败；`stooq` 未被调用。

**传输层（0.4.1，「抓取失败」的根因）**：`lib/trading/http.js` 不使用全局 `fetch`。
本机 `push2.eastmoney.com` 的 IPv4 / IPv6 两条路径会**轮流**不可用 —— 坏的那条 TCP 能连上再被 RST，
undici 不会换地址，于是报 `TypeError: fetch failed (UND_ERR_SOCKET)` / `socket hang up`。
插件改用 `node:http(s)` + 共享 keep-alive agent，记录上次成功的地址族（`workingFamily`），
并在重试时钉死 / 翻转地址族（attempt≥1 交替 IPv4/IPv6）；**不修改宿主进程的 DNS 解析顺序**。
另外，东财的批量端点 `/api/qt/clist/get`（清单）与 `/api/qt/stock/kline/get`（K 线）会被上游间歇性阻断
（对本机所有客户端返回 RST，而 `stock/get`、`searchapi` 正常）——这正是「报价正常、抓取失败」的原因，
由 `sina` / `nasdaq` 兜底源接管。

**K 线最小根数校验（0.4.1）**：路由支持 `validate` / `sizeOf` —— 蜡烛数低于 `minBars(range, interval)`
（6mo 日线 ≥17、1y ≥29）时视为数据不足并继续下一个源，**但只记 `DATA_UNAVAILABLE` 不记健康失败**
（否则腾讯会因只回 2 根而被冷却 60s，连它擅长的港股 K 线与全部报价一起失效）；全部源都不足时返回最大的一份并标 `degraded: true`。


**指数能力（0.3.0，由 `supportsSymbol()` 显式声明，未声明能力的 Provider 不进候选）**：

| 指数 | eastmoney | tencent | yahoo | stooq |
| --- | --- | --- | --- | --- |
| `^IXIC` `^NDX` `^GSPC` `^DJI` `^HSI` `^HSCEI` | ✅ quote/candles | quote only（美股指数无 K 线） | 声明支持（本机 403） | ✗ |
| `^VIX`（东财无此指数） | ✗ | ✅ quote（快照停在 2026-09-11 → `stale`） | 声明支持 | ✗ |
| `^HSTECH`（东财无此指数） | ✗ | ✅ quote + candles | 声明支持 | ✗ |

即：**东财没有的指数由腾讯兜底，腾讯没有的美股指数 K 线由东财提供**；两者都没有的组合（如 `^VIX` K 线）会明确失败且不计入 Provider 失败预算。

## Cache Strategy

- key 严格按 §41：`quote:{symbol}`、`candles:{symbol}:{interval}:{range}`、`profile:{symbol}`、`technical:{symbol}:{interval}:{range}`、`search:{market}:{q}`。
- TTL 全部集中在 `config.js` 的 `CACHE_TTL`（**UI 不硬编码**）：

| 类别 | 开盘 (open) | 休市 (closed) | maxStaleAge |
| --- | --- | --- | --- |
| quote | 20s | 10min | 72h |
| candles | 60s | 30min | 7d |
| profile | 24h | 24h | 30d |
| technical | 60s | 30min | 24h |
| search | 10min | 60min | 24h |

- `marketStatus(market)` 判定开盘/休市（`America/New_York`、`Asia/Hong_Kong`，09:30–16:00）。
- 读取策略：命中且未过期 → `cached:true`；过期但 `< maxStaleAge` 且上游失败 → 返回旧值并 `stale:true` + `staleReason`；
  超过 `maxStaleAge` → 丢弃，`DATA_UNAVAILABLE`（UI 显示 `Data unavailable`）。
- 公共行情全局共享（§13 多用户同一标的只抓一次）；Watchlist 是私人数据，不进行情缓存。
- **全量清单（0.4.0，`lib/trading/universe.js`）**：不是行情缓存而是「证券名录 + 已抓页索引」——
  内存 `rows: Map<market, Map<symbol, record>>` + `totals`/`pages`，磁盘快照 `<homeDir>/trading-mode/universe.json`（原子写，
  上限 12MB），**每 20 页 flush 一次**（2s 去抖），不设 TTL（名录变化缓慢，可由用户点「载入整个板块」刷新）。
  本地筛选只覆盖已抓页；未命中由 `/search`（上游全市场检索，已是放宽后的 100 条）兜底。
- 实测（81 项测试末）：`size:57, hits:31, misses:61, staleServed:0, evicted:0`。

## Quant Engine

服务端纯函数（`lib/trading/indicators.js`），基座固定 **1d × 1y（≈252 根）**，保证 MA200 / 52 周高低可用。

- 实现指标：**MA5/10/20/50/60/200、EMA12/26、RSI14、MACD(12,26,9)+Signal+Histogram、ATR14、20D 均量、Volume Ratio(20D)、52 周高低**，
  以及 5D/1M/3M/1Y 涨跌、价格与 MA20/50/200 偏离%、距 52W 高低%、20D 年化波动率、均线排列 `trendAlignment`
  （`bullish-stack` / `bearish-stack` / `short-term-above-medium` / `short-term-below-medium` / `flat` / `insufficient-history`）、
  摆动高低点 `pivots` → support/resistance 候选。
- §31 要求的 `technical` 形状全部满足：`ma5, ma20, ma50, ma200, rsi14, macd, macdSignal, macdHistogram, atr14, volumeRatio20d`。
- bar 不足 → 字段 `null` 并记入 `unavailable[]`，**不猜值**。
- 实测（§77.21 必测标的）：AAPL 333.69 USD / ma20 331.895 / ma200 288.7608 / rsi14 54.74 / bullish-stack / 52W高 345.34；
  NVDA 233.95 / ma20 223.7485 / ma200 200.338 / rsi14 63.01；TSLA 370.59 / rsi14 54.99；
  0700.HK 421.2 HKD / ma20 433.7 / ma200 496.146 / rsi14 40.61 / bearish-stack；9988.HK 104.4 HKD / ma20 108.38 / ma200 128.019 / rsi14 38.63。

## DeepSeek

**接入**：`ctx.get('llm')`（`@deepseek-ai/dsh-llm`）；模型解析顺序 = 显式配置 → `agentDefaultModel.currentSelection()` → 扫 `llm.listProviders()/listModels()` 找 DeepSeek。
`maxTokens 2400`、`temperature 0.2`、`timeoutMs 120000`；`BlockAssembler` 逐 chunk 组装，按 `finish.kind` 分类失败
（`aborted`→TIMEOUT、`error`→上游码、`max-tokens`/非 `stop`→`AI_INVALID_OUTPUT`）；可重试集合
`RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE/AI_INVALID_OUTPUT`，退避 `500·2^(n-1)` ms。

**输入 Schema（单股）**——`buildStockInput()` 产出，**只含归一化数据，零上游原始载荷**（§4/§16，已断言）：
```jsonc
{ "symbol":"AAPL", "market":"US", "asOf":"…", "marketSessionOpen":false,
  "company":{"name":"Apple Inc.","nameZh":"苹果","exchange":"NASDAQ","currency":"USD"},
  "quote":{"price":333.69,"change":…,"changePct":…,"open":…,"high":…,"low":…,"previousClose":…,"volume":…,"timestamp":"…","source":"eastmoney","stale":false},
  "technical":{"ma20":331.895,"ma50":…,"ma200":288.7608,"rsi14":54.74,"macd":…,"macdSignal":…,"macdHistogram":…,"atr14":…,"volumeRatio20d":…,"high52w":345.34,"low52w":…},
  "levels":{"support":[…],"resistance":[…]},
  "recentDailyCloses":[{"date":"…","close":…}] }
```

**System Prompt**：§34 原文 12 条规则（`You are the AI market analysis engine inside DSH Trading Mode…`
Never invent market data / 只使用输入中的值 / 区分事实与解读 / 数据缺失就说明不可用 / 尊重时间戳 /
不得把延迟数据描述为实时 / 已提供指标不得重算 / 不做保证性预测 / 不作为投资建议 / 聚焦 trend,momentum,volume,volatility,support,resistance,risk），
并要求只输出 JSON。

**输出 Schema（§35）**：`{summary, trend:{shortTerm,mediumTerm,longTerm}, momentum, volume, supportLevels[], resistanceLevels[], riskFactors[], keyObservations[]}`；
缺失字段填 `"Unavailable."`；`repair()` 去 ```json 围栏并截取首个 `{` 到末个 `}`。

**界面语言（0.2.2）**：`languageDirective(lang)` 把「用简体中文书写 JSON 中所有人类可读字符串」追加到
§34/§40 System Prompt 的**末尾**（原文一字未改，便于审计）；`lang` 来自请求体 `{lang}`，缺省取该用户在
`settings.json` 里的偏好。JSON 的键名、代码、数字、单位与百分比在任何语言下都不翻译，
因此 `normalizeAnalysis/normalizeBrief` 的输出结构与当地语言无关。返回的 `meta.lang` 回显实际使用的语言。

**Brief（§38–§40）**：输入 = 每只标的的 Daily Change / Volume Change / Technical Status / Relative Movement；
输出 `{headline, stocksTracked, upCount, downCount, strongestMover, largestDecline, unusualVolume[], keyObservations[]}`；
Prompt 明确 `Do not assume the user owns these stocks. Refer to them as watchlist stocks.`（§26 禁止 Portfolio 措辞）。
LLM 不可用 → `AI_UNAVAILABLE` 并如实提示，**绝不回落为编造分析**。

## Tests

| 测试 | 范围 | 结果 |
| --- | --- | --- |
| `.trading-research/test-host.mjs`（真实网络栈，不依赖 DSH 进程） | §22 全部 13 条搜索、§77.21 五个必测标的的 quote + 全部区间 K 线 + §31 十项指标、§28 区间、HK 5m/15m/30m/1h、非法入参、缓存命中/过期兜底、Watchlist CRUD+排序+收藏+用户隔离+重启恢复、路由注册/派发/方法守卫、§16 不泄漏上游载荷、§44 单 Provider 故障自动切换、语言偏好归一化/落盘/重启恢复/用户隔离/非法语言拒绝/`/settings` 路由/prompt 只追加不改写/语言透传到 AI 层、指数目录与 Provider 能力矩阵、`GET /indices`、指数端到端 quote/profile/search/candles、报价算术一致性回归（`price ≈ previousClose + change`）、**全量清单：板块配置、代码方言（`BRK.B`/`80700.HK`/`0001.HK`/`8003.HK`）、`GET /universe` 真实翻页、本地索引搜索、放宽后的搜索（ETF + 港股中文名 + 类别股）、`POST /universe` 后台遍历与失败上报、快照重启存活、**传输层地址族自适应（不钉死单族、无进程级 DNS 标志也能到达东财、坏族只损失一次重试、超时/abort 仍映射为 `UPSTREAM_TIMEOUT`）**、**兜底源注册与能力边界、`minBars` 阈值、K 线过短被跳过且不触发断路器、清单多源回落、真实 nasdaq/sina 清单、live `/universe` 的 provider 归属** | **91/91 PASS**（exit 0） |
| `.trading-research/test-client.mjs`（真实 React 18 + `renderToString`） | bundle 无顶层 ESM、`__ModuleLoader__` 契约、两个 slot 各注册一次且传组件函数、样式注入与 dispose 清理、TradingView 符号映射、格式化不出 NaN、K 线几何（每根 1 影线+1 实体+1 量柱、3 条均线）、下采样保留首末、关闭时不渲染、Home/Detail 区块齐备、§31 网格 19 项、§21 措辞与禁用词、中英字典完整性（全部 `t()` 字面量有译文、无裸露 key）、插值/回落、§31 网格随语言本地化而数值不变、平台语言被采用直到用户手动选择、切换控件与优先级、Market Overview 指数卡片渲染、来源链接集合（个股 4 条 / 指数 3 条）与 `target="_blank" rel="noopener noreferrer"`、**全量清单浏览器渲染与本地化、「已添加」禁用态、`80700.HK` 不被 `0700.HK` 误判** | **22/22 PASS** |

关键通过项举例：AAPL 区间 `1d=88(5m) / 5d=75(30m) / 1mo=32 / 3mo=76 / 6mo=142 / 1y=262 / 5y=262(1wk) / max=1210(1wk)`；
0700.HK `5m=400 / 15m=140 / 30m=75 / 1h=45`；搜索排序 `NVIDIA→NVDA`、`阿里→9988.HK`、`苹果→AAPL`、`腾讯→0700.HK`、`Alibaba→BABA`。

指数（0.3.0）实测：`^IXIC 27386.94 USD +0.72%`、`^NDX 30974.78 +0.54%`、`^GSPC/SPX 7758.84 +0.47%`、`^DJI 51157.17 -0.04%`、
`^HSI 24040.34 HKD +0.28%`、`^HSCEI 8051.67 +0.26%`、`^HSTECH 4183.68`（tencent）、`^VIX 21.67`（tencent，**stale**，最后成交 2026-09-11）；
K 线 `^HSI=32 根（eastmoney）`、`^HSTECH=32 根（tencent 兜底）`；`getCandles('^VIX')` 明确失败且**不消耗 Provider 失败预算**（能力过滤生效）。

全量清单（0.4.0）实测：`GET /universe?market=US&board=NASDAQ&page=1` → `total=6065, pages=61`，100 行；
`market=HK&board=MAIN` → `total=2619`（首行 `0001.HK 长和`）；HK `GEM=315`、`FUND=490`；US AMEX 第 3 页 100 行。
搜索放宽后：`SQQQ`/`ICLN`/`SPY`/`ARKK` 可搜到、`银行`→`0011.HK/0023.HK/0939.HK/0998.HK`（此前无港股）、
`领展`→`0823.HK`、`BRK.B`→`BRK.B|伯克希尔哈撒韦-B|NYSE`、`80700`→`80700.HK`（与 `0700.HK` 不冲突）；
本地索引在抓取 2 页后即可 `q=AAAP` 命中，快照重启后 US/HK 行数不变。

「抓取失败」修复（0.4.1，m02212）实测：`probe-addresses.mjs` 逐 IP 直连 `push2.eastmoney.com` ——
IPv6 `2408:4003:1046:b904:a881:8b7f:71a8:c227` 3/3 `200`（43–230ms），IPv4 `14.103.191.91` 3/3 `socket hang up`；
当天上午恰好相反 → 地址族**轮流**失效，只能靠重试翻转覆盖（插件策略）。东财批量端点被阻断期间：
`AAPL 1d/6mo` 由 `sina` 供 132 根（eastmoney 恢复时 142 根），`NVDA 1d/1mo` 22 根（腾讯的 2 根被 `minBars` 拒掉，
且 `tencent failures=0`），`0700.HK 1d/6mo` 142 根仍由 tencent 提供；
清单回落 `US via nasdaq (total=4033, pages=41)`、`HK via sina (60 行，首行 0001.HK 长和)`。

### 装机后的运行时验证（真实 DSH 0.2.0-rc.2，非模拟）

| 事实 | 证据 |
| --- | --- |
| 安装进**正在运行**的 profile | `plugin_manager(install_bundle, target=<本目录>)` → `stage:"enable"`, `application:"applied"`, pnpm `exitCode:0`，生成依赖 `dsh-trading-mode link:C:/…/dsh-trading-mode`；日志落在 `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-ROE5D8/pnpm.log`（由此确认运行中的 profile 是 `desktop`） |
| Loader 行存在 | `bundles` 总数 19 → **20**；新条目 `dsh-trading-mode`（安装时 0.2.1，因是 `link:` 安装，工作区源码即运行时版本，现为 0.4.0），`rows:[{rowId:"trading-mode", moduleName:"dsh-trading-mode", entryId:"include:trading-mode"}]`；`Config.listConfigs({name:"dsh-trading-mode"})` 返回 `include:trading-mode` |
| 宿主 API 已挂载 | `curl -i http://127.0.0.1:19387/api/trading/status` → `401` + **本插件的信封** `{"ok":false,"error":{"code":"UNAUTHENTICATED",…}}`，响应头带 `content-type: application/json; charset=utf-8` 与 `cache-control: no-store, no-cache, must-revalidate`；对照 `/api/definitely-not-a-route-xyz` → `401` 且正文是裸 `unauthorized`（无这些头）→ 前缀路由确实由本插件接管 |
| 客户端 slot 已注册 | `Slots.listSubTree({root:"conversation.session.header.actions"})` 的 occupants 新增 `{registrant:"trading-mode", id:"trading-mode", order:30, active:true}`（其余 5 个 `mf/*` 条目不受影响） |
| 热加载 | 安装后**未重启**即生效（row 与 slot 都在运行中的进程里出现） |
| 依赖解析 | 从该 profile 解析 `@deepseek-ai/dsh-llm` / `dsh-storage-domain` / `dsh-anonymous-user-id` 均成功，且分别导出 `BlockAssembler`+`createUserMessage` / `defineDomain`+`domainTable` / `getOrCreateAnonymousUserId`（插件对这四处全部用 try/catch 动态 import，缺失即降级） |
| 与其他插件零冲突 | 19 个既有 bundle 全部 `installed:true, enabled:true`，版本不变；对 `profiles/desktop/node_modules`（排除 `@deepseek-ai`）搜 `api/trading|trading-mode|market_data` → 无匹配；slot/CSS/loader id 审计见 README「与其他插件共存」 |

**尚未在线验证的一点**：DeepSeek 分析链路的**真实模型调用**（`ctx.llm.stream`）只验证到「无 LLM 时干净返回
`AI_UNAVAILABLE`」与纯函数级的输入/输出校验；端到端需要面板里点一次 AI Analysis。
之所以无法离线跑通，是因为联调环境没有可用的 LLM 依赖解析路径。

## Known Limitations

1. **Yahoo Finance 与 Stooq 在本机网络下均返回 403**，因此策划案 §5.1/§5.3 指定的 Primary/Fallback 实际不出数，
   真实服务链为 `eastmoney → tencent`。Provider 抽象未被绕过（§77.24），网络/Vendor 变化时只改 Provider 层与配置。
2. **无 Level2 / 逐笔 / 期权 / 期货 / 盘前盘后**（§3.2 明确不做）；`delaySeconds` 无法从上游确证 → 保持 `null`，
   UI 始终显示 `Data may be delayed`，不谎称实时（§21）。
3. 东财**美股 PE（f162）实测为 0** → 归一化为 `null`；东财无公司简介接口（datacenter `RPT_F10_BASIC_ORGINFO` 返回
   `{"success":false,"message":"返回数据为空","code":9201}`）→ `profile.description` 由行情字段拼装（行业/市值/股本/52周/上市日期）。
4. 腾讯 Provider 能力受限：**所有分钟级端点不可用**（`param error` / `Can't load controller`），故仅 quote + 1d/1wk；
   HK/US 分钟线依赖东财。
5. 东财 K 线必须自带 `beg=YYYYMMDD`（只给 `lmt` 会返回 `{"rc":102,"data":null}`）；`fqt=1` 前复权在极老数据上会出现负价，
   适配器检测 `close<=0` 后自动 `fqt=0` 重取；分钟线时间戳为**北京墙钟**，日/周线按市场本地 12:00 归位。
6. 缓存为**进程内 LRU + 可选 JSON 持久化**：DSH 没有 Redis（§41 的建议在本环境不成立）；跨进程无共享缓存，
   JSON 后端无跨进程锁（写临时文件 + rename，无 fsync）。
7. Watchlist 绑定的是 `getOrCreateAnonymousUserId()`（harness 级单 UUID，存于 `~/.dsh/.anonymous-user-id`）——
   DSH 无多用户体系，「换设备仍在」取决于该文件是否随环境迁移。
8. 客户端 bundle **不能引入任意 npm 依赖**（只解析 react 等 10 个平台种子）→ K 线为自绘 SVG，未引入图表库；
   5Y/MAX 之外的自定义区间与 §54 Compare、§30 Bollinger/VWAP/ADX/OBV/Stochastic 留待 V0.2。
9. 搜索质量依赖 22 条种子目录 + 上游建议接口；冷门标的仍可能返回衍生品（如港股杠杆 ETF），已用排序惩罚压制但非绝对。
10. **「插件装了却没出现」的头号原因不是禁用，而是装进了另一个 profile**：DSH 允许并存多个 profile
    （本机 `~/.dsh/profiles/{desktop,web}`），`plugin install` 只作用于**当前运行**的那一个。
    装错时 Loader 里连 `include:<id>` 都没有、客户端 slot 也不会出现，而 `cordis.patch.yml` 与
    `.dsh-market/state.json` 看起来「一切正常」，极易误判。判据只有两个运行时事实：
    `plugin_manager(list_bundles)` 与 `cordis_inspect_query(client, Slots, listSubTree)`。
11. 安装时的 **peerDependencies 版本门禁**：DSH 会拿插件声明的 `@deepseek-ai/*` peer 与运行时版本比对，
    `^0.1.1-rc.2` 之类的旧区间（`<0.2.0`）在 0.2.0-rc.2 上**永远不满足**并直接拒装。本插件按生态惯例
    （`dsh-pocket`）不声明客户端运行时 peer，宿主的可选依赖用 optional peer + 动态 import + 降级，
    而不是用 `allow-version` 强行豁免（那等于让用户承担崩溃风险）。
12. **指数数据源不均**：东财没有 VIX / 恒生科技指数（`{"rc":100,"data":null}`），腾讯没有美股指数 K 线。
    已用 `supportsSymbol()` 在路由层做能力过滤（避免把「源没有这个标的」误记成故障并触发 60s 冷却）。
    腾讯的 **VIX 快照最后更新时间停在 2026-09-11**（约 3 周前），因此 VIX 恒为 `stale:true`、UI 显示
    `Last available data`；这是上游问题，不是本插件缓存问题。
13. **外部来源页面能否打开取决于用户网络**：本机 TradingView 连接超时（fetch 状态 0）、Yahoo 全部 403；
    链接按标准 URL 形式提供且只作为链接（不抓取、不代理）。东财的 `quote.eastmoney.com/globalindex/*` 指数页返回 404，
    故指数不提供东财链接（个股页 `/us/`、`/hk/` 实测 200）；腾讯 `gu.qq.com/<key>` 对个股与指数均 200。
14. **全量清单不是「一次性下载 1.7 万行」**：上游 clist 每页硬上限 100 行，打开面板时只取当前板块第 1 页
    （US NASDAQ 6065 行 = 61 页、美股全部约 139 页、港股三块共 34 页）。因此「浏览全部」给的是**分页 + 按板块载入**：
    本地筛选只覆盖已抓页，未命中会自动回落到全市场搜索接口（`/search`），保证任何标的都能立即添加；
    点「载入整个板块」才在后台走完该板块（受 120 次/分钟限流约束，美股全市场约 1–2 分钟），每 20 页落盘一次。
15. clist 清单会包含**优先股 / 权证 / 单位**（如 `ABR_D`、`TFIN_`、`AAC_U`）——这是上游分类使然；
    港股的债券 / 权证 / 牛熊证（`t:2`/`t:5`/`t:6`）已被显式排除，债券类不进入清单。
    权证等标的的行情/技术指标可能因缺少 K 线而显示 `Data unavailable`（不猜值）。

## Provider Failure Behavior

以「Yahoo 不可用」为例（本环境实际发生）：

1. **超时/重试**：`httpGet` 单请求 12s 超时、2 次重试、指数退避 350→2000ms、限流 120 req/min/Provider。
2. **错误分类**：403/429/被墙特征 → `UPSTREAM_BLOCKED`/`UPSTREAM_RATE_LIMIT`；4xx（≠429）标 `noRetry` 立即失败；JSON 解析失败 → `PARSE_ERROR`。
3. **健康度**：连续 3 次失败 → 该 Provider 进入 60s 冷却（`ProviderHealth`），路由跳过它；全部不健康时对「最久失败」者做一次半开探测，成功即恢复。
4. **降级切换**：`MarketDataRouter` 按 chain 顺序继续下一个候选（实测：模拟 eastmoney 全挂时由 tencent 成功服务）。
5. **缓存兜底**：仍失败则回落到过期缓存，返回 `stale:true` + `staleReason`，UI 显式提示 `Last available data`。
6. **最终失败**：`DATA_UNAVAILABLE` / `NOT_FOUND`（语义优先保留 NOT_FOUND），UI 显示 `Data unavailable`；
   **不触发 DeepSeek 猜测**（§43），AI 侧只报 `AI_UNAVAILABLE` 或基于已有数据说明「该项数据不可用」。
7. **隔离性**：单个 Provider 失效不会让 Trading Mode 崩溃（§44，已测）；所有失败都记入 `/status` 的 provider 快照与计数器。

## Future Migration

切换到正式 Market Data Vendor（如港股 HKEX Licensed Vendor，§7）时**只需改动 Provider 层**：

1. 新增 `lib/trading/providers/<vendor>.js`（继承 `MarketDataProvider`，实现 `searchStocks/getQuote/getCandles/getCompanyProfile`，
   声明 `capabilities/markets/intervals`）。
2. 在 `lib/trading/providers/index.js` 注册进 `PROVIDER_CLASSES`。
3. 在 `lib/trading/config.js` 的 `PROVIDER_CONFIG` 增加端点配置，并把 `MARKET_DATA_CONFIG[market].chain`（必要时 `primary`/`historicalFallback`）
   指向新 Vendor。
4. 需要时扩充 `lib/trading/directory.js` 的 `SEED_DIRECTORY`。

**无需改动**：`service.js`（编排/信封）、`router.js`、`cache.js`、`indicators.js`、`watchlist.js`、`ai.js`（Prompt 与输出 Schema）、
`api.js`（对外 API 形状）、`lib/client.js`（UI）、`lib/index.js`（装配）。

未来若上 A 股（§57）：新增 `CNMarketDataProvider` + 配置项，`MARKET_DATA_CONFIG` 的 markets 列表与 client 的市场切换各加一项。

---

# 0.5.0 增量交付：五天市场（美股 / 港股 / A 股 / 日股 / 加密货币）

> 本节是 §79 报告在 **0.5.0**（2026-10-07）上的增量，前景章节（Changed Files / APIs / Known Limitations 等）
> 记录的是 0.1–0.4.1 的基线；两者叠加即为当前交付状态。
> 测试证据：`.trading-research/test-host.mjs` **95/95 PASS**（其中 8 项因上游不可达按 `DEGR` 记，见下）、
> `.trading-research/test-client.mjs` **24/24 PASS**、`.trading-research/probe-five-markets.mjs` **44 通过 / 0 失败 / 7 上游不可用**、
> `.trading-research/probe-market-metadata.mjs` **25/25 PASS**、`.trading-research/verify-install.mjs` **5/5 PASS**。当前版本 **0.5.0**。

## 需求与范围

用户要求（m02818）：在已有美股 / 港股之上，**新增 A 股与日股行情查询，并新增加密货币查询、与各股票市场并列**。
设计原则沿用 §28/§43：**能拿到就展示，拿不到就明确说不可用，绝不编造**。

## 变更清单

| 文件 | 变动 |
| --- | --- |
| `dsh-trading-mode/lib/trading/config.js` | `MARKETS=['US','HK','CN','JP','CRYPTO']`；`CRYPTO` 链补 `coinlore`（原缺 → 加密搜索必抛 `NO_PROVIDER`）；新增 `CRYPTO_RANGE_DAYS` / `BARS_PER_DAY.{equity,crypto}`、`rangeDays(range,market)`；`candleLimit` / `minBars` 增加 market 参数（加密按日历日，股票口径不变）；`UNIVERSE_BOARDS.CRYPTO` 与 `UNIVERSE_PROVIDERS.CRYPTO=['coinlore','binance']` |
| `dsh-trading-mode/lib/trading/providers/{binance,gate}.js` | K 线请求量改用 `candleLimit(range, interval, 'CRYPTO')`（24/7 日历日） |
| `dsh-trading-mode/lib/trading/providers/{tencent,eastmoney,sina}.js` | K 线 sizing 传入 `parsed.market`（sina 另用 `rangeDays(range, parsed.market)`） |
| `dsh-trading-mode/lib/trading/providers/coinlore.js` | board 统一为共享的 `TOP`（兜底 `LISTING_BOARD`）；`search`/`profile`/`universe` 能力不变 |
| `dsh-trading-mode/lib/trading/directory.js` | 用 `currencyOf(market)` / `exchangeOf(market, board)` 取代 `'HKEX' : 'NASDAQ'` / `'HKD' : 'USD'` 硬编码；`lookup(symbol, market?)` 支持市场提示；`enrich()` 纠正误标的 `USD` |
| `dsh-trading-mode/lib/trading/service.js` | 加密 `profile` 由「固定 stub」改为**先走 router（CoinLore）再回落 stub**；新增 `cryptoProfileNote()` / `cryptoStubProfile()`；`mergeNames`/`enrich` 补市场货币；所有 `directory.lookup` 调用点带市场提示 |
| `dsh-trading-mode/lib/trading/indices.js` | 指数目录 8 → **15**：补 A 股 6（上证/深证成指/沪深300/创业板指/科创50/北证50）与日经 225；`DEFAULT_INDEX_SYMBOLS` 仍为按 order 的符号数组 |
| `dsh-trading-mode/lib/trading/universe.js` | 市场泛化：`boards()/page()/loadAll()/search()/status()` 全部按 `MARKETS` 迭代；吸收上游行时保留 `kind/nameZh/nameEn`；快照升级为 8 元组并兼容旧 5 元组 |
| `dsh-trading-mode/lib/client.js` | 市场 chips（US/HK/CN/JP/Crypto）、`MarketOverview` 市场 tab、`DetailView` 携带 market（`/quote|/candles|/profile?market=`、`POST /analyze` body）、货币符号与小数位（`money(0.00001234,'USDT')` 不丢精度）、来源链接按市场与实测收口、K 线不完整时显示 `partial history` 徽标、中英字典补齐 |
| `dsh-trading-mode/package.json` / `CHANGELOG.md` / `README.md` | 版本 0.5.0；CHANGELOG 完整 0.5.0 段；README 五市场清单/指数 tab/来源页实测/能力矩阵/已知限制 |

## 数据源与实测（2026-10-07 北京时间）

- **A 股**：报价与 K 线走东财（`1.600519` / `0.000001`）与腾讯（`sh600519`），清单走**新浪**（`SH-MAIN`，实测 2319 只、24 页）；
  实测 `600519.SH` 1258.62 CNY（腾讯）、6mo 日线 142 根。
- **日股**：报价走腾讯（`jp7203`）—— 实测 `7203.T` 2900.5 JPY；**东证无可用历史 K 线源**
  （腾讯东京端点任何区间只回 1 根，`appstock/kline/kline` 报 `Can't load controller:KlineController`；
  东财 `push2his` 被 RST；stooq / Yahoo 403；kabutan 405、minkabu 404、Yahoo!ファイナンス 无结构化接口），
  故日股图表只 1 根并标 `历史数据不完整`。`^N225` 仅东财一个源（DNS 正常，实测可达）。
- **A 股 / 日股 / 美股 profile 仅东财提供**：东财 `push2/api/qt/stock/get` 可达（报价/档案/指数正常），
  而 `clist`（清单）与 `stock/kline`（K 线）会被上游 RST（`socket hang up`）—— 属**间歇性上游阻断**，
  插件按 §43 降级并在 `degraded` 中体现，不做无谓重构。
- **加密货币**：报价/K 线 `binance → gate`（实测 BTC 83714.66 USDT、1mo/1h **730 根**、5y/1d 1600 根）、
  搜索与档案 `coinlore`（`比特币`/`索拉纳` 中文名、市值、排名）、清单 `coinlore TOP`（1078 只、216 页）。
- **指数**：`GET /indices` 实测 15 条、`unavailable=0`；US 5 / HK 3 / CN 6（10 月 7 日东财不可达时 `^N225` 可能为空）。

## 测试与降级约定（0.5.0）

- `test-host.mjs` 新增三类检查：加密为一等市场（链/板块/日历日 sizing 的数值断言）、目录逐市场 venue+currency、
  加密档案由上游写而非仅 stub；另修正过时断言（`sina.listingMarkets=['HK','CN']`、指数 8→15 与市场分布 `{US:5,HK:3,CN:6,JP:1}`、
  `router.candidates()` 返回对象需按 `.id` 比较）。
- **上游依赖项的诚实处理**：7 项检查（美股日线/港股分钟线/Yahoo 档案）在源站可达时断言真实数据，
  源站被阻断时断言「抛出具类型 `TradingError`（`DATA_UNAVAILABLE`/`UPSTREAM_BLOCKED`）而不是编造或挂起」，
  打印为 `DEGR` 且不计失败 —— 测试结果不随上游抖动翻转，同时仍覆盖降级契约。
- 新增探针：`probe-five-markets.mjs`（五市场端到端）、`probe-market-metadata.mjs`（目录元数据）、
  `probe-jp-profile-gaps.mjs` / `probe-jp-candles-ea.mjs` / `probe-jp-fallbacks.mjs` / `probe-jp-index-sources.mjs` /
  `probe-nikkei-truth.mjs`（日股与日经源排查）、`probe-link-candidates.mjs`（来源页实测）。

## 0.5.0 已知限制

1. **东证（`7203.T` 等）无历史 K 线源** —— 报价/档案正常，图表显示 1 根并标 `partial history`。
2. `^N225` **只有东财一个源**，东财不可达时该指数条为空（其余四个市场 tab 不受影响）。
3. **A 股 / 日股 / 美股 `profile` 依赖东财**，东财不可达时该面板报数据不可用。
4. 东财 `clist`（清单）与 `kline`（K 线）会被上游**间歇性 RST**：美股因此回落 Nasdaq/新浪，A 股清单回落新浪，
   日股清单在该时段不可用（不伪造）。
5. 加密档案由 CoinLore 提供，未收录的小币种回落到目录合成档案（`source: 'directory'`）。
6. 本机网络下 Yahoo 全局页 403、TradingView/Binance/Gate 页面不可达（链接仍按公开形式提供）。

---

# 0.5.1 增量交付：AI 简报接通 DSH 内部 llm 服务

> 本节是 §79 报告在 **0.5.1**（2026-10-10）上的增量。用户在界面上报告「trading 模式下 AI 生成简报
> 功能有问题，无法生成简报」（m04504），要求改为**调用 DSH 内 API 下的 DeepSeek 模型**做分析出简报。
> 测试证据：`.trading-research/test-host.mjs` **95/95 PASS + 8 DEGR**、`.trading-research/test-client.mjs`
> **25/25 PASS**（0.5.1 新增 `0.5.1 AI: an unavailable DeepSeek explains itself in both panels`）、
> `.trading-research/test-ai.mjs` **14/14 PASS**、`.trading-research/verify-install.mjs`
> **6/6 PASS**。当前版本 **0.5.1**。

## 根因（两个，都在 AI 调用路径上）

1. **插件 import 了宿主内部包**：`lib/trading/ai.js` 用 `await import('@deepseek-ai/dsh-llm')` 取
   `BlockAssembler` / `createUserMessage`。该包是 DSH 自带依赖，只存在于应用包内
   （`app.asar` → `dsh/node_modules/@deepseek-ai/dsh-llm`，0.2.0-rc.2），**既没有安装到 profile**
   （`pnpm-workspace.yaml` 里 `autoInstallPeers: false`，插件是 `link:` 进来的、没有自己的 `node_modules`），
   **也无法从应用包之外的插件解析**。实测：
   `node -e "import('@deepseek-ai/dsh-llm')"` → `ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/dsh-llm'`。
   因此每次点「AI 分析 / 生成简报」都在真正发请求之前抛
   `AI_UNAVAILABLE: @deepseek-ai/dsh-llm is not resolvable from this plugin (…)`。
2. **服务在 `apply` 时被一次性捕获**：`lib/index.js` 把 `llm` / `agentDefaultModel` 作为**值**传给
   `TradingAi`，而插件在 `ready` 里同步构造它——服务晚于此时注册就被永久冻结成 `undefined`，
   `ai.available` 恒为 `false`。
   （另有一个同类的隐藏缺陷：`watchlistBrief` 里写成 `dataAsOf: input.data.asOf`，而 `input` 来自
   `buildBriefInput()`、根本没有 `data` 字段 → 模型返回成功后仍抛
   `TypeError: Cannot read properties of undefined (reading 'asOf')`，`/api/trading/watchlist/analyze` 必然 500。）

## 修复

| 文件 | 变动 |
| --- | --- |
| `dsh-trading-mode/lib/trading/ai.js` | 删除 `loadLlm()` 与宿主包 import；新增 `export class ChunkAssembler`，按公开 `StreamChunk` 契约（`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`）本地拼装，只取 `text` 块；`TradingAi` 改为持有 `llm`/`defaultModel` 的**取值函数**（`readService`），新增 `unavailableReason()`；路由拆分 `resolveRouteSync()` / `async resolveRoute()`（`listModels` 需 `await`，优先 `/deepseek/i`）；`askJson` 缺 llm 时只报一次不重试，终态映射 `aborted→TIMEOUT`、`error→failure.code`、`max-tokens→AI_INVALID_OUTPUT`、空文本→`EMPTY_RESPONSE`；`buildUserMessage` 改为 `{role:'user',content:[{type:'text',text}]}`（宿主 `RequestUserInput` 声明 `id?: never`、`source?: never`）；`status()` 增 `reason`；修 `dataAsOf: input.data.asOf` → `input.asOf` |
| `dsh-trading-mode/lib/index.js` | `export function serviceGetter(ctx, name)`：依次尝试 `ctx.get(name)` / `ctx.root.get(name)` / `ctx[name]`，每次调用重新解析并吞掉异常；`ai = new TradingAi({ llm: serviceGetter(ctx,'llm'), defaultModel: serviceGetter(ctx,'agentDefaultModel'), … })`；ready 日志打印 `ai: available` 或 `ai: unavailable — <原因>` |
| `dsh-trading-mode/lib/client.js` | AI 不可用时在简报卡与分析面板里显示原因：`BriefCard` / `AiAnalysisSection` 新增 `aiAvailable` / `aiReason`，渲染 `.tm-hint__why` 行 `t('Reason: ') + aiReason`；`DetailView` / `HomeView` / `TradingApp` 逐层透传 `ai.reason`；ZH 字典加 `'Reason: '`；两个面板加入 `_internals` 以便 SSR 断言 |
| `dsh-trading-mode/package.json` / `CHANGELOG.md` / `README.md` / `docs/DELIVERY-REPORT.md` | 版本 0.5.1；CHANGELOG 新增 0.5.1 段；README 新增「AI 分析与简报（0.5.1）」与 4 条踩坑记录、测试计数改为 95/95 + 8 DEGR / 25/25 / 14/14 / 6/6；本报告新增本节 |
| `.trading-research/test-ai.mjs`（新增） | 用「只实现宿主公开契约」的假 llm 驱动真实 `TradingAi`：13 项检查（chunk 拼装、`askJson` 端到端、`analyzeStock`/`watchlistBrief`、**延时注册服务回归**、缺服务单次失败、async 模型发现、重试、三种终态、空流、`status()`） |
| `.trading-research/test-client.mjs` | 新增检查 `0.5.1 AI: an unavailable DeepSeek explains itself in both panels`（**25/25 PASS**）：SSR 断言两个面板渲染 `Reason: ` 与具体原因、AI 可用时不渲染，并断言标签有中文译文 |
| `.trading-research/verify-install.mjs` | 版本门禁改 0.5.1；新增一步：安装路径的 `ai.js` 不得含宿主包 import、`ChunkAssembler` 必须本地、`buildUserMessage` 形状正确，并用延时注入的假 llm 真跑一次 `askJson`（断言 `available` 先 false 后 true、路由为 `deepseek-official`） |

## 运行链路（修复后）

`POST /api/trading/analyze/:symbol` / `POST /api/trading/watchlist/analyze`
→ `TradingAi.analyzeStock` / `watchlistBrief` → `askJson`
→ `ctx.get('llm').stream({ provider, model, messages, system, maxTokens: 2400, temperature: 0.2, signal })`
→ `ChunkAssembler` 拼文本 → `repair()` + `JSON.parse` → 结构化简报；
客户端为 `deepseek-official` / `deepseek-flash`（DSH 当前默认模型），最多 3 次重试（退避 500ms×2ⁿ），超时 120s。

## 0.5.1 已知限制 / 注意

1. **必须重启 DSH**：profile 里是 Junction（源码即运行时源码），但宿主侧模块只在进程启动时加载一次，
   不重启仍会走旧代码。
2. AI 简报需要 DSH 里有可用的 DeepSeek 模型路由（本机为 `deepseek-official` / `deepseek-flash`）；
   没有时 `GET /api/trading/status` 的 `ai.reason` 会说明原因，宿主日志也会打印同一原因。
3. 简报质量取决于模型输出是否符合 JSON 约定：不符合时按 `AI_INVALID_OUTPUT` 重试（最多 3 次），
   仍失败则明确报错，不会编造内容。
4. `test-host.mjs` 仍用 stub ai 对象（不消耗真实模型配额）；真实模型链路由 `test-ai.mjs` 的假 llm 与
   装机校验共同覆盖。

## 0.6.0：面向公开发布的可用性改造

版本号以 `package.json` 为准（`0.6.0`）。目标是把「只有作者本机能跑通」的部分改成**可配置、可复现、有文档**，
默认行为与 0.5.x 保持一致（两项新配置都是可选的）。

### 交付内容

| 方向 | 内容 |
| --- | --- |
| 可配置 | 插件配置 `providers: { US: [...], HK: [...], … }` 覆盖各市场数据源链；非法值（未知市场 / 未知 provider / 重复 / 空数组 / 非数组）不生效、保留出厂默认并写日志；`GET /api/trading/status` 与客户端配置快照暴露 `providerChains` / `providerChainProblems` |
| 网络差异 | `networkMode: auto \| standard \| compatibility`；`auto` 只把**真正出现过传输失败**的主机升级为兼容模式（地址族记忆 + 翻转），不再默认对所有主机翻转；`status()` 暴露 `transport` |
| 故障粒度 | 健康度从「一个供应商一个断路器」改为「供应商 × 能力」（`healthScope(provider, feature)`）：K 线失败不再连带禁用搜索 / 报价；`status()` 每 provider 有 `degraded` 与逐能力 `scopes` |
| 存储契约 | `publicConfig().storage` 明确写出 `scope: 'profile-local'`、`crossDevice: false`；修复自选股行 schema 只允许 `US/HK` 导致存储域后端丢弃 A 股 / 日股 / 加密行的问题 |
| 可复现 | `npm test` = 离线九套件（syntax / config / transport / router / api / watchlist / ai / client / repo），无网络、无 DSH profile；退出码 0 PASS / 1 FAIL / 3 SKIP |
| 发布卫生 | `tests/offline/repo.test.mjs` 把「无密钥 / 无私人路径 / 许可完整 / CHANGELOG 含当前版本 / 文档齐备 / README 首屏回答关键问题」变成可执行门禁 |
| 在线探针 | `npm run test:network`（宿主端到端）与 `npm run verify:install`（装机校验）可移植化、非阻断：找不到宿主模块或 react 报 SKIP，上游不可达记 DEGRADED |
| 文档治理 | README 首屏重写（一句话定位 / 「它不支持什么」/ 最短安装 / 如何验证 / 文档索引）；新增 `docs/ARCHITECTURE.md`、`docs/COMPATIBILITY.md`、`docs/DATA_SOURCES.md`、`docs/DEVELOPMENT.md`、`docs/TROUBLESHOOTING.md`、`docs/ROADMAP.md`、`docs/RELEASE_CHECKLIST.md`、`CONTRIBUTING.md`、`SECURITY.md`、GitHub Actions 与 issue / PR 模板 |

### 验证

- `npm test`（2026-10-10 实测）：**9 passed, 0 failed, 0 skipped, exit 0** —— syntax 2/2、config 8/8、transport 8/8、
  router 9/9、api 8/8、watchlist 4/4、ai 14/14、client 25/25、repo 9/9；无网络、无 DSH profile 也能跑。
- `tests/offline/watchlist.test.mjs`：4/4 —— 存储市场列表与 `MARKETS` 不漂移、逐市场建行币种正确、文件后端五市场存取与用户隔离、
  域表 schema 逐市场校验通过且 `MARS` 被拒（此项在修复前是失败的）。
- `tests/offline/repo.test.mjs`：9/9 —— 扫描 60 个发布文件，确认无密钥 / 无作者私人路径、许可完整、CHANGELOG 含 0.6.0、
  12 份文档齐备、README 首屏回答关键问题、存储范围声明齐全、发布标签取自 `package.json`。
- `npm run test:network`：宿主端到端 **95/95 PASS, 0 FAIL**（上游不可达项按 `DEGR` 记，本次 10 项）；
  `npm run verify:install` **6/6 PASS**（链接指向工作区、profile 读到的版本 0.6.0、AI 层直连宿主 `llm` 且不 import 宿主包、
  五市场宿主代码、客户端五市场标记、6 个已发布文件逐字节一致）。两者都非阻断。
- `npm pack --dry-run`：60 files / 286.5 kB（解包 878.4 kB），只含 `lib/`、`docs/`、`tests/`、`cordis.patch.yml`、
  文档与 `package.json`，不含开发探针目录，也没有私人路径。
- 可复现性抽查：把 `DSH_HOME` 指向一个**空目录**再跑 `npm test` → `8 passed, 0 failed, 1 skipped`（exit 0）：
  只有依赖 react 的客户端套件按约定 SKIP（exit 3 被计为 skipped），其余八套件仍全绿，说明离线门禁不依赖作者本机的
  DSH profile、缓存或路径。真实「全新 profile 安装并打开界面」这一条仍需在有 GUI 的干净环境执行（见下文待办）。
- 卫生扫描：发布物（`files[]` 展开）无密钥 / 令牌 / 作者私人绝对路径。

### 已知限制

1. 状态仍是**单机 profile 本地**（按 DSH 用户 id 隔离），不提供跨设备同步；`publicConfig().storage` 与
   `docs/COMPATIBILITY.md` 都写明了这一点。
2. 上游不可达 / 限流 / 区域性 403 仍然是外部事实：插件只保证「不编造、不静默、可诊断」（`DEGRADED`、`partial history`、`stale`）。
3. 日股现金股票无可达历史 K 线源、`^N225` 单源、A 股 / 日股 / 美股公司档案依赖东财 —— 见 `docs/ROADMAP.md` 的下一步。
4. 研究边界不变：**不下单、不持仓、不接入券商、不做组合盈亏**。

### 对照《DSH_Trading_Mode 改进方案》的逐项状态

| 阶段 | 条目 | 状态 | 落点 |
| --- | --- | --- | --- |
| A（P0） | A1 清理发布物 / 密钥 / 私人路径 / `.gitignore` / `LICENSE` | 完成 | `tests/offline/repo.test.mjs` 可执行门禁；`npm pack --dry-run` 60 文件清单核对 |
| A（P0） | A2 README 首屏重写（定位 / 限制 / 安装 / 验证） | 完成 | `README.md` 首屏 + 「它不支持什么」段；本机操作移入 `docs/DEVELOPMENT.md`、`docs/TROUBLESHOOTING.md`，探针实测均标环境与日期 |
| A（P0） | A3 可复现最小测试与单命令入口 | 完成（离线门禁）/ 部分（干净 profile 安装） | `npm test` 九套件离线；`DSH_HOME=` 空目录仍 8 passed + 1 skipped；**全新 profile 安装 + 打开界面仍需你在有 GUI 的干净环境跑一次** |
| A（P0） | A4 支持矩阵 | 完成 | `docs/COMPATIBILITY.md`（市场覆盖、宿主/Node/OS 要求、网络模式）+ README 已知限制 |
| A（P0） | A5 安全 / 许可门禁 | 完成 | `SECURITY.md`；`api.test.mjs` 的 403/401 拒绝、按 userId 隔离；`docs/DATA_SOURCES.md` 的数据源条款与再分发说明；README License 段 |
| B（P1） | B1 配置化 Provider 链 | 完成 | 插件 `providers` 配置 + `providerChains` / `providerChainProblems`（`GET /api/trading/status`） |
| B（P1） | B2 传输策略可插拔 | 完成 | `networkMode: auto \| standard \| compatibility`，默认 `auto` 只在真的出现传输失败后升级 |
| B（P1） | B3 存储模式明确、不承诺跨设备 | 完成 | `publicConfig().storage`（`scope: profile-local`、`crossDevice: false`）+ `docs/COMPATIBILITY.md` |
| B（P1） | B4 失败隔离与可读诊断（供应商 × 能力） | 完成 | `healthScope(provider, feature)`、`status().providers[].scopes`、`degraded` |
| C（P2） | C1 版本标签以 `package.json` 为准 | 完成 | 0.6.0；README 不再出现「策划案 V0.1」 |
| C（P2） | C2 社区文件 | 完成 | `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、issue / PR 模板 |
| C（P2） | C3 CI 离线优先、网络测试非阻断 | 完成 | `.github/workflows/ci.yml`（Node 20/22；阻断 `npm test` + `check`；非阻断 `test:network`） |
| C（P2） | C4 小范围外部试用、开放 Beta | 待你执行 | 需要 2–3 名不使用本机 profile 的试用者；发行说明与检查单已备（`docs/RELEASE_CHECKLIST.md`） |

# 0.7.0 增量交付：入站配额、长任务取消、时效分级与发布门禁

版本号以 `package.json` 为准（`0.7.0`）。这一轮解决的是「一个人用没问题、多客户端或多用户用就会出问题」的部分：
**没有上限的入站请求**、**停不下来的全量扫描**、**把陈旧数据说成实时**、以及**「跳过了也算通过」的测试门禁**。
默认数据源链与既有配置项全部保持兼容，新增的保护在正常使用强度下不可感知（通用配额 240 次/分钟/用户）。

## 1. 需求与范围

| 编号 | 问题 | 本轮处置 |
| --- | --- | --- |
| P0-3 | 测试套件缺前置条件时 `SKIP`，而 `SKIP` 不算失败 —— 「跳过一整类检查」的构建也能绿 | harness 区分必需/可选，`npm run test:release` 把任何 SKIP 判为失败 |
| P0-4 | 入站请求无上限：一个面板脚本、一次误连点就能把上游打爆；全市场扫描没有墙钟上限也没有取消入口 | `API_POLICY` + `lib/trading/limits.js`（配额 + 并发闸，429 + `Retry-After`）；`UNIVERSE_POLICY.budgetMs` + `DELETE /api/trading/universe` |
| P0-5 | 历史数据不足时指标静默降级为 `null`，用户以为「这只股票没有 MA200」 | `technicalQuality()` 分级 + 客户端横幅 + README 能力矩阵 |
| P0-6 / P0-1 / P1-1 | README 过长、把 DSH 工具调用写成终端命令、完整 API 与隐私说明缺失 | README 重写并把 HTTP 契约移入 `docs/API.md`；新增 `docs/PRIVACY.md`、`docs/DATA_COMPLIANCE.md` |
| P1-4 | AI 拿到的快照可能是几小时/几天前的数据，提示词却没有任何时效约束 | 数据年龄分级（live/delayed/stale/historical）+ 系统提示追加时效指令 + 响应带 `meta.dataQuality` |

## 2. 交付内容

| 方向 | 内容 |
| --- | --- |
| 入站配额 | `lib/trading/limits.js`：`QuotaLimiter`（滑动 60 s 窗口；通用 240/用户、1 200/全局；`analyze` 20/60、`brief` 6/30、`universeRefresh` 2/4；**被拒请求不消耗额度**）+ `ConcurrencyGate`（同时在飞的 AI 分析 ≤2，全局 ≤4）。超限 → `429 RATE_LIMITED` + `Retry-After`，且不达 service、不打上游 |
| 长任务 | 目录扫描墙钟预算 15 分钟（`UNIVERSE_POLICY.budgetMs`）；`DELETE /api/trading/universe` 取消；`POST` 透传客户端 abort；结果带 `complete` / `reason`（`budget` / `cancelled` / `incomplete walk`）/ `cancelled` / `budgetMs`；单飞与 `minRestartIntervalMs` 节流保留 |
| 可诊断性 | `GET /api/trading/status` 新增 `limits` 余量快照；`sanitizeStatus()` / `redactDiagnostic()` 把上游 URL 收敛为 `origin/…`、IPv4 变 `[redacted-ip]`、裸主机名变 `[redacted-host]`、绝对路径只留 `…/basename`，且不误伤 provider id 与 `600519.SH` / `BTC-USD` |
| 同源围栏的边界 | `ApiRoutes.fence()` 在宿主未提供 `connection.requestRejection` 时**首次**打一条 `request fence is open` 警告（此前是静默放行）；README 与 `docs/COMPATIBILITY.md` 写明「同源强度 = 宿主认证强度」，并指出此时唯一边界是入站配额、不要把端口暴露给未认证来源 |
| 数据时效 | `RECENCY_DIRECTIVE` 追加进分析与简报的系统提示（原文保留）：非实时数据必须表述为「最后可用数据 / 延迟数据」，禁用 now / today / live；响应新增 `meta.dataQuality = { grade, ageSeconds, stale, staleReason, qualification, historyGrade, historyBars }`；客户端分析卡片在非 live 时显示提示条 |
| 指标可信度 | `technicalQuality(barCount, unavailable)` → `full` ≥200 / `partial` ≥50 / `limited` ≥20 / `insufficient` <20；`computeTechnicals()` 返回值与 `getTechnicals().meta` 均带 `quality`；客户端在历史不足时显示醒目横幅并弱化网格（`tm-grid--muted`） |
| 发布门禁 | `tests/offline/harness.mjs` 支持 `required: false` 与跳过原因；`tests/offline/run.mjs` 汇总每个套件并支持 `--release`；`npm run test:release` 输出 `release gate: PASS — no failures and no skipped checks` 或 `FAIL — a release must not contain failed or skipped checks`；CI 阻断步骤换成 `test:release` |
| 依赖与套件 | `package.json` 增 `zod` 到 devDependencies（自选股套件不再 SKIP）与 `test:release` / `test:limits` 脚本；新增 `tests/offline/limits.test.mjs` |
| 文档 | 新增 `docs/API.md`（完整 HTTP 契约，含本轮配额 / 取消 / 脱敏 / 时效分级）、`docs/PRIVACY.md`（14 节，含浏览器侧 TradingView 嵌入的披露）、`docs/DATA_COMPLIANCE.md`（9 家 provider 逐行审计表 + 逐源发布决策 + TradingView 第三方嵌入单列说明，全部条款标 `not verified`，核实日期 2026-10-10）；重写 `README.md`（安装入口补「拿到目录 → `npm install` → 安装到 profile」、明确 `plugin_manager(...)` 是 DSH 工具调用、新鲜度状态互斥、报价/成交量与指标的来源区分、官方 API / 非官方端点 / 第三方嵌入三类来源）；`docs/COMPATIBILITY.md` 更新为实测环境矩阵；`docs/RELEASE_CHECKLIST.md` 增「仓库历史与密钥扫描」「合规确认」「SKIP 门禁」三节；本报告新增本节 |

## 3. 顺带修掉的两个真实缺陷

两个都由本轮新增的测试抓出来，属于「静默出错」类：

1. **目录统计漏算三个市场**（`lib/trading/universe.js`）。汇总行数原本写作
   `summary.rows = this.loadedCount('US') + this.loadedCount('HK');`，`info().size` 同样只算两个市场 ——
   A 股 / 日股 / 加密的目录行数被静默丢弃（`status()` 用的是 `MARKETS.reduce`，因此两处数字还会互相矛盾）。
   现在统一走 `totalRows()`。
2. **AI 时效分级恒为 `unknown`**（`lib/trading/ai.js`）。`analyzeStock()` 读取的是不存在的
   `input.dataRecency`，正确路径是 `input.data.dataRecency`，于是 `meta.dataQuality` 永远说不清数据有多旧；
   同时 `buildBriefInput()` 用请求组装时刻（`snapshot.asOf`）而不是最旧一行的时间戳定级，刷新一下页面就能把
   2 天前的报价说成 live。两处都已修正，并有回归断言（`tests/offline/ai.test.mjs`）。

另外修了 `redactDiagnostic()` 的二次脱敏：URL 的 origin 会被随后的「裸主机名」规则再吃一次
（曾得到 `https://[redacted-host]/…`）。现在先把 origin 存入占位数组、跑完其余规则再还原。

## 4. 验证

- `npm test`（2026-10-10 实测）：**10 passed, 0 failed, 0 skipped, exit 0** —— syntax 2/2、config 10/10、
  transport 8/8、limits 10/10、router 9/9、api 14/14、watchlist 4/4、ai 21/21、client 25/25、repo 9/9。
- `npm run test:release`：`release gate: PASS — no failures and no skipped checks`，exit 0（同一批检查，额外规则是
  「任何 SKIP 即失败」）。
- `npm run verify:install`：**6/6 PASS**（profile 链接到工作区、profile 读到的版本 `0.7.0`、AI 层走宿主 `llm`
  且不 import 宿主包、宿主半边加载五市场、客户端半边带五市场标记、每个发布文件与工作区逐字节一致）。
- `npm run test:network`（在线探针，非阻断）：**95/95 PASS, 0 failed, 10 degraded**，exit 0 —— 上游不可达项
  （东财 kline/clist `socket hang up`、Yahoo 403 等）按 `DEGRADED` 记账，provider health 全部 `healthy`。
- `npm pack --dry-run`：**65 files / 1 025 589 bytes**，含 `docs/API.md`、`PRIVACY.md`、`DATA_COMPLIANCE.md`，
  非 lib/docs/tests 项只有 CHANGELOG / CONTRIBUTING / LICENSE / README / SECURITY / `cordis.patch.yml` /
  `package.json`，**没有** `.dsh` / `node_modules` / 缓存泄漏。
- 新增/扩展的断言：`limits.test.mjs` 10 项（假时钟验证窗口滑动、被拒请求不消耗额度、user/global 隔离、
  并发闸上限与释放、按桶隔离、`quotaView` 形状）；`api.test.mjs` 14 项（第 241 次请求 429 + `Retry-After`、
  专项额度先于通用额度触发且 quote 不受影响、第 3 个并发分析立即 429、`/status` 脱敏、
  `redactDiagnostic` 五类字符串、无宿主围栏时「开放但只警告一次且仍受配额约束」）；`ai.test.mjs` 21 项
  （时效分级阈值、`qualityFor` 措辞、`RECENCY_DIRECTIVE` 不改写原提示、上述两个缺陷的回归）；
  `config.test.mjs` 10 项（`API_POLICY` / `UNIVERSE_POLICY` 形状与三档时效阈值排序）。
- `repo.test.mjs` 的必需文档清单从 12 项扩到 16 项（新增 `docs/API.md`、`docs/PRIVACY.md`、
  `docs/DATA_COMPLIANCE.md`、`docs/DELIVERY-REPORT.md`）。
- 本轮**没有**改动数据源链、健康度语义、存储契约与既有配置项默认值：上述套件与 `transport` / `router` /
  `watchlist` 的既有断言保持全绿即为回归证据。

## 5. 已知限制（0.7.0）

1. 配额与并发闸是**进程内**的滑动窗口：DSH 重启即清零，多进程部署不会共享计数。对单机 profile 的场景足够，
   对「多实例共享一个上游配额」的场景需要外部限流（本轮不做，已记入 `docs/ROADMAP.md`）。
2. 目录扫描的 15 分钟预算是**墙钟**上限，不是「一定能在 15 分钟内扫完」的承诺；上游慢或某市场无源时仍会
   提前结束并给出 `reason`。
3. 时效分级依赖上游给的 `timestamp`：上游不提供或提供错误时间戳时只能落到 `unknown`，插件不会猜。
4. 研究边界不变：**不下单、不持仓、不接入券商、不做组合盈亏**。
5. 仍然只有单机 profile 本地存储（`scope: profile-local`、`crossDevice: false`），不承诺跨设备同步。
6. 同源保护**不自己实现**：它复用宿主的 `connection.requestRejection(req)`，所以强度等于宿主认证强度。
   宿主没有该服务时围栏是开放的（现在会在第一次请求时打一条 `request fence is open` 警告），此时入站配额
   是唯一边界 —— 不要让未经认证的来源通过反向代理够到这个端口（`docs/COMPATIBILITY.md`「反向代理 / 远程访问」）。

## 6. 对照《DSH_Trading_Mode 修改案2》的逐项状态

| 条目 | 状态 | 落点 |
| --- | --- | --- |
| P0-1 陌生人全新环境安装验收 | 部分完成 | `README.md` 安装章节补齐入口（拿到目录 → `npm install` → `plugin_manager` → 验证）并声明唯一已验证环境；`docs/COMPATIBILITY.md` 给出实测矩阵。**「另一台机器 / 全新 clone + 全新 profile」仍需你或第三方执行** |
| P0-2 第三方行情数据合规审查 | 完成（条款本身待人工核实） | `docs/DATA_COMPLIANCE.md`：9 家 provider 逐行表（host / 市场 / 功能 / 延迟 / 署名 / 合规状态）+ 逐源发布决策（默认全开、可用 `providers` 配置移除）+ `looksBlocked()` 与限流等代码内建规则 + TradingView 第三方嵌入单列说明；所有条款标 `not verified`（未抓取条款原文），`docs/DATA_SOURCES.md` 指向该表 |
| P0-3 发布门禁不允许 SKIP | 完成 | `tests/offline/harness.mjs`、`run.mjs --release`、`npm run test:release`、CI 阻断步骤 |
| P0-4 入站配额 / 限流 / 长任务取消 | 完成 | `lib/trading/limits.js`、`API_POLICY`、`UNIVERSE_POLICY`、`DELETE /api/trading/universe`、`tests/offline/limits.test.mjs` 与 `api.test.mjs` |
| P0-4⑤ 反代 / 远程访问下的「同源」 | 完成（行为按设计） | `docs/COMPATIBILITY.md`「反向代理 / 远程访问」节 + `fence()` 缺失宿主围栏时的单次警告 + README 同源说明 |
| P0-5 指标历史不足要显式告知 | 完成 | `technicalQuality()`、`getTechnicals().meta.quality`、客户端横幅、README 能力矩阵 |
| P0-6 确认 GitHub 发布内容 | 部分完成 | `repo.test.mjs` 卫生扫描（16 份必需文档、密钥 / 作者路径 / 机器状态）、`docs/RELEASE_CHECKLIST.md` 新增仓库历史与密钥扫描节、`npm pack --dry-run` 65 files 无泄漏。**仓库尚未创建，无法核对 git 历史** |
| P1-1 / P1-2 文档与措辞 | 完成 | `README.md` 重写（DSH 工具调用而非终端命令、支持矩阵、卸载、FAQ）；新鲜度状态互斥、报价/成交量与指标来源区分、三类来源性质、版本号一律取自 `package.json` |
| P1-3 本地数据、删除与隐私 | 完成 | `docs/PRIVACY.md`（存储位置 / 是否发给 AI / 卸载残留 / 删除步骤 / 匿名 ID 的作用与局限）+ README 隐私节 |
| P1-4 陈旧数据的表述约束 | 完成 | `RECENCY_DIRECTIVE`、`recencyOf/qualityFor`、`meta.dataQuality`、客户端提示条 |
| P1-5 长时间板块抓取的用户控制 | 完成 | 预算 / 取消 / 单飞 / 节流四项都在实现里，并写进 `docs/API.md` 与 README |
| P2 开源社区体验（截图 / 模板 / 英文 README / 徽章 / 自动发布） | 未开始 | 按修改案建议，等有真实 Beta 用户后再做 |
| 干净 profile 安装 + 打开界面 | 待你执行 | 见 `docs/RELEASE_CHECKLIST.md` §7；需要一个有 GUI 的全新 profile |
| 小范围外部试用（2–3 人） | 待你执行 | 沿用 0.6.0 的 C4 待办 |

---

# 0.8.0 增量交付：fail closed 围栏、诚实身份与可复现发布

> 本节是 §79 报告在 **0.8.0**（2026-10-10）上的增量；前面 0.5.0 / 0.5.1 / 0.6.0 / 0.7.0 各节记录历史基线，
> 其中提到的围栏「缺了就开放」、身份回落到 `local`、freshness 用 `live` 等行为**已被本节取代**。
> 需求来源：《DSH_Trading_Mode 修改案3.md》（m06819）；审计判定与证据见 `docs/AUDIT-ROUND3.md`。

## 1. 需求与范围

修改案3 的主题是「别猜、别漏、别蒙」：先把**宿主到底提供了什么**查清（不假设宿主会兜底），再把三件事做实 ——
① 宿主请求围栏缺失时**必须 fail closed**；② 按用户存储**不再回落到共享桶**；③ 时效措辞不再暗示实时。
同时把发布工程补到可复现：lockfile、CI 的 `npm ci`、**对最终工件**的冒烟、发布门禁不允许 SKIP。

本轮**不做**：不新增交易功能、不新增市场、不改 provider 端点与缓存 TTL 取值、不发布到任何 registry、
不创建远程仓库、不生成示意图或占位截图。

## 2. 交付内容

| 面 | 落点 | 说明 |
| --- | --- | --- |
| 围栏 fail closed | `lib/trading/api.js` | `connection` 缺失 / `requestRejection` 缺失 / 该函数抛错 → 除 `GET /api/trading/health` 外一律 503 `HOST_SECURITY_UNAVAILABLE`，且在入站配额、service、store 之前拒绝；日志 `refusing <METHOD> <path>`，`fenceFailures` 计数；403/401 分别映射 `FORBIDDEN` / `UNAUTHENTICATED`；`undefined` / `null` / `false` 才是放行值 |
| 存活探针 | `GET /api/trading/health` | 唯一免围栏端点（围栏之前应答）、仅 GET、不触上游、不写存储、不消耗配额；只返回 `{plugin, version, api, fence, identity, note}` 六字段，其中 `identity` 只发布来源不发布 id 值 |
| 本机调试例外 | `API_POLICY.requireHostFence` + `security.allowUnfencedLoopback` | 默认 `false`；只有**显式**配置为 true 且对端是回环地址才放行，启动与每次放行都以 error 级 `SECURITY` 记日志；取非布尔抛 `security.allowUnfencedLoopback must be true or false (got …)` 并保持默认；`API_POLICY` 常量始终是出厂默认值，运行时用 `allowUnfencedLoopback()` 读取 |
| 身份策略 | `IDENTITY_POLICY` + `lib/index.js resolveIdentity()` | 解析顺序：宿主 `@deepseek-ai/dsh-anonymous-user-id` → 操作者显式声明的 `identity.localBucket`（单用户） → **无身份**（插件不自行发明身份）；`/status` 与 `/bootstrap` 新增 `identity: {id, source, persistent, storesPerUserData}` |
| 无身份时的拒绝 | `lib/trading/api.js` | watchlist / settings 的写路径（及按用户计量的路径）→ 503 `NO_IDENTITY`；只读行情端点照常；`userId: null`、`settings.storage: "no-identity"`；**绝不读共享桶** |
| 时效改名 | `lib/trading/ai.js`、`config.js`、`client.js` | 最年轻档 `live` → `fresh`（`AI_CONFIG.freshMaxAgeMs`）；`now` / `today` / `live` 的禁用改为与 grade 无关的硬约束；客户端区分 `delayed` 与「无法判定数据年龄」 |
| 客户端文案 | `lib/client.js` | `HOST_SECURITY_UNAVAILABLE`、`NO_IDENTITY`、`FORBIDDEN`、`UNAUTHENTICATED` 均有中英说明；无身份时自选卡片显示醒目提示 |
| 工件冒烟 | `scripts/smoke-artifact.mjs`（`npm run smoke:artifact`） | 打包到系统临时目录后**只审计不安装**：tar 头与校验和、版本与 `package.json` 一致、必需成员齐全、条目无机器状态、每个文本文件无机器路径、每个打包的 `lib/**/*.js` 过 `node --check`；末行 `verdict: SHIPPABLE` 并打印 tarball `sha256` 与体积 |
| profile 只读检测 | `scripts/inspect-profile.mjs`（`npm run inspect:profile`） | 只读报告每个 profile 是否安装本插件、是否指向本 checkout、装的是哪个版本、`lib/index.js` 的 sha256 是否一致；退出码 0 已安装 / 1 未安装或不存在 / 2 参数错误 |
| 发布工程 | `package-lock.json`、`.github/workflows/ci.yml`、`docs/RELEASING.md` | lockfileVersion 3（7 个 dev 依赖，全带 `integrity`）；CI 改为阻断式 `npm ci --legacy-peer-deps` + `check` + `test:release` + `smoke:artifact`，在线探针非阻断；205 行 runbook |
| 合规与协作模板 | `docs/DATA_COMPLIANCE.md`、`.github/ISSUE_TEMPLATE/*`、`docs/RELEASE_TEMPLATE.md`、`docs/screenshots/README.md` | 逐源条款与访问方式明细，46 处显式 `not verified`（带核查日期与检索词）；只接受真实截图的政策 |

## 3. 两处行为不兼容（0.8.0）

1. **缺宿主围栏即拒绝**：0.7.0 在 `connection` 缺失时放行并打一条警告；0.8.0 返回 503
   `HOST_SECURITY_UNAVAILABLE`（唯一例外是显式开启的回环调试开关）。这是本轮唯一与安全相关的行为不兼容。
2. **无身份即拒绝写**：0.7.0 身份解析失败会回落到字面量 `local`（所有浏览器共用一个桶）；0.8.0 直接
   503 `NO_IDENTITY`，单用户部署需要在配置里显式声明 `identity.localBucket`。

## 4. 验证（2026-10-10 实测）

- `npm test`：**`13 passed, 0 failed, 0 skipped`**，共 **150 项检查** —— syntax 2、config 11、transport 8、
  limits 10、router 9、api 14、fence 8、identity 7、watchlist 4、ai 21、client 25、release-scripts 22、repo 9。
- `npm run test:release`：`release gate: PASS — no failures and no skipped checks`，exit 0。
- `npm run check`：2/2（`lib/**/*.js` 32 个文件存在且 `node --check` 全部通过）。
- `npm run smoke:artifact`：**SHIPPABLE，14/14 PASS**，打包 **74 files**；73 个文本文件扫描无机器路径、
  32 个打包 `lib/**/*.js` 解析通过，无符号链接条目；脚本每次打印 tarball `sha256` 与体积（本目录不是 git 仓库，
  这个 sha256 就是溯源记录）。
- `npm run verify:install`：**6/6 PASS** —— profile 通过 junction 指向本工作树、profile 读到的版本 `0.8.0`、
  安装的 AI 层直连宿主 `llm`（路由 `deepseek-official/deepseek-flash`）且不 import 宿主包、宿主半边加载五市场
  （indices 15）、客户端半边带五市场标记（115 KB）、每个发布文件与工作树逐字节一致。
- `npm run inspect:profile`：`1/2 profile(s) load this checkout`（`desktop` 已装；`web` 声明了依赖但
  `node_modules` 条目缺失，被如实报为 problem 而不是猜测）。
- `npm run test:network`（非阻断）：**95/95 PASS, 0 failed, 10 degraded**，exit 0；上游不可达项按 `DEGRADED`
  记账，provider health 全部 `healthy`。
- `npm pack --dry-run --json`：**74 files**，非 lib/docs/tests/scripts 项只有 CHANGELOG / CONTRIBUTING / LICENSE /
  README / SECURITY / `cordis.patch.yml` / `package.json`；**没有** `.dsh` / `node_modules` / 缓存泄漏。
  （`package-lock.json` 不进 tarball 是 npm 的既定行为：发布的依赖锁是 `npm-shrinkwrap.json`，lockfile 留在仓库里。）
- 新增/扩展断言：`fence.test.mjs` 8 项（含 loopback 开关的校验、告警与远端仍拒绝）、`identity.test.mjs` 7 项、
  `release-scripts.test.mjs` 22 项（含两个**负控制**：删掉 `lib/client.js` 的副本必须让 smoke 失败、植入机器路径的
  副本必须被抓到；以及 `inspect-profile` 的只读证明：运行前后逐文件 `path|size|sha256` 深度相等）。
- 回归证据：数据源链、健康度语义、缓存 TTL、存储契约与既有配置默认值**未改**，`transport` / `router` /
  `watchlist` / `api` 既有断言保持全绿。

## 5. 已知限制 / 未验证

1. **CI 的首次真实运行未验证**：本机没有任何可达 registry（`zod-3.25.76.tgz` 也不在本机缓存），
   因此 `npm ci --legacy-peer-deps` 只在 `--dry-run --offline` 下验证过；Node 20/22 矩阵与 runner 上的
   工件冒烟必须等 CI 真正跑过才算证据。
2. 回环调试开关只应在本机端口不可从外部到达时使用；它会跳过宿主围栏，本身不提供任何认证。
3. 配额与并发闸仍是**进程内**记账（重启清零、多进程不共享）；身份解析失败只降级为「无身份」而不是崩溃。
4. 九家上游条款仍为 `not verified`（本环境读不到可引用条款文本），需要一次能在浏览器/终端访问条款页的收尾。
5. 真实界面截图政策已定但暂无截图；公开下载位置（GitHub/registry）与远程安装路径仍不可验证 ——
   两者都需要用户侧动作。

## 6. 对照《DSH_Trading_Mode 修改案3》的逐项状态

| 条目 | 状态 | 落点 |
| --- | --- | --- |
| P0-a 安装路径（不编造下载位置） | 完成（远程路径按未验证处理） | `README.md` 安装三步只用 `plugin_manager({action:"install_bundle", target:<绝对目录>})`；`docs/AUDIT-ROUND3.md` 记录「路径 B 与宿主指引冲突，不采用」 |
| P0-b 宿主围栏 fail closed | 完成 | `lib/trading/api.js`（fail closed + `GET /health`）、`tests/offline/fence.test.mjs` 8 项、`docs/API.md` / `docs/PRIVACY.md` / `docs/COMPATIBILITY.md` |
| P0-c 发布物与 CI 可复现 | 完成（runner 首跑未验证） | `package-lock.json`、`.github/workflows/ci.yml`、`scripts/smoke-artifact.mjs`、`docs/RELEASING.md`、`docs/RELEASE_CHECKLIST.md` §1/§1b/§1c/§1d |
| P0-d 逐源合规明细 | 完成（条款本身待人工核实） | `docs/DATA_COMPLIANCE.md`（46 处 `not verified`）、`docs/PRIVACY.md`、MIT 范围只覆盖本项目源码 |
| P1⑤ 时效措辞不再暗示实时 | 完成 | `live` → `fresh`、与 grade 无关的 `now`/`today`/`live` 禁用、客户端提示条 |
| P1⑦ 不再共用身份桶 | 完成 | `IDENTITY_POLICY` + `resolveIdentity()` + `tests/offline/identity.test.mjs` 7 项 |
| P1⑨ Node 版本是声明不是结论 | 完成（文档口径） | `README.md` 兼容性节、`docs/COMPATIBILITY.md` 实测矩阵 |
| P1⑩ 日股不与其它市场并列 | 完成（文档口径） | `README.md` 使用限制 + 能力矩阵把 JP 标为「不保证且明显弱于 US/HK/CN」 |
| P2 社区体验（截图/徽章/自动发布） | 部分完成 | 模板与截图政策已就位；真实截图、外部试用与自动发布待用户侧 |
| 干净 profile 安装 + 打开界面 | 待你执行 | `docs/RELEASE_CHECKLIST.md` §7；需要一个有 GUI 的干净 profile |
| 小范围外部试用（2–3 人） | 待你执行 | 沿用 0.6.0 的 C4 待办 |

# 0.8.1 增量交付：可切换配色与不透明面板

> 本节是 0.8.0 报告在 **0.8.1**（2026-10-16）上的增量；上文 0.5.0 / 0.5.1 / 0.6.0 / 0.7.0 / 0.8.0 各节
> 记录历史基线，数字（如 `client 25/25`、离线 150 项）保持当时实测值不动。

## 1. 需求与交付

用户原话：「我希望你把页面改成黑色背景白色字体与白色背景黑色字体可切换，不要让对话框透明影响观感」
（m11109）。两句要求分别对应下面两件事，都落在客户端半边 `lib/client.js`：

| 需求 | 交付 |
| --- | --- |
| 黑底白字 ↔ 白底黑字可切换 | 面板头部新增 `ThemeToggle`（`role="group"`、`aria-pressed`、中英双语「深色 / 浅色」），浮层根节点在 `tm-scheme--dark` / `tm-scheme--light` 之间切换；`dark` = `--tm-bg:#000000` + `--tm-text:#ffffff`，`light` = `--tm-bg:#ffffff` + `--tm-text:#101014` |
| 对话框不再透明 | 面板所有表面改由**自有不透明调色板**上色：`.tm-window` 用 `var(--tm-bg, #000000)`、`.tm-status__pop` 用 `var(--tm-overlay, #111116)`，卡片 / 输入框 / 表格 / 弹出层同理；宿主别名 token 只在 `.tm-layer` 作用域内被**映射**，不再直接决定背景 |

## 2. 根因（为什么以前会透明）

旧代码的窗口底色是 `background: var(--dsw-alias-bg-overlay, #131313)`。当该别名在当前主题作用域内
**没有定义**时（自定义主题的 `ThemeDefinition.tokens` 只登记了一部分 token，或浮层落在主题作用域之外），
CSS 的处理是 *invalid at computed-value time*：**fallback 不生效、该声明整条失效**，于是背景回落到
`transparent`，背后的对话就透上来 —— 这正是「对话框透明影响观感」的机制，而不是内置浅色主题缺值
（app.asar 内置 light/dark 两个块里 `--dsw-alias-bg-overlay` 分别解析为不透明的 `#e9ecf2` / `#61666b`）。
0.8.1 因此不再把「窗口是否可见」建立在宿主 token 链上：调色板是插件自己的字面 hex，`transparent` 不可能再出现。

## 3. 行为变更

1. **新增**：主题开关（此前只能跟随宿主）。
2. **变更**：面板配色不再随宿主主题变化（本来就是纯黑白两色）；宿主提供客户端 `theme` 服务时，
   绑定阶段会读取 `getTheme().active.colorScheme` 采纳当前配色，并订阅 `theme/change` 跟随宿主切换。
3. **用户显式选择优先**：点过一次开关后（`themeSet: true`）不再被宿主快照覆盖，且该选择通过
   `service.setTheme('dark' | 'light')` 写回 **DSH 自己的主题设置**，由宿主持久化。宿主没有该服务时
   全部静默降级为面板内切换（仅本会话生效），不报错、不影响加载、不写任何插件存储。
4. **无 API 变更**：`/api/trading/*` 的所有端点、错误码与存储契约与 0.8.0 完全一致。

## 4. 验证（2026-10-16 实测）

- `npm test` / `npm run test:release`：**`13 passed, 0 failed, 0 skipped`**，共 **153 项检查** ——
  syntax 2、config 11、transport 8、limits 10、router 9、api 14、fence 8、identity 7、watchlist 4、
  ai 21、**client 28**（25 → 28）、release-scripts 22、repo 9；`release gate: PASS`，exit 0。
- 新增 3 项客户端检查：① 开关渲染与 `tm-scheme--*` 互斥类；② 宿主配色被跟随、直到用户显式选择（含
  `setTheme` 调用、dispose 取消订阅、无服务/`get` 抛错都能降级）；③ **静态 CSS 断言** —— 两套调色板存在、
  `.tm-window` / `.tm-status__pop` 不透明且不含 `--dsw-alias-`、所有仍被引用的宿主别名都已在映射块里定义
  （实测 `8 alias tokens mapped, 22797 CSS chars`）。
- `npm run check`：2/2（32 个 `lib/**/*.js` 通过 `node --check`）。
- `npm run smoke:artifact --json`：**SHIPPABLE，14/14 PASS**，`version 0.8.1`、74 files、全部被打包的
  `lib/**/*.js` 解析通过、73 个文本文件无机器路径；tarball 的 `sha256` 与体积由脚本每次打印
  （本文件不固化该值 —— 文档本身也在 tarball 里，任何一次文字改动都会改变它，逐次输出才是溯源记录）。
- `npm run verify:install`：**6/6 PASS**（profile junction → 工作树、版本 `0.8.1`、AI 层直连宿主 `llm`、
  五市场、客户端半边 124 KB、逐文件与工作树逐字节一致，`client.js:9cc05ce462a76418`）。
- 未改动的既有断言全部保持全绿：`transport` / `limits` / `router` / `api` / `fence` / `identity` /
  `watchlist` / `ai` / `release-scripts` / `repo` 与 0.8.0 基线一致。

## 5. 已知限制

1. 面板是**非模态**浮层（`pointer-events: none` 的容器 + `auto` 的窗口）：0.8.1 只保证窗口自身不透明，
   **没有**给背后聊天加变暗遮罩，也没有抢走点击。若需要「模态 + 背景变暗」是另一个改动。
2. 浅色方案是**新增的一套手工调色**，只在本地由静态断言与人工目视覆盖；没有跨主题视觉回归测试。
3. 宿主 `theme` 服务是可选 peer：它不存在时配色只在本会话生效（README/PRIVACY 已如实写明）。

## 6. 对照需求（m11109）

| 要求 | 状态 | 落点 |
| --- | --- | --- |
| 黑色背景白色字体 ↔ 白色背景黑色字体可切换 | 完成 | `lib/client.js` 的 `ThemeToggle` / `THEME_SCHEMES` / `effectiveTheme` / `persistTheme` + `client.test.mjs` 3 项 |
| 对话框透明影响观感 | 完成（根因去除） | 自有不透明调色板 + 宿主别名映射；静态 CSS 断言禁止 `--dsw-alias-*` 直接充当窗口背景 |
