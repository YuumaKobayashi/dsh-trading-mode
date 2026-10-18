# Trading Mode HTTP API（dsh-trading-mode 0.8.1）

插件与 DSH Web 面板之间只有一套 JSON 接口：前缀 `/api/trading`，方法限 `GET`/`POST`/`PATCH`/`PUT`/`DELETE`。下文按 `lib/trading/*.js` 的实现列出端点、参数校验、返回形状与错误码。

## 认证与来源校验（0.8.0 起 fail closed）

每个请求先过一道围栏：`handle()` 调 `this.fence(req)`，后者把结论交给 DSH 宿主 `connection.requestRejection(req)`。

- 宿主判定 `403` → 立即以 `FORBIDDEN` 结束，不触达业务代码：

```json
{"ok": false, "error": {"code": "FORBIDDEN", "message": "this request did not pass the DSH host/origin check"}}
```

- 宿主判定 `401` → `UNAUTHENTICATED`（message `no authenticated DSH browser session for this request`）。
- 宿主放行（`requestRejection` 返回 `undefined`/`null`/`false`）→ 正常分发。
- **没有宿主围栏时不再放行**：`connection` 缺失、`connection.requestRejection` 缺失、或该函数抛错，都会让除 `GET /health` 外的每个端点回答 503 `HOST_SECURITY_UNAVAILABLE`，且请求在入站配额、service、store 之前就被拒（日志里带 `refusing <METHOD> <path>`，`fenceFailures` 计数增加）。这与 0.7.0 不同：0.7.0 在缺少 `connection` 时是放行的。

唯一例外是显式开启的调试口：配置 `security.allowUnfencedLoopback: true` 后，**只**接受回环对端（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）的无围栏请求，并在首次放行时以 `SECURITY` 级别打日志点名。该开关默认 false（`API_POLICY.allowUnfencedLoopback`）。

```json
{"ok": false, "error": {"code": "HOST_SECURITY_UNAVAILABLE", "message": "Trading Mode refuses <METHOD> /api/trading<path>: the host request fence is unavailable (…) and the loopback debugging exception is off"}}
```

数据归属同样不再是猜测：watchlist 与 settings 都用当前**身份**（宿主 `getOrCreateAnonymousUserId()` 的匿名 id，或操作者显式声明的 `identity.localBucket`）。**没有任何端点接受调用方自报的 user id**，请求体里的 `userId` 会被忽略；身份解析失败或缺失时不会回退到共享桶，而是拒绝（见下表 `NO_IDENTITY`）。`GET /health` 只发布身份的**来源**（`host-anonymous-id`/`configured-local-bucket`/`none`），不发布 id 值。

## 通用约定

- 前缀以 webServer `prefix` 注册；`GET /api/trading`（无尾段）等价 `GET /api/trading/bootstrap`。成功为 HTTP 200 `{"ok": true, "value": <payload>}`，失败为 `{"ok": false, "error": {"code": "...", "message": "..."}}`（状态码由错误码决定，部分错误另带 `status`/`provider`/`symbol`）。
- 未知路由 404 `no Trading Mode endpoint at ${method} /api/trading${path}`；方法或路径段有误一律 400：`method not allowed here; use GET, POST`、`POST is not supported here; use GET`、`this endpoint requires a symbol in the path`。
- 通用 query：`force`（真值 `1`/`true`/`yes`/`on`）绕过缓存回源；`market` 取 `US`|`HK`|`CN`|`JP`|`CRYPTO`（忽略大小写与空格），非法 → 400 `market X is not supported (US, HK, CN, JP, CRYPTO)`。
- 请求体只用于 `POST`/`PATCH`/`PUT`：上限 64 KiB（超限 400 `request body is too large`），非法 JSON → 400 `request body is not valid JSON: ...`，空体按 `{}`；响应头固定 `application/json; charset=utf-8`、`cache-control: no-store, no-cache, must-revalidate`、`x-content-type-options: nosniff`。
- 语言 `lang`（别名 `locale`）只接受 `en`/`zh`，其他 400 `unsupported language "x"; supported languages are en, zh`。

错误码与 HTTP 状态（表外 code 统一 500）：

| HTTP | code |
| --- | --- |
| 400 | `BAD_REQUEST`、`INVALID_SYMBOL`、`UNSUPPORTED_MARKET`、`UNSUPPORTED_INTERVAL` |
| 404 | `NOT_FOUND` |
| 429 | `UPSTREAM_RATE_LIMIT`、`RATE_LIMITED`（入站配额，带 `retryAfterMs` + `Retry-After`） |
| 502 | `UPSTREAM_ERROR`、`PARSE_ERROR`、`AI_INVALID_OUTPUT` |
| 503 | `NO_PROVIDER`、`DATA_UNAVAILABLE`、`UPSTREAM_BLOCKED`、`AI_UNAVAILABLE`、`HOST_SECURITY_UNAVAILABLE`、`NO_IDENTITY` |
| 504 | `UPSTREAM_TIMEOUT` |
| 500 | `STORAGE_ERROR`、`INTERNAL` |

被浏览器中断的 `AbortError` 归入 `UPSTREAM_TIMEOUT`。

`NO_IDENTITY`（503）出现在需要按用户存储的端点上（`/watchlist*`、`/settings` 的写方法）：本部署既没有宿主匿名 id，也没有声明 `identity.localBucket`。行情类端点（`/quote`、`/candles`、`/technical`、`/indices`、`/crypto`、`/search`、`/universe` GET）不受影响，照常应答。

## 端点

### GET /health（0.8.0，围栏之前应答）

存活探针，用于区分「插件没起来」与「插件起来了但宿主围栏不可用」。**唯一不经过围栏的端点**，因此它的负载被刻意压到最小：不含任何用户数据、配置、路径、计数或 provider 细节，也不访问上游、不写存储、不消耗入站配额。仅支持 `GET`（其他方法 400 `BAD_REQUEST`，且不计入 `fenceFailures`）。

```json
{"plugin":"dsh-trading-mode","version":"0.8.1","api":"ready","fence":"host","identity":"host-anonymous-id",
 "note":"requests are refused by the host request fence before any Trading Mode work starts"}
```

- `api`：`ready`（围栏可用）／`ready-on-loopback-only`（无围栏但开了 `allowUnfencedLoopback`）／`blocked`。
- `fence`：`host`／`loopback-exception`／`unavailable`。
- `identity`：身份来源字符串，不含 id 值。

### GET / · GET /bootstrap

无参数，首屏一次往返（自选表 + 每行报价 + 推荐池 + 状态 + AI 状态 + 偏好 + 身份摘要）。

```json
{"userId":"<宿主匿名 id 或 null>","identity":{"id":"<同上>","source":"host-anonymous-id","persistent":true,"storesPerUserData":true},
 "items":[{"symbol":"AAPL","market":"US","quote":{},"quoteMeta":{}}],"count":1,
 "recommendations":{},"backend":{"backend":"file"},"status":{},"ai":{"available":true},
 "settings":{"lang":"en","supported":["en","zh"]},"markets":["US","HK","CN","JP","CRYPTO"],"marketLabels":{},
 "stockMarkets":["US","HK","CN","JP"],"cryptoSpotlight":["BTC","ETH"],"disclaimer":"..."}
```

取价失败的行 `quote:null` 并带 `error:{code,message}`，不影响首屏；`backend.filePath` 为宿主本地路径，不做跨设备同步（`scope: profile-local`）。无身份时 `userId:null`、`items:[]`、`settings` 为内置默认值，不会去读共享桶。错误码 `STORAGE_ERROR`。

### GET /status

无参数；含 `service.status()` 的 router 状态与 `markets`、`cache{size,hits,misses,staleServed,expired,persisted,evicted}`、`indices{count,symbols}`、`cryptoSpotlight`、`universe`、`counters{quotes,candleRequests,analyses,briefs,searches,degraded}`、`supported{intervals,ranges}`、`disclaimer`，再叠加：

```json
{"ai":{"available":true,"state":"idle","reason":null,"route":{"provider":"...","model":"..."},"maxTokens":2400,
 "timeoutMs":120000},"watchlist":{"backend":"file","writes":true},"userId":"local","settings":{},
 "config":{"providerChains":{},"networkMode":"auto","storage":{"crossDevice":false}}}
```

### GET /settings · PATCH|PUT|POST /settings

`GET` 读显示语言；写方法提交 `{"lang":"zh"}`（接受 `locale`）。**写方法需要可信身份**（0.8.0）：无身份时 PATCH/PUT/POST 回答 503 `NO_IDENTITY`，`GET` 仍 200 但返回内置默认值而不是去读共享桶。

```json
{"userId":"local","lang":"zh","supported":["en","zh"],"defaultLang":"en","updatedAt":1731000000000}
```

无身份时的 `GET`：

```json
{"userId":null,"lang":"en","supported":["en","zh"],"defaultLang":"en","updatedAt":null,"storage":"no-identity"}
```

存储不可用时 `GET` 仍 200（`storage` 为 `unavailable`/`error`、`lang` 回落 `en`）；写操作缺存储 → `STORAGE_ERROR`。

### GET /indices（别名 `/index`）

`market` 可选（为 `CRYPTO` 时改走加密币聚光灯，等价 `/crypto`）；`symbols` 可选，逗号分隔白名单（逐项 trim、忽略空项）；`force` 可选。

```json
{"items":[{"symbol":"^GSPC","market":"US","quote":{},"meta":{}}],
 "unavailable":[{"symbol":"^XXX","code":"DATA_UNAVAILABLE","error":"..."}],
 "count":1,"generatedAt":1731000000000,"markets":["US"],"disclaimer":"..."}
```

并发上限 4，单项失败只进 `unavailable`。错误码 `UNSUPPORTED_MARKET`、`DATA_UNAVAILABLE`。

### GET /crypto（别名 `/coins`）

参数同上（`symbols` + `force`），固定走加密币链路，报价货币 `USDT`。

```json
{"items":[{"symbol":"BTC","name":"Bitcoin","nameZh":"比特币","quote":{},"meta":{}}],"count":1,"unavailable":[],
 "generatedAt":1731000000000,"markets":["CRYPTO"],"disclaimer":"..."}
```

### GET /universe（别名 `/listings`）

`market` 缺省 `US`，非法 400 `universe market must be one of US, HK, CN, JP, CRYPTO (got X)`；`board` 可选（各市场的板块名，如 US 的 `NASDAQ`/`NYSE`/`AMEX`），未知 400 `unknown board "X" for the US universe`；`page` 缺省 1、夹在 `1..200`（`UNIVERSE_PAGE_LIMIT`）；`size` 缺省 100、夹在 `1..100`（`UNIVERSE_PAGE_SIZE`）；`q` 本地子串检索（进入 search 模式）；`force` 绕过页缓存（键 `market:board:page:size`）。

```json
{"mode":"browse","market":"US","query":null,"rows":[],"total":0,"page":1,"size":50,"pages":1,"boards":{},
 "status":{},"provider":"...","cached":false}
```

有 `q` 时 `mode:"search"`、`page` 恒为 1、`pages` 为 `null`、`total` 是命中行数。提供方全败 → `DATA_UNAVAILABLE`（`the US listing feed is unavailable (...)`）；无提供方 → `NO_PROVIDER`（`no provider can list the US universe`）；板块回退默认时带 `boardFallback: true`。

### POST /universe

触发后台全量抓取，请求体 `{"market":"US","board":"NASDAQ"}`（同键也可放 query）。

```json
{"started": true, "running": true, "status": {"refreshing": true, "size": 0, "updatedAt": null}}
```

同一时刻只允许一个抓取；已在跑时返回 `{"started": false, "running": true, "already": true, "status": {...}}`。

### GET /search

`q` 必填（别名 `query`），空 → 400 `a search query is required`；`market` 可选过滤（非法 400）；`force` 可选。

```json
{"query":"apple","market":null,"source":"providers+universe+directory",
 "results":[{"symbol":"AAPL","name":"Apple Inc.","market":"US"}]}
```

`results` 最多 12 条；`source` 为命中来源以 `+` 连接；`freshness` 恒 `null`。

### GET /quote/:symbol

路径段必填（缺失 400）；query `market`、`force`。

```json
{"symbol":"AAPL","market":"US","currency":"USD","price":231.4,"changePct":0.52,"open":230.1,
 "high":232.0,"low":229.8,"previousClose":230.2,"volume":41234567,"timestamp":1731000000000,"source":"...",
 "delaySeconds":900,"stale":false,"freshness":"delayed"}
```

`data` 即报价对象（可带 `name`/`nameZh`/`exchange`），`meta` 见末节。错误码 `INVALID_SYMBOL`、`UNSUPPORTED_MARKET`、`DATA_UNAVAILABLE`、`UPSTREAM_*`。

### GET /candles/:symbol（别名 `/chart`）

`interval` 取 `5m`(`5min`)/`15m`/`30m`/`1h`(`60m`)/`1d`(`day`/`daily`)/`1wk`(`1w`/`week`/`weekly`)，缺省取 range 默认周期；`range` 取 `1d`/`5d`/`1mo`(`1m`)/`3mo`(`3m`)/`6mo`(`6m`)/`1y`/`5y`/`max`，缺省按 interval 推导（`5m`→`1d`、`15m`/`30m`→`5d`、`1h`→`1mo`、`1d`→`6mo`、`1wk`→`5y`），都缺时 `6mo`；越界 400：`unsupported interval "X" (expected one of 5m, 15m, 30m, 1h, 1d, 1wk)`、`unsupported range "X" (expected one of 1d, 5d, 1mo, 3mo, 6mo, 1y, 5y, max)`。`market`、`force` 可选。

```json
{"data":{"symbol":"AAPL","market":"US","interval":"1d","range":"6mo",
   "candles":[{"timestamp":1730900000000,"open":230.1,"high":232.0,"low":229.0,"close":231.4,"volume":41234567}]},
 "meta":{"symbol":"AAPL","cached":false,"stale":false,"marketOpen":true},
 "technical":{"interval":"1d","range":"1y","bars":250,"technical":{"rsi14":0,"trendAlignment":"bullish-stack"},
   "levels":{"support":[],"resistance":[]},"unavailable":[],"series":{}},
 "technicalMeta":{"cached":false,"stale":false}}
```

技术块**始终由 1d/1y 计算**，与请求的 `interval`/`range` 无关；某指标数据不足时其名称进 `unavailable`。

### GET /profile/:symbol

query `market`、`force`；字段缺失时给 `null`。

```json
{"symbol":"AAPL","name":"Apple Inc.","nameZh":"苹果公司","market":"US","exchange":"NASDAQ","currency":"USD",
 "industry":"Consumer Electronics","sector":"Technology","country":"United States",
 "marketCap":3500000000000,"peRatio":34.2,"source":"...","timestamp":1731000000000}
```

### GET /technical/:symbol（别名 `/indicators`）

query `market`、`force`；`data` 即上文的 `technical` 对象，`meta.interval`/`meta.range` 恒为 `1d`/`1y`。

```json
{"data":{"symbol":"AAPL","interval":"1d","range":"1y","bars":250,"price":231.4,
  "technical":{"ma20":0,"ma200":0,"rsi14":0,"atr14":0,"change1yPct":0,
    "trendAlignment":"bullish-stack","volatility20dAnnualizedPct":0},
  "levels":{"support":[0],"resistance":[0]},"unavailable":["ma200"],"series":{}},
 "meta":{"interval":"1d","range":"1y","stale":false,"cached":false}}
```

### POST /analyze/:symbol

路径段必填；body：`market`（也可用 query，非法 400）、`lang`/`locale`（缺省读已存偏好，再缺省 `en`）、`question`（字符串，其他类型忽略）。

```json
{"symbol":"AAPL",
 "analysis":{"summary":"...","trend":{"shortTerm":"...","mediumTerm":"...","longTerm":"..."},
   "volume":"...","supportLevels":[0],"resistanceLevels":[0],"riskFactors":["..."],"keyObservations":["..."]},
 "meta":{"provider":"...","model":"...","attempt":1,"elapsedMs":4200,"dataStale":false,"lang":"zh"}}
```

分析前取报价、公司资料、技术面与 1d/6mo 日线；**报价取不到即失败** 503 `DATA_UNAVAILABLE`；模型失败 503 `AI_UNAVAILABLE`；输出结构不合法 502 `AI_INVALID_OUTPUT`；浏览器断开经宿主信号中止调用（`UPSTREAM_TIMEOUT`）。成功计入 `counters.analyses`。

### GET /watchlist · POST /watchlist

`GET` 的 `quotes`（真值同 `force`）决定是否附报价：`quotes=1` 时每行为 `{...行, quote, quoteMeta}`，失败行 `quote:null` 加 `error:{code,message}`。`POST` body 的 `symbol`（别名 `query`/`code`）必填，缺失 400 `POST /watchlist requires a "symbol" field`；可带 `market` 与 `name`/`nameZh`/`exchange`/`currency` 覆盖。

```json
{"created": true,
 "item":{"id":"<uuid>","userId":"local","symbol":"AAPL","market":"US","name":"Apple Inc.","exchange":"NASDAQ",
   "currency":"USD","position":0,"isFavorite":false,"createdAt":1731000000000}}
```

新增幂等（已存在则合并，返回 `created: false`）；报价取不到仍会写入。上限 50 条，超限 400 `watchlist is limited to 50 symbols`；存取失败 `STORAGE_ERROR`。

### GET /watchlist/:symbol

返回 `{"item": {...}}`；不在表中 → 404 `NOT_FOUND`（`AAPL is not in the watchlist`）；符号先归一化，`aapl` 与 `AAPL` 同项。

### PATCH /watchlist/:symbol（也接受 PUT）

body 必须给 `isFavorite`（别名 `favorite`），否则 400 `PATCH /watchlist/:symbol expects {"isFavorite":true|false}`；未命中 404。

```json
{"item": {"symbol": "AAPL", "isFavorite": true}}
```

### DELETE /watchlist/:symbol

```json
{"removed": true}
```

删除不存在的代码不报错，返回 `{"removed": false}`。

### POST /watchlist/order（也接受 PATCH / PUT）

body `symbols`（别名 `order`/`items`）必须是数组，否则 400 `order must be an array of symbols`；未列出的条目保持原有相对顺序排在其后。

```json
{"items": [{"symbol": "AAPL", "position": 0}], "count": 1}
```

### POST /watchlist/analyze

body：`symbols` 可选数组（缺省整表；元素可为纯代码或 `{symbol, market}` 行，行保留各自 `market`）、`lang`/`locale` 可选。

```json
{"brief":{"headline":"...","stocksTracked":3,"upCount":2,"downCount":1,"strongestMover":"...","largestDecline":"...",
   "unusualVolume":["..."],"keyObservations":["..."]},
 "meta":{"provider":"...","model":"...","stocksTracked":3,"dataAsOf":1731000000000,"lang":"zh"}}
```

自选表为空 → 400 `the watchlist is empty; add a stock before requesting a brief`；只取**前 20 个**代码；成功计入 `counters.briefs`。

## 缓存、降级与配额

TTL 分盘中/休市两套，按市场会话状态自动切换：

| 数据 | 开市 | 休市 | 最长可作 stale 提供 |
| --- | --- | --- | --- |
| quote | 20 s | 10 min | 72 h |
| candles | 60 s | 30 min | 7 d |
| technical | 60 s | 30 min | 24 h |
| profile | 24 h | 24 h | 30 d |
| search | 10 min | 60 min | 24 h |

- 命中未过期且未传 `force` 时 meta 为 `cached: true, stale: false`；`force=1` 直接回源。
- 上游失败且旧值未超出「最长可作 stale 提供」窗口时仍返回 200，但 meta 为 `cached: true, stale: true`、`staleReason` 为 `served from cache past its TTL`；超窗条目被删除。
- `meta.freshness` 取 `fresh`（≤5 分钟）、`delayed`（≤20 分钟）、`closed-session`（休市时上一交易日的报价，不算 stale）、`stale`、`unknown`；`/search` 恒 `null`。（0.8.0 把 `live` 改名为 `fresh`：本插件只报告「上游时间戳有多新」，从不声称自己拿到的是实时行情。）
- 蜡烛未达该 `range`/`interval`/`market` 的最小根数门槛时 `data` 带 `degraded: true` 与 `minBars`，面板显示「历史数据不完整」；提供方链全部降级时路由层也标 `degraded: true`。

## 入站配额、并发闸与 429（0.7.0）

配额是**入站保护**，目的是让一个失控的客户端或一台被占用很长时间的机器不会把上游数据源打爆。
所有限制来自 `lib/trading/config.js` 的 `API_POLICY`，由 `lib/trading/limits.js` 执行；窗口为滑动 60 秒。

| 桶 | 每用户上限 | 全局限额 | 触发端点 |
| --- | --- | --- | --- |
| `request`（通用） | 240 / 60 s | 1 200 / 60 s | 除 `fence` 拒绝外的**所有**请求 |
| `analyze` | 20 / 60 s | 60 / 60 s | `POST /api/trading/analyze` |
| `brief` | 6 / 60 s | 30 / 60 s | `POST /api/trading/watchlist/analyze` |
| `universeRefresh` | 2 / 60 s | 4 / 60 s | `POST /api/trading/universe` |

- 并发闸 `ConcurrencyGate`：同时在飞的 AI 分析 ≤ `maxConcurrentAnalyses`（2），全局 ≤
  `maxConcurrentAnalysesGlobal`（4）。第 3 个并发请求不会被排队，而是立刻被拒。
- 超限响应：`429`，body 为 `{ok:false,error:{code:"RATE_LIMITED",message:"too many <bucket> requests; ...",retryAfterMs}}`，
  并带 `Retry-After: <秒>` 响应头（向上取整，最小 1）。
- **被拒的请求不消耗额度**：配额先整体判定、再记账，因此连续刷新页面不会因为「被拒也算一次」而永久被锁死；
  被拒请求在 `fence` 之后立即返回，不会到达 service、不会触发任何上游请求。
- 配额按**不涉及隐私的计量键**计数：有可信身份时用它，没有时统一记在 `shared` 上（`safeUserId()`）。
  计量键与存储身份是两件事 —— 计量永远可用，存储在没有身份时一律拒绝（503 `NO_IDENTITY`），
  所以「配额还能用」绝不代表「可以往共享桶里写数据」。
- `GET /api/trading/status` 新增 `limits` 字段（`{ requests: [...], buckets: [...], inFlight: {...}, rejections }`），
  它是**余量快照**，可直接用于面板显示「还可以问几次」；同一次响应还新增 `identity`
  （`{id, source, persistent, storesPerUserData}`，无身份时 `id` 为 `null`）与 `fenceFailures`
  （自启动以来被围栏拒绝的请求数），便于区分「没起来」与「起来了但在拒绝」。

### 长任务的预算与取消

`POST /api/trading/universe` 触发的全市场目录扫描不再无上限：

- 墙钟预算 `UNIVERSE_POLICY.budgetMs`（15 分钟）。超预算即停止翻页，返回
  `{ started, running, status: {..., complete: false, reason: "budget", budgetMs, cancelled: false} }`。
- `DELETE /api/trading/universe` 取消正在进行的扫描，返回 `{ cancelled, running, reason }`；
  被取消时扫描结果带 `reason: "cancelled"`、`cancelled: true`、`complete: false`。
- 请求自身的 abort（客户端断开连接）也会转成取消：`POST` 把 `signal` 透传到 `service.universeRefresh({signal})`。
- 扫描期间再发一次 `POST` 仍返回单飞结果（`{started: false, running: true, already: true}`），不会叠加第二条扫描。
  重启用最小间隔 `UNIVERSE_POLICY.minRestartIntervalMs`（30 秒）节流。

### 方法守卫与错误码

路径存在但方法不支持时返回 `400 BAD_REQUEST`，消息形如
`method not allowed here; use GET, POST, DELETE`（`universe` 支持 `GET` / `POST` / `DELETE`）。
本插件**没有**独立的 `METHOD_NOT_ALLOWED` 错误码 —— 方法不符走的是 `BAD_REQUEST`。

### `/status` 的诊断脱敏

`GET /api/trading/status` 返回的字符串字段会经过 `sanitizeStatus()` / `redactDiagnostic()`：

- 上游 URL → `https://push2.eastmoney.com/…`（只留 origin）
- IPv4（含端口）→ `[redacted-ip]:443`
- 裸主机名 → `[redacted-host]`
- 绝对路径 → `…/cache.json`（Windows 与 POSIX 都处理）

只对 `DIAGNOSTIC_KEYS` 列出的字段（`lastError` / `error` / `message` / `reason` / `base` / `endpoint` /
`url` / `host` / `path` / `filePath` 等）做脱敏，因此 provider id、健康度与 `600519.SH`、`BTC-USD`
这类证券代码**不会被误伤**；非字符串值原样返回。目的是让用户能贴出 `/status` 排障而不泄露内网地址与
本机目录结构。

### 时效分级（0.7.0，0.8.0 起 `live` → `fresh`）

分析类响应新增 `meta.dataQuality`：`{ grade, ageSeconds, stale, staleReason, qualification, historyGrade, historyBars }`，
`grade` 取 `fresh`（≤5 分钟，`AI_CONFIG.freshMaxAgeMs`）/ `delayed`（≤30 分钟）/ `stale`（≤24 小时）/ `historical`（更旧）/ `unknown`。
非 `fresh` 时系统提示会要求模型把数据表述为「最后可用数据 / 延迟数据」，并**无论 grade 为何**都禁止使用
now / today / live 措辞（`RECENCY_DIRECTIVE`），客户端也会在分析卡片上显示对应提示条。技术指标响应新增
`technical.quality` 与 `meta.quality`（`full` ≥200 根日线 / `partial` ≥50 / `limited` ≥20 / `insufficient` <20）。
