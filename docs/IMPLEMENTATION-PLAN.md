# Implementation Plan（§78）

> 本文件是 V0.1 重开发的**计划记录**（plan of record）。按 §78 要求，编码前应先输出本计划；
> 实际执行中先完成环境侦察（DSH 宿主 Service 清单、路由/存储/LLM/槽位契约、数据源连通性），
> 再把侦察结论回填到下方各项，然后一次性完成整个 MVP（§78 明确要求不要逐阶段等待人工确认）。

---

## 1. 当前 DSH Trading 相关项目结构（改造前）

```
dsh-trading-mode/
├─ package.json          # v0.1.0；dsh.bundle.patch + dsh.client.platform=web
├─ cordis.patch.yml      # - insert: [{ id: trading-mode, name: 'dsh-trading-mode' }]
├─ client.js             # 引擎目录下的旧「动态插件」副本（不在 files/exports 中 = 死代码）
├─ lib/
│  ├─ index.js           # 宿主：注册 web fetch provider(binance) + tools.market_data
│  ├─ client.js          # 浏览器：会话标题栏按钮 + shell.overlay 浮层 + TradingView iframe
│  └─ trading/           # 早期铺垫的核心库（未接入宿主）
│     ├─ config.js  errors.js  http.js  schema.js  symbols.js  sessions.js
│     ├─ cache.js   indicators.js  log.js
│     └─ providers/{index,yahoo,stooq}.js
└─ README.md
```

宿主机位（已侦察确认）：`webServer` / `web` / `llm` / `storage` / `storageDomain` / `tools` /
`agentDefaultModel` / `settings` / `clientModules` / `connection` 等；**没有 DB / ORM / Redis / User 表**。

## 2. 可复用模块（保留、原地增强）

| 模块 | 复用方式 |
| --- | --- |
| `lib/trading/config.js` | 作为唯一配置源；补 `providerConfig.intervals`、东财 `ulistPath/historyBase/searchUrl`、`RECOMMENDED_STARTERS`、`candleLimit()` |
| `lib/trading/http.js` | 全局 `httpGet`（超时/重试/退避/限流/GBK 解码/`looksBlocked`）+ `RateLimiter` + `ProviderHealth` |
| `lib/trading/errors.js` | `TradingError` + `CODES` + `badRequest/notFound/unavailable/aiUnavailable/looksBlocked` |
| `lib/trading/sessions.js` | 开盘判定与新鲜度分级（`marketStatus`/`gradeFreshness`，美国/香港时区） |
| `lib/trading/symbols.js` | 标的标准形（`0700.HK`）+ provider key 映射 |
| `lib/trading/schema.js` | `MarketDataProvider` 基类 + `makeQuote/makeCandles/makeProfile` 归一化（补 `supportsInterval`） |
| `lib/trading/indicators.js` | 纯函数指标库 + `computeTechnicals()` |
| `lib/trading/cache.js` | 带 TTL/新鲜度/持久化的缓存（补 `backendName`） |
| `lib/client.js` | 沿用既定加载契约与 `shell.overlay` 挂载点，**保留 TradingView 内嵌图表能力** |

## 3. 需要新增的模块

```
lib/trading/providers/eastmoney.js   # 东方财富（本环境实际主力源：search/quote/candles/profile）
lib/trading/providers/tencent.js     # 腾讯（备用：quote + 日/周 K 线，GBK）
lib/trading/router.js                # MarketDataRouter：按 feature/market/interval + health 选源与降级
lib/trading/directory.js             # Symbol Directory（统一符号/中英文名/别名，§23）
lib/trading/service.js               # MarketDataService：编排 Provider + 缓存 + 指标 + 信封(meta)
lib/trading/watchlist.js             # WatchlistStore：绑定 DSH User ID，storage-domain 优先、JSON 兜底
lib/trading/ai.js                    # TradingAi：System Prompt + 结构化 JSON 解析 + 重试 + Brief
lib/trading/api.js                   # /api/trading/* 前缀路由（裸 node:http handler）
lib/trading/persist.js               # 行情缓存磁盘持久化（可选、失败不致命）
lib/index.js                         # 宿主重写：装配 Service/Watchlist/AI/Routes
lib/client.js                        # 客户端重写：Home / Detail / Chart / AI / TradingView
```

## 4. 数据库变化

DSH **没有数据库**，因此用 `@deepseek-ai/dsh-storage-domain` 定义**一个 domain**：

- `trading_watchlist` **v1**，`layout: 'single'`，`invalidRecords: 'backup-and-skip'`
- 表：`items`（行 = §12 字段：`id,userId,symbol,market,name,nameZh,exchange,currency,position,isFavorite,createdAt,updatedAt`）
- 无 SQL migration；未来加字段 → `version: 2` + `compatibleVersions: [1]`
- 兜底：storage-domain 不可用时写 `$DSH_HOME/trading-mode/watchlist.json`（临时文件 + rename 原子写）
- 行情缓存：进程内 LRU（上限 4000 条）+ 可选 `$DSH_HOME/trading-mode/market-cache.json`（≤4MB）

## 5. API 变化

新增自有**前缀路由** `ctx.webServer.register({ kind:'prefix', path:'/api/trading' })`（比网关的 `/api` 更长 → 必然优先命中），
handler 内复用 `connection.requestRejection(req)` 做与网关一致的 Host/Origin/认证校验（403/401），统一信封
`{ok:true,value}` / `{ok:false,error}`：

```
GET    /api/trading/            GET /bootstrap              # 首页一次拉齐
GET    /api/trading/status
GET    /api/trading/search?q=&market=
GET    /api/trading/quote/:symbol
GET    /api/trading/candles/:symbol?interval=&range=        # 含 technical（§28 图表与指标一次给全）
GET    /api/trading/chart/:symbol?…                         # 同 candles 别名
GET    /api/trading/profile/:symbol
GET    /api/trading/technical/:symbol                       # = /indicators/:symbol
POST   /api/trading/analyze/:symbol                         # §35 结构化 JSON
GET    /api/trading/watchlist[?quotes=1]
POST   /api/trading/watchlist            {symbol, market?}
PATCH  /api/trading/watchlist/order      {symbols:[…]}
POST   /api/trading/watchlist/analyze    {} | {symbols:[…]}  # §38 Brief
GET|DELETE|PATCH /api/trading/watchlist/:symbol  {isFavorite}
```

## 6. Market Provider 实现方案

`MarketDataProvider` 子类，统一 4 方法 `searchStocks/getQuote/getCandles/getCompanyProfile`，
`capabilities` + `markets` + `intervals` 自述能力；新增 `intervals` 用于路由过滤。

| Provider | 角色 | 能力 |
| --- | --- | --- |
| `yahoo` | §5.1/§5.2 指定 Primary | 全能力（本机网络 403，见「已知偏离」） |
| `stooq` | §5.3 历史兜底 | quote/candles/profile（本机 403） |
| `eastmoney` | 实际主力 | search/quote/candles/profile 全开，US+HK，5m–1wk |
| `tencent` | 备用 | quote + 1d/1wk K 线（GBK；分钟端点与搜索不可用） |

- `MARKET_DATA_CONFIG`：US/HK 均为 `{ primary:'yahoo', historicalFallback:'stooq', chain:['yahoo','eastmoney','tencent','stooq'] }`
  —— **切换正式 Vendor 只改这一处 + 新增一个 Provider 文件**（§7/§51）。
- `MarketDataRouter`：按 chain × 能力 × 区间 × 健康度候选；连续 3 次失败进入 60s 冷却；
  全部不健康时对「最久未探测」的 provider 半开探测；成功即恢复。全部失败按 `NOT_FOUND → DATA_UNAVAILABLE →
  UPSTREAM_BLOCKED` 语义归一。
- 关键实现约束（实测得出）：东财 K 线**必须带 `beg=YYYYMMDD`**（只给 `lmt` 返回 `data:null`），
  `fqt=1` 前复权在老数据上会出负价 → 检测 `close<=0` 自动 `fqt=0` 重取；分钟线时间戳是**北京墙钟**；
  腾讯必须 `decode:'gbk'`，币种不能用 idx35。

## 7. Cache 方案

- key 严格按 §41：`quote:{symbol}` / `candles:{symbol}:{interval}:{range}` / `profile:{symbol}` / `technical:{symbol}` / `search:{market}:{q}`
- TTL 分级（全部在 `config.js`，不硬编码在 UI）：开盘 `open`（quote 短、candles 稍长）/ 休市 `closed`（长 TTL）+ `maxStaleAge`
- `through(key,{ttlMs,allowStale,force},loader)`：命中即 `cached=true`；上游失败且存在过期条目 → 返回 `stale=true` + `staleReason`；
  超 `maxStaleAge` 才丢弃 → `DATA_UNAVAILABLE`
- 公共行情按 key 全局共享（§13：多用户关注同一标的只抓一次）；私人 Watchlist 单独存
- 可选磁盘持久化 `persist.js`：启动 `hydrate()`、批量去抖保存、失败只 warn

## 8. Quant Engine 方案

纯函数实现，**只在服务端计算**（§4：DeepSeek 不算指标）：

- 计算基座固定用 `1d × 1y`（≈252 根日线），保证 MA200 / 52 周高低可用
- 指标：MA5/10/20/50/60/200、EMA12/26、RSI14、MACD(12,26,9)+Signal+Histogram、ATR14、20D 均量、
  Volume Ratio、52 周高低、5D/1M/3M/1Y 涨跌、价格与各均线偏离、距 52W 高低%、波动率、均线排列(`trendAlignment`)、
  摆动高低点(`pivots`) → support/resistance
- 不足 bar 时字段返回 `null` 并记入 `unavailable[]`，**绝不猜值**

## 9. DeepSeek 接入方案

- `inject: ['connection','webServer']`；LLM 从 `ctx.get('llm')` 取（`@deepseek-ai/dsh-llm`），
  模型解析顺序：显式配置 → `agentDefaultModel.currentSelection()` → 扫 `llm.listProviders()/listModels()` 找 DeepSeek
- 调用：`createUserMessage()` + `BlockAssembler` 逐 chunk 组装 → 按 `finish.kind` 分类
  （`aborted/error/max-tokens/非 stop` → 失败码）；`RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE/AI_INVALID_OUTPUT` 可重试
- **只投喂归一化数据**：`buildStockInput()` 产出的 JSON 仅含 symbol/company/quote/technical/levels/recentDailyCloses/
  asOf/marketSessionOpen，**不含任何上游原始响应**（§4/§16）
- System Prompt 原文使用 §34（12 条规则）与 §40（Brief 6 条 + 禁止 Portfolio 措辞）
- 输出强制结构化 JSON（§35/§38），`repair()` 去 ```json 围栏并截取首个 `{`…末个 `}`；缺字段填 `Unavailable.`
- LLM 不可用时 `AI_UNAVAILABLE`，UI 明确提示，绝不回落成「编造分析」

## 10. Trading UI 修改方案

- 挂载点不变：`conversation.session.header.actions`（「Trading Mode」按钮）+ `shell.overlay`（全帧浮层，
  `pointer-events` 只在实际控件上打开）；状态放在模块级 store，两个 slot 共享
- Home：Search Stocks + My Watchlist（价格/涨跌%/时间戳/收藏/排序/删除）+ `[+ Add Stock]` + AI Watchlist Brief
- Detail：公司名/symbol/交易所/价格/涨跌%/`Updated HH:MM:SS`/区间 `1D 5D 1M 3M 6M 1Y 5Y`/自绘 SVG K 线 + MA20/50/200 +
  Market Data + Technical（§29 全量）+ AI Analysis（Trend/Momentum/Volume/Support/Resistance/Risk/Observations）
- **保留** TradingView 内嵌图表开关（`widgetembed` iframe）；不保留旧的 Binance 硬编码
- §21 措辞：永远显示 `Updated …` + `Data may be delayed`（缓存过期时 `Last available data`）；
  全文不出现 Live / Real-time / Tick-level；§26 不出现 Portfolio / Holdings / Profit-Loss
- 自绘 SVG 而非引入图表库：客户端 bundle 无法解析任意 npm 依赖（只有 10 个平台种子）

## 11. 测试方案

1. **宿主离线端到端**（`.trading-research/test-host.mjs`，直接跑真实网络栈，不依赖 DSH 进程）：
   Provider 搜索/行情/K 线/区间/指标、缓存命中与过期兜底、Watchlist CRUD+排序+用户隔离+重启恢复、
   路由注册/派发/方法守卫、§16 不泄漏原始载荷、§44 单 provider 故障切换 → **63 项**
2. **客户端冒烟**（`.trading-research/test-client.mjs`）：用真实 React 18 `renderToString` 执行 bundle，
   校验加载契约/槽位注册/样式清理/TradingView 符号映射/格式化/几何/§27 区块/§31 网格/§21 禁用词 → **14 项**
3. **部署验证**：拷贝进 profile 后重启 DSH，在浏览器里按 §67–§74 验收清单逐条走查
4. §77.21 指定必测标的：**AAPL / NVDA / TSLA / 0700.HK / 9988.HK**

## 执行顺序（实际）

侦察（路由/存储/LLM/槽位/数据源连通性）→ 核心库对齐 → Provider + Router + Directory + Service →
Watchlist/AI/API/宿主装配 → 宿主测试转绿 → 客户端重写 → 客户端测试转绿 → 安装到 profile → 文档。

## 已知偏离（与策划案的差异，均为环境事实驱动）

1. **Yahoo Finance / Stooq 在本机网络下全返回 403**，§5.1/§5.3 指定的 Primary/Fallback 无法实际出数。
   已按 §77.24 **不绕过 Provider 抽象**：保留 `yahoo`/`stooq` 两个 Provider 实现与 chain 声明，
   由 `eastmoney`（主力）→ `tencent`（备用）实际服务；网络恢复或换 Vendor 时只改 Provider 层/配置。
2. 策划案 §41 建议「复用 DSH 已有 Redis」——**DSH 实际没有 Redis**，改用进程内 LRU + 可选 JSON 持久化。
3. 策划案 §10-12 要求 Watchlist 绑定 **DSH User ID**——DSH 无多用户体系，用
   `getOrCreateAnonymousUserId()`（harness 级 UUID）作为 user_id。
4. `delaySeconds` 无法从东财/腾讯确证 → 保持 `null` 并始终提示数据可能延迟（不谎称实时）。
