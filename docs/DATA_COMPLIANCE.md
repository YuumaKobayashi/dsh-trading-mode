# Data Compliance

`dsh-trading-mode` is a **local research tool**. It runs inside one DSH
installation on one machine, and it pulls market data from **public,
unauthenticated endpoints** of the providers listed below. It does not ask for
a login, does not hold a paid or licensed market-data entitlement, and does not
present itself as one. Everything it fetches is a public HTTP GET of the same
kind a browser tab would issue.

The plugin's compliance position is deliberately narrow:

- No authentication is attempted, stored or bypassed. No provider account is
  created, and no API key is requested from the user.
- No payment, subscription or paywall is circumvented, and no CAPTCHA or
  bot-detection challenge is solved or evaded. When an upstream answers `401`,
  `403` or `451`, or a body that looks like a bot wall, the plugin records
  `UPSTREAM_BLOCKED` and stops — it degrades to the next provider or to a typed
  error instead of working around the refusal.
- No provider data is resold, republished or bulk-exported. Values are fetched
  and rendered for the one person running the panel.
- **Each provider's own terms of use remain the user's responsibility.** The
  plugin is a client; it cannot grant rights the provider has not granted to
  you. Read the section [If you are the operator](#if-you-are-the-operator)
  before pointing this at anything but personal research.

Published provider notes already live in
[`DATA_SOURCES.md`](DATA_SOURCES.md) (hosts, dialects, endpoints) and
[`COMPATIBILITY.md`](COMPATIBILITY.md) (what has actually been measured). This
document does not repeat them; it states the **compliance boundary** of the
same design and links to them from this point on.

## Providers

One row per provider id, in `PROVIDER_CONFIG` order as defined in
`lib/trading/config.js`. "Requested" lists what the plugin actually asks that
host for. `delaySeconds` is the value the plugin carries into every payload
(`null` means "not published by the provider", `0` means the feed reports the
current print).

| id | label | host(s) actually requested | markets | requested | delay | attribution in the UI | compliance note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `yahoo` | Yahoo Finance | `query1.finance.yahoo.com` (`/v1/finance/search`, `/v8/finance/chart`, `/v7/finance/quote`, `/v10/finance/quoteSummary`, `/v1/test/getcrumb`); `fc.yahoo.com` (cookie handshake only) | US, HK | search, quote, candles, profile | `null` | "Yahoo Finance" link to the public quote page (US/HK and crypto only) | The cookie + crumb handshake is the endpoint's documented unauthenticated flow, refreshed lazily and retried once on `401`/`403`; the cookie lives in provider memory for the process, never on disk. A persistent `403` is classified `UPSTREAM_BLOCKED`, not retried, and the chain falls through. Terms: not verified in this repository. |
| `stooq` | Stooq | `stooq.com/q/d/l/` (CSV); `stooq.com/q/l/` quote URL is configured but unused because the provider declares no quote capability | US, HK | candles (daily/weekly CSV only) | `null` | none offered | One request per `getCandles` call. A body that looks like a block (`access denied`) is surfaced as `DATA_UNAVAILABLE`; quotes and search are not implemented, so the plugin never presents a Stooq end-of-day close as a live quote. Attribution gap — see the note below the table. Terms: not verified in this repository. |
| `eastmoney` | 东方财富 Eastmoney | `push2.eastmoney.com` plus the numbered mirrors `1/2/7/17/48.push2.eastmoney.com` (quotes and `ulist.np`), `push2his.eastmoney.com` plus `1/2/7/17/48.push2his.eastmoney.com` (kline, `clist`), `searchapi.eastmoney.com/api/suggest/get` | US, HK, CN, JP | search, quote, candles, profile, listings, indices | `null` | "东方财富" link to the public quote page (US/HK/CN); "新浪财经" also offered on CN rows | The largest host surface in the plugin, bounded by `maxHostsPerRequest: 6` and `hostCooldownMs: 45000` per request. Two identifiers travel in the query string (`searchToken`, `clistToken`); they are the values the public web page itself embeds, not user credentials, and they are not persisted. No login page is touched, no account is used. Terms: not verified in this repository. |
| `tencent` | 腾讯财经 Tencent | `qt.gtimg.cn` (`/q=` batch quote); `web.ifzq.gtimg.cn` (`/appstock/app/kline/kline`) | US, HK, CN, JP | quote, candles | `null` | "腾讯财经" link to `gu.qq.com` (US/HK/CN keys) | Responses are GBK and decoded explicitly. Every minute-level Tencent endpoint is recorded as dead, so `intervals: ['1d','1wk']` keeps the router from ever asking for intraday data. Terms: not verified in this repository. |
| `sina` | 新浪财经 Sina Finance | `stock.finance.sina.com.cn` (`/usstock/api/jsonp.php/.../US_MinKService.getDailyK`); `vip.stock.finance.sina.com.cn` (HK list, CN node lists); `money.finance.sina.com.cn` (CN daily kline, CN stock count) | US, HK, CN | candles, listings (daily only) | `null` | "新浪财经" link to the public company page (CN rows only) | Sends `Referer: https://finance.sina.com.cn/` on the CN nodes, the same header the public page sends. US daily history arrives as one large JSONP payload that is trimmed locally. Terms: not verified in this repository. |
| `nasdaq` | Nasdaq | `api.nasdaq.com/api/screener/stocks` (one request, `limit: 10000`) | US | listings only | `null` | none offered | Used only as the US listing fallback when eastmoney's `clist` refuses. Sends `Referer: https://www.nasdaq.com/`. Declares no quote, candle, search or profile capability at all, so it can never become a price source. Attribution gap — see the note below the table. Terms: not verified in this repository. |
| `binance` | Binance | `data-api.binance.vision` (`/api/v3/ticker/24hr`, `/api/v3/klines`; `/api/v3/exchangeInfo` is configured but not used by the provider) | CRYPTO | search, quote, candles | `0` | "Binance" link to the public trade page (crypto rows) | Public market-data host only; no account, no API key, no order endpoint. One klines call caps at 1000 rows and long ranges are paged under `klineMaxPages: 4`. `exchangeInfo` is deliberately not fetched because it is 17.7 MB and carries no names. Terms: not verified in this repository. |
| `gate` | Gate.io | `api.gateio.ws` (`/api/v4/spot/tickers`, `/api/v4/spot/candlesticks`, `/api/v4/spot/currency_pairs`) | CRYPTO | quote, candles | `0` | "Gate.io" link to the public trade page (crypto rows) | Public spot market data only; no trading, no credentials. `currency_pairs` doubles as the English name dictionary. One candlesticks call caps at 1000 rows and is served as the newest 1000 rather than paginated. Terms: not verified in this repository. |
| `coinlore` | CoinLore | `api.coinlore.net/api/tickers/` (100 rows per page) | CRYPTO | search (local filter), profile, listings | `null` | none offered | A directory/name source only: its prices carry no timestamp, so the provider declares no quote or candle capability and the router never asks it for a price. Attribution gap — see the note below the table. Terms: not verified in this repository. |

**Attribution gap (softened claim).** The code does not offer a provider link
for `stooq`, `nasdaq` or `coinlore`. The UI's source row (`SOURCE_LINKS` in
`lib/client.js:1664-1742`) only builds links for `tradingview`, `yahoo`,
`binance`, `gate`, `eastmoney`, `sina`, `yahoojapan` and `tencent`, and those
links are inbound public pages, not a statement of licence. So the table above
says "none offered" rather than claiming any attribution exists for those three;
if you rely on them, credit them yourself.

**Terms are not verified here.** For every one of the nine providers this
repository contains no fetched copy of the provider's terms of service, and no
provider terms text is quoted or paraphrased in this document. Where the plugin
knows something about a provider it is a *dialect* fact measured by the code
(host reachability, interval tokens, response encoding) — never a licence claim.
Verification date: **2026-10-10**; every row above carries the same
`not verified` status as of that date.

**Publish decision (per provider).** All nine are **kept enabled by default** in
the published build, because every one of them is a public unauthenticated
endpoint that a browser tab could fetch, and the plugin's use is a bounded,
rate-limited read for one local operator. The decision is revocable by
configuration, not by a code change: `providers` in the plugin config
(`lib/trading/config.js` `CHAIN_OVERRIDES`, validated by
`validateProviderChains`) replaces the per-market chain with an ordered list of
provider ids, so an operator who has no right to a feed can simply drop it:

```yaml
- id: trading-mode
  config:
    providers:
      US: ['yahoo', 'stooq']      # eastmoney / tencent / sina / nasdaq removed
      CRYPTO: ['binance', 'gate']
```

`validateProviderChains` rejects unknown ids, duplicates, empty arrays and
non-arrays, and logs the rejection while the shipped default stays in force, so a
misconfiguration can never silently widen or narrow the set. If a provider is
later found to forbid this automated use, the correct fix is to remove it from
`MARKET_DATA_CONFIG` in `lib/trading/config.js`, not to work around its refusal.

## Provider terms and access details

The section above states the boundary. This section states, per provider, the
seven facts an operator actually needs before deciding whether to keep a feed
enabled: the terms URL, the access method the code uses, the rate limits the code
enforces, the cache retention the code applies, the attribution the UI shows, the
permitted-reuse scope, and whether third-party open-source clients appear to be
allowed. It is written **after** an attempt to verify each one on **2026-10-10**.

Two very different things are recorded below and must not be confused:

- **Access** — what the endpoint itself did when this document was written. A
  `200` with a JSON body is a measured fact about reachability, not a licence.
- **Terms** — what the operator's terms of use say. Unless a clause is quoted
  with its URL, the terms row reads `not verified` with the date and the search
  query used, exactly as required. An unverified terms row is **not** an implied
  permission; it means nobody looked, or the lookup failed.

The shared plugin mechanics that every block below refers to:

- **Rate limiting.** One `RateLimiter` token bucket **per provider**
  (`lib/trading/providers/index.js:46`), `rateLimitPerMinute: 120`
  (`lib/trading/config.js:365`), plus `timeoutMs: 12000`, `retries: 2` with
  exponential backoff, and `failureThreshold: 3` / `healthCooldownMs: 60000`
  (`lib/trading/config.js:359-372`, health tracked per `healthScope` in
  `lib/trading/http.js:77-148`). Reads are small-concurrency by construction: a
  request touches at most `maxHostsPerRequest: 6` hosts and each host then rests
  for `hostCooldownMs: 45000` (`lib/trading/config.js:152-155`).
- **Cache retention.** `CACHE_TTL` (`lib/trading/config.js:349-356`) is
  process-wide and keyed by symbol, never per user (`lib/trading/cache.js:10-12`).
  Market open: quote 20 s, candles 60 s, technical 60 s, search 10 min, profile
  24 h. Market closed: quote 10 min, candles 30 min, technical 30 min, search
  60 min, profile 24 h. Hard `maxStaleAge` ceilings: quote 72 h, candles 7 d,
  profile 30 d, technical 24 h, search 24 h — older than the ceiling is never
  served, not even as stale. In memory the map is capped at 4000 entries
  (`lib/trading/cache.js:26`); the optional on-disk snapshot keeps at most 500
  keys and 4 MiB and trims anything larger (`lib/trading/persist.js:22-25`). The
  cache is a rendering input for this installation, not an export surface.
- **Reuse scope.** The plugin ships no market-data files, has no export or
  publish route, and renders values to the one local operator — so the reuse
  scope of *this software* is "display in the local panel". The permitted-reuse
  scope of *the data*, per provider, is an upstream question and is recorded
  below as `not verified` unless a fetched page said otherwise. Nothing in this
  document grants a redistribution right.

### yahoo — Yahoo Finance

- Terms URL: `https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html` —
  fetched (HTTP 200) but the response resolved to a mainland-China availability
  notice, so **no clause was read**: terms `not verified (search: "Yahoo Terms of
  Service query1.finance.yahoo.com finance data", 2026-10-10)`.
- Access method: unauthenticated GET to `query1.finance.yahoo.com`
  (`/v1/finance/search`, `/v8/finance/chart`, `/v7/finance/quote`,
  `/v10/finance/quoteSummary`, `/v1/test/getcrumb`), with `fc.yahoo.com` touched
  only for the cookie handshake. No login, no API key, no `crumb` reuse beyond
  the handshake flow.
- Rate limits enforced here: the shared per-provider bucket above; the handshake
  cookie lives in provider memory for the process and is never written to disk.
- Cache retention: the shared `CACHE_TTL` above; profile 24 h is the longest
  quote-adjacent retention the provider can populate here.
- Attribution in the UI: "Yahoo Finance" link to the public quote page, on US/HK
  and crypto rows only.
- Permitted reuse: `not verified (search: "Yahoo Terms of Service
  query1.finance.yahoo.com finance data", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Yahoo Finance
  API terms of use query1.finance.yahoo.com", 2026-10-10)`. A third-party
  connector package appeared in the search results; appearance is not permission
  and is not recorded as one.
- Measured access (2026-10-10): `GET /v8/finance/chart/AAPL` answered **HTTP
  403**, which the plugin classifies `UPSTREAM_BLOCKED` — the degrade path, not a
  workaround, is what runs.

### stooq — Stooq

- Terms URL: `https://stooq.com/terms.html` — fetch returned **HTTP 403** with a
  body reading `Access denied`. The Polish twin `https://stooq.pl/terms.html`
  returned HTTP 403 with `Odmowa dostępu`. No terms text was read: terms `not
  verified (search: "stooq.com terms of service data reuse", 2026-10-10)`.
- Access method: unauthenticated GET to `stooq.com/q/d/l/` (daily/weekly CSV
  only). The `stooq.com/q/l/` quote URL is configured but unused, because the
  provider declares no quote capability.
- Rate limits enforced here: one request per `getCandles` call, under the shared
  per-provider bucket.
- Cache retention: the shared `CACHE_TTL` above; candles 60 s open / 30 min
  closed, 7 d stale ceiling.
- Attribution in the UI: none offered (see the attribution gap above).
- Permitted reuse: `not verified (search: "stooq.com terms of service data
  reuse", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "stooq.com
  terms of service data reuse", 2026-10-10)`.
- Measured access (2026-10-10): the CSV endpoint
  `https://stooq.com/q/d/l/?s=aapl.us&i=d` answered **HTTP 403** /
  `Access denied`, surfaced by the plugin as `DATA_UNAVAILABLE`.

### eastmoney — 东方财富 Eastmoney

- Terms URL: `https://corp.eastmoney.com/fuwutiaokuan.html` — fetched (HTTP 200)
  and it is a service agreement served in **GBK**, which this document's fetch
  could not render reliably. Clauses that appeared in the mangled text were **not
  relied on and are not quoted here**: terms `not verified (search:
  "Eastmoney Terms of Service push2.eastmoney.com 免责声明 服务条款", 2026-10-10)`.
  Operators who want the wording should re-open that URL in a browser and read it
  in Chinese; it is recorded as a candidate URL, not as a verified source.
- Access method: unauthenticated GET to `push2.eastmoney.com` plus the numbered
  mirrors `1/2/7/17/48.push2.eastmoney.com` (quotes, `ulist.np`),
  `push2his.eastmoney.com` plus its mirrors (kline, `clist`), and
  `searchapi.eastmoney.com/api/suggest/get`. Two identifiers travel in the query
  string (`searchToken`, `clistToken`); they are the values the public web page
  itself embeds, are not user credentials, and are not persisted.
- Rate limits enforced here: `maxHostsPerRequest: 6` and `hostCooldownMs: 45000`
  per request (`lib/trading/config.js:152-155`) — the mirror rotation is bounded
  and each mirror is rested after use — on top of the shared per-provider bucket.
- Cache retention: the shared `CACHE_TTL` above; its index/kline reads land in
  candles (60 s / 30 min, 7 d ceiling) and its listing reads in the local
  universe snapshot (see the listing-directory bounds above).
- Attribution in the UI: "东方财富" link to the public quote page (US/HK/CN), with
  "新浪财经" also offered on CN rows.
- Permitted reuse: `not verified (search: "Eastmoney Terms of Service
  push2.eastmoney.com 免责声明 服务条款", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Eastmoney
  Terms of Service push2.eastmoney.com 免责声明 服务条款", 2026-10-10)`.
- Measured access (2026-10-10): the `push2` quote endpoint did not answer this
  environment (`fetch failed`) and is therefore neither confirmed nor denied
  here.

### tencent — 腾讯财经 Tencent

- Terms URL: no operator terms URL was confirmed for the finance endpoints.
  `www.tencentcloud.com/document/product/301/9248` was fetched (HTTP 200) and is
  the **Tencent Cloud** terms of service — a different service from the finance
  quote hosts — so it is deliberately **not** used to characterise this provider:
  terms `not verified (search: "Tencent gu.qq.com terms of service data",
  2026-10-10)`.
- Access method: unauthenticated GET to `qt.gtimg.cn` (`/q=` batch quote) and
  `web.ifzq.gtimg.cn` (`/appstock/app/kline/kline`). Responses are GBK and
  decoded explicitly. No account, no key.
- Rate limits enforced here: the shared per-provider bucket; every minute-level
  Tencent endpoint is recorded as dead, so `intervals: ['1d','1wk']` keeps the
  router from ever asking for intraday data.
- Cache retention: the shared `CACHE_TTL` above; quote 20 s open / 10 min closed,
  candles 60 s / 30 min.
- Attribution in the UI: "腾讯财经" link to `gu.qq.com` (US/HK/CN keys).
- Permitted reuse: `not verified (search: "Tencent gu.qq.com terms of service
  data", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Tencent
  gu.qq.com terms of service data", 2026-10-10)`.
- Measured access (2026-10-10): `https://qt.gtimg.cn/q=usAAPL` answered **HTTP
  200** with a `v_usAAPL="…"` quote payload carrying a timestamp — a public
  unauthenticated read, which is an access fact and not a licence.

### sina — 新浪财经 Sina Finance

- Terms URL: `https://finance.sina.cn/finance_zt/financeapp/appPayAgreement.shtml`
  — fetched (HTTP 200) and its title is 服务使用协议 with a first clause stating
  the platform's published content is not an investment basis. It is a **finance
  app payment/service agreement**, not a market-data licence, and it says nothing
  about automated reads of quote or kline endpoints. Clause name, as read: the
  page's own heading 服务使用协议. Data-reuse terms:
  `not verified (search: "Sina finance terms of service hq.sinajs.cn data",
  2026-10-10)`.
- Access method: unauthenticated GET to `stock.finance.sina.com.cn`
  (`/usstock/api/jsonp.php/.../US_MinKService.getDailyK`),
  `vip.stock.finance.sina.com.cn` (HK list, CN node lists) and
  `money.finance.sina.com.cn` (CN daily kline, CN stock count), with
  `Referer: https://finance.sina.com.cn/` on the CN nodes — the header the public
  page itself sends.
- Rate limits enforced here: the shared per-provider bucket; US daily history
  arrives as one large JSONP payload that is trimmed locally rather than paged
  further.
- Cache retention: the shared `CACHE_TTL` above; candles 60 s / 30 min with a 7 d
  stale ceiling.
- Attribution in the UI: "新浪财经" link to the public company page (CN rows only).
- Permitted reuse: `not verified (search: "Sina finance terms of service
  hq.sinajs.cn data", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Sina finance
  terms of service hq.sinajs.cn data", 2026-10-10)`.
- Measured access (2026-10-10): `https://hq.sinajs.cn/list=sh600519` answered with
  a body this environment's fetch reported as an unsupported content type, so its
  content was not read.

### nasdaq — Nasdaq

- Terms URL: no public terms page was confirmed. `www.nasdaq.com/terms-and-conditions`,
  `www.nasdaq.com/legal/terms` and `www.nasdaq.com/legal/terms-and-conditions`
  all failed to fetch (`fetch failed`), and `www.nasdaq.com/about/terms` also
  failed: terms `not verified (search: "Nasdaq.com Terms and Conditions of Use
  api.nasdaq.com data", 2026-10-10)`. Search results surfaced
  `nasdaqtrader.com` market-data policy PDFs; they are index-data and
  exchange-policy documents, were not read in full, and are **not** quoted here as
  governing `api.nasdaq.com`.
- Access method: one unauthenticated GET to
  `api.nasdaq.com/api/screener/stocks` (`limit: 10000`) as the US listing
  fallback, with `Referer: https://www.nasdaq.com/`. The provider declares no
  quote, candle, search or profile capability, so it can never become a price
  source.
- Rate limits enforced here: a single request per listing walk, inside that
  walk's `budgetMs: 15 * 60_000` deadline and `minRestartIntervalMs: 30000`
  restart floor, plus the shared per-provider bucket.
- Cache retention: rows land in the local universe snapshot (listing metadata
  only), capped by `UNIVERSE_PAGE_SIZE: 100`, `UNIVERSE_PAGE_LIMIT: 200` and
  `MAX_UNIVERSE_BYTES: 12 * 1024 * 1024`.
- Attribution in the UI: none offered (see the attribution gap above).
- Permitted reuse: `not verified (search: "Nasdaq.com Terms and Conditions of Use
  api.nasdaq.com data", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Nasdaq.com
  Terms and Conditions of Use api.nasdaq.com data", 2026-10-10)`.
- Measured access (2026-10-10): the screener endpoint did not answer this
  environment (`fetch failed`).

### binance — Binance

- Terms URL: no terms page was confirmed. `www.binance.com/en/terms` and
  `www.binance.com/en/terms-of-use` could not be resolved from this environment
  (non-public-IP guard), and
  `developers.binance.com/en/docs/products/spot/faqs/market_data_only` failed the
  same guard while the `developers.binance.me` mirror answered **HTTP 403** with a
  bot challenge. Terms: `not verified (search: "Binance public market data API
  terms of use data-api.binance.vision", 2026-10-10)`. A "Market Data Only"
  developer page appeared in the search results; **no clause from it is quoted
  here**, because it was not read.
- Access method: unauthenticated GET to `data-api.binance.vision`
  (`/api/v3/ticker/24hr`, `/api/v3/klines`; `/api/v3/exchangeInfo` is configured
  but unused). No account, no API key, no order endpoint.
- Rate limits enforced here: the shared per-provider bucket; one klines call caps
  at 1000 rows and long ranges are paged under `klineMaxPages: 4`.
- Cache retention: the shared `CACHE_TTL` above; `delaySeconds: 0` means the feed
  reports the current print, and quote 20 s open / 10 min closed still applies.
- Attribution in the UI: "Binance" link to the public trade page (crypto rows).
- Permitted reuse: `not verified (search: "Binance public market data API terms
  of use data-api.binance.vision", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "Binance public
  market data API terms of use data-api.binance.vision", 2026-10-10)`.
- Measured access (2026-10-10): `GET
  https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT` answered
  **HTTP 200** with public JSON (`lastPrice`, `volume`, `quoteVolume`, `openTime`,
  `closeTime`) for an anonymous caller — access confirmed, permission not.

### gate — Gate.io

- Terms URL: no Gate terms page was confirmed for `api.gateio.ws`; `www.gate.io/terms`
  and `www.gate.io/zh/terms` could not be resolved from this environment. The
  public API reference **was** fetched (HTTP 200):
  `http://gateioservicefront.com/docs/developers/apiv4/en/`. As read, that page
  titles itself "Gate API v4" and states: "APIv4 provides operations related to
  spot, margin, and contract trading, including **public interfaces for querying
  market data** and authenticated private interfaces for implementing API-based
  automated trading", and lists the REST base URL `https://api.gateio.ws/api/v4`.
  Terms of use beyond that: `not verified (search: "gate.io terms of service api
  market data use api.gateio.ws", 2026-10-10)`.
- Access method: unauthenticated GET to `api.gateio.ws`
  (`/api/v4/spot/tickers`, `/api/v4/spot/candlesticks`,
  `/api/v4/spot/currency_pairs`), matching the documented public base URL above.
  No trading, no credentials.
- Rate limits enforced here: the shared per-provider bucket; one candlesticks call
  caps at 1000 rows and is served as the newest 1000 rather than paginated.
- Cache retention: the shared `CACHE_TTL` above; quote 20 s open / 10 min closed,
  candles 60 s / 30 min, with the 7 d stale ceiling.
- Attribution in the UI: "Gate.io" link to the public trade page (crypto rows).
- Permitted reuse: `not verified (search: "gate.io terms of service api market
  data use api.gateio.ws", 2026-10-10)`.
- Third-party open-source clients allowed: the fetched API page links first-party,
  Gate-published SDKs (Python, Java, PHP, Go, C#, NodeJS, Javascript). That is a
  first-party client statement, **not** a statement about third-party clients, so
  third-party allowance remains `not verified (search: "gate.io terms of service
  api market data use api.gateio.ws", 2026-10-10)`.
- Measured access (2026-10-10): only the documentation host was reached from this
  environment; `api.gateio.ws` itself was not exercised here.

### coinlore — CoinLore

- Terms URL: no terms page was confirmed for `api.coinlore.net`.
  `www.coinlore.com/cryptocurrency-data-api` was fetched (HTTP 200) and rendered
  as navigation and promo chrome only — no licence or reuse clause was readable
  in what came back: terms `not verified (search: "CoinLore api terms of use
  api.coinlore.net", 2026-10-10)`.
- Access method: unauthenticated GET to `api.coinlore.net/api/tickers/`
  (100 rows per page). The provider is a directory/name source only: its prices
  carry no timestamp, so it declares no quote or candle capability and the router
  never asks it for a price.
- Rate limits enforced here: one page per listing walk step under
  `UNIVERSE_PAGE_LIMIT: 200`, inside the walk's wall-clock budget, plus the shared
  per-provider bucket.
- Cache retention: rows land in the local universe snapshot (listing metadata)
  and in the shared `CACHE_TTL` search bucket (10 min open / 60 min closed, 24 h
  ceiling).
- Attribution in the UI: none offered (see the attribution gap above).
- Permitted reuse: `not verified (search: "CoinLore api terms of use
  api.coinlore.net", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "CoinLore api
  terms of use api.coinlore.net", 2026-10-10)`.
- Measured access (2026-10-10): `GET
  https://api.coinlore.net/api/tickers/?start=0&limit=2` answered **HTTP 200**
  with a public JSON body (`data[]` plus `info{coins_num,time}`) — access
  confirmed, permission not.

### tradingview — TradingView widget embed

Documented in its own section below; the same seven facts, recorded here so the
set is complete in one place.

- Terms URL: `https://www.tradingview.com/policies/` could not be fetched from
  this environment (non-public-IP guard), and `s.tradingview.com/widgetembed/`
  failed the same guard; a charting-library licence agreement PDF surfaced in
  search but was not read: terms `not verified (search: "TradingView widget embed
  terms of use s.tradingview.com/widgetembed", 2026-10-10)`.
- Access method: **not fetched by the plugin at all** — the browser loads
  `https://s.tradingview.com/widgetembed/?symbol=…` in an `<iframe>`
  (`lib/client.js:1490-1495`).
- Rate limits enforced here: none, because no plugin-issued request exists.
- Cache retention: none — nothing from that frame enters the local cache, the
  watchlist or the AI snapshot.
- Attribution in the UI: the widget's own branding, unmodified, with a surrounding
  link to `https://www.tradingview.com/chart/?symbol=…` (`lib/client.js:1672-1674`).
- Permitted reuse: `not verified (search: "TradingView widget embed terms of use
  s.tradingview.com/widgetembed", 2026-10-10)`.
- Third-party open-source clients allowed: `not verified (search: "TradingView
  widget embed terms of use s.tradingview.com/widgetembed", 2026-10-10)`.

**Terms URLs that were read in this pass.** Only one provider-adjacent page
actually rendered usable text: Gate's public API reference, which calls its
market-data endpoints public. Every other provider row above is `not verified`,
and no permission is implied by the absence of a found clause.

## Scope of the MIT license

This project is MIT-licensed (`package.json`, `LICENSE`). That licence is a grant
by this project's authors and it is deliberately narrow:

- **It covers this repository's source code only** — the plugin's own files, as
  shipped. That is the whole of what MIT grants here.
- **It does not cover upstream market data.** Quotes, candles, profiles, listings
  and any other values the plugin fetches belong to the upstream operators, not
  to this project. MIT grants you no right to that data, and the plugin's licence
  cannot create one.
- **It does not cover provider names or trademarks.** "Yahoo Finance", "Stooq",
  "东方财富 / Eastmoney", "腾讯财经 / Tencent", "新浪财经 / Sina", "Nasdaq",
  "Binance", "Gate.io", "CoinLore" and "TradingView" are the property of their
  owners. Their appearance in this repository, in the UI or in this document is
  identification of a data source, not a licence, endorsement or affiliation.
- **It does not cover embedded third-party content.** The TradingView embed is
  TradingView's own content loaded from TradingView's own URL; MIT does not reach
  it, and a fork that rehosts or modifies it needs its own basis for doing so.
- **It grants no data licence.** MIT gives you rights in software. Access,
  storage, display and onward use of market data are governed by each provider's
  terms, which remain the operator's responsibility.

Practically: you may fork and modify the code under MIT, and you must still clear
the data question with each provider you keep enabled.

## Conservative defaults for bulk access

The plugin's shipped behaviour is a conservative default for high-frequency or
bulk access, not a tuned-for-throughput client. The mechanisms, all in code:

- **No full-market scraping loops.** There is no crawler and no recursive link
  following. The only bulk path is the listing walk, and it is capped at
  `UNIVERSE_PAGE_SIZE: 100` rows per page and `UNIVERSE_PAGE_LIMIT: 200` pages per
  board (`lib/trading/config.js:661-662`), under a wall-clock budget of
  `budgetMs: 15 * 60_000` (`lib/trading/config.js` `UNIVERSE_POLICY`) with a
  `minRestartIntervalMs: 30000` floor between refreshes.
- **Per-request host cooldown.** A request touches at most
  `maxHostsPerRequest: 6` hosts and each host is then rested for
  `hostCooldownMs: 45000` (`lib/trading/config.js:152-155`) — mirror rotation is
  spread out rather than hammered.
- **Pagination caps.** Klines page under `klineMaxPages: 4` and one page caps at
  1000 rows; candle responses are served as the newest window rather than paged
  further where the provider offers no cursor; the listing walk is capped as
  above.
- **Manual refresh throttling.** A refresh cannot restart faster than
  `minRestartIntervalMs: 30000`, `universeRefresh` is limited to 2 per 4 minutes
  and `brief` to 6 per 30 minutes in `API_POLICY`
  (`lib/trading/config.js:519-532`), on top of `perUser: 240` and `global: 1200`
  per minute and the per-provider upstream bucket
  (`rateLimitPerMinute: 120`, `lib/trading/config.js:365`).
- **Shared caching instead of per-user fan-out.** The cache is process-wide and
  keyed by symbol, never per user (`lib/trading/cache.js:10-12`), so N viewers do
  not become N upstream calls.
- **Refusals are not retried harder.** A `4xx` other than `429` is `noRetry`
  (`lib/trading/http.js:536-537`), and a block by status or body text ends the
  attempt as `UPSTREAM_BLOCKED` (`lib/trading/errors.js:69-73`).

These defaults exist to protect the upstreams. If a provider's terms turn out to
require a lower rate, a different identifier or no automated access at all, the
correct response is to drop that provider from the chain — not to raise a limit.

## Third-party embed: TradingView

The detail panel can render a TradingView chart. That is the only third-party
**embed** in the plugin and it behaves differently from the nine data providers,
so it is called out separately:

- **The plugin does not fetch it.** The browser loads
  `https://s.tradingview.com/widgetembed/?symbol=…` in an `<iframe>`
  (`lib/client.js:1490-1495`, inside the card titled "TradingView (external
  embed)" at `lib/client.js:1488`), and the in-UI hint at `lib/client.js:1489`
  states that the values are TradingView's own and are not used by Trading Mode
  analytics. No TradingView bytes pass through the plugin, and nothing from that
  frame enters the local cache, the watchlist or the AI snapshot.
- **Branding and attribution are TradingView's.** The widget is used unmodified
  through its public embed URL; the plugin does not strip, hide, restyle or
  rehost the mark, and the surrounding link points at
  `https://www.tradingview.com/chart/?symbol=…` (`lib/client.js:1672-1674`).
  Whatever an embed is required to display, the widget displays for itself.
- **Requirements are not verified here.** TradingView's own widget/embed terms
  — permitted domains, attribution rules, commercial-use conditions — were not
  fetched while writing this document, exactly like the nine provider terms
  above. Treat the embed as **not verified** and check TradingView's current
  embed terms before shipping a fork, a hosted build or a commercial deployment.
- **It is separable.** Removing the embed is a client-side deletion of that card
  (`lib/client.js:1485-1496`); no host-side provider, chain entry or credential
  depends on it.

## Rules the code enforces

Each rule below names the mechanism and the file that implements it. These are
the constraints that make the design defensible; they are enforced by code, not
by convention.

- **One identifying user agent.** Every outbound request through `httpGet`
  sends `HTTP_POLICY.userAgent` (`lib/trading/http.js:520`), from
  `lib/trading/config.js:370-371`, so the plugin is identifiable and does not
  rotate identities. Provider-specific headers (`Referer`) are the ones the
  public page itself sends.
- **Timeouts and bounded retries with backoff.** `HTTP_POLICY.timeoutMs: 12000`,
  `retries: 2`, `retryBaseDelayMs: 350`, `retryMaxDelayMs: 2000`
  (`lib/trading/config.js:359-372`); the loop and the exponential delay live in
  `httpGet` (`lib/trading/http.js:478-577`, delay at line 573). A `4xx` other
  than `429` is marked `noRetry` and thrown immediately
  (`lib/trading/http.js:536-537`), so a refusal is never hammered.
- **Per-minute ceiling.** `HTTP_POLICY.rateLimitPerMinute: 120`
  (`lib/trading/config.js:365`) is a token bucket implemented by
  `class RateLimiter` (`lib/trading/http.js:46-66`), and one instance is built
  **per provider** in `lib/trading/providers/index.js:46`, so no single upstream
  can be driven faster than its own bucket.
- **Per-host and health cooldowns.** Eastmoney mirror rotation is bounded by
  `maxHostsPerRequest: 6` and `hostCooldownMs: 45000`
  (`lib/trading/config.js:152-155`). Capability health is tracked per
  `healthScope(provider, feature)` — `eastmoney::candles` can be cooling down
  while `eastmoney::search` keeps answering — by `class ProviderHealth`
  (`lib/trading/http.js:77-148`) with `failureThreshold: 3` and
  `healthCooldownMs: 60000` (`lib/trading/config.js:366-369`).
- **The router degrades instead of retrying forever.** `MarketDataRouter.run`
  (`lib/trading/router.js:64-125`) walks the configured chain once per request,
  skips providers whose scope is open, and when everything is cooling down
  probes only the single least-recently-failed candidate (half-open,
  `lib/trading/router.js:72-84`). A response that is too thin is treated as a
  failed attempt but deliberately not recorded as a health failure
  (`lib/trading/router.js:99-114`), and the fullest partial answer is returned
  marked `degraded: true` rather than looping.
- **Blocked or bot-walled responses are never worked around.**
  `looksBlocked(status, body)` (`lib/trading/errors.js:69-73`) maps `403`, `401`
  and `451`, or a body matching
  `access denied|are you a robot|unusual traffic|captcha|sad-panda`, to
  `CODES.UPSTREAM_BLOCKED` (`lib/trading/http.js:530-537`). The router
  aggregates an all-blocked chain into one `UPSTREAM_BLOCKED` error
  (`lib/trading/router.js:136-141`) and the API maps it to HTTP `503`
  (`lib/trading/api.js:56`). There is no proxy, no challenge solver and no retry
  chain that tries to look like something else.
- **Inbound quota.** `API_POLICY` (`lib/trading/config.js:519-532`) is enforced
  by `class QuotaLimiter` (`lib/trading/limits.js:21-118`): `windowMs: 60000`,
  `perUser: 240`, `global: 1200`, plus the expensive buckets `analyze`
  (20/60), `brief` (6/30) and `universeRefresh` (2/4). Every route counts before
  any upstream call (`lib/trading/api.js:203-214`), and a rejection answers
  `429` with a `Retry-After` header (`lib/trading/api.js:213`).
- **Concurrency gate.** `class ConcurrencyGate` (`lib/trading/limits.js:120-169`)
  with `maxConcurrentAnalyses: 2` per user and `maxConcurrentAnalysesGlobal: 4`
  (`lib/trading/config.js:530-531`) bounds how many expensive operations can be
  in flight; `expensive()` checks quota and gate before any upstream work and
  releases the slot in a `finally` (`lib/trading/api.js:145-170`), answering
  `RATE_LIMITED` → `429` (`lib/trading/api.js:57-58`).
- **A listing walk is budgeted and cancellable.**
  `UNIVERSE_POLICY.budgetMs: 15 * 60_000` (`lib/trading/config.js:625-629`) sets
  a deadline in `loadAll` (`lib/trading/universe.js:318-319`, checked at
  `:336-341`); when the budget is spent the walk stops cleanly, keeps the rows
  already absorbed, and reports `complete: false` with a reason
  (`lib/trading/universe.js:404-413`). `DELETE /api/trading/universe` is the
  cancel entry (`lib/trading/api.js:355-358` → `StockUniverse.cancel`,
  `lib/trading/universe.js:443-454`), and a refresh cannot restart faster than
  `minRestartIntervalMs: 30000` on top of its quota.
- **Listing-directory bounds.** `UNIVERSE_PAGE_SIZE: 100` and
  `UNIVERSE_PAGE_LIMIT: 200` (`lib/trading/config.js:614-616`) clamp one page and
  cap a walk at 200 pages per board (`lib/trading/universe.js:197-198`, `:393`);
  `MAX_UNIVERSE_BYTES: 12 * 1024 * 1024` (`lib/trading/config.js:687`) caps the
  persisted snapshot, and an oversized snapshot is refused while the previous
  copy is kept (`lib/trading/universe.js:98-102`, `:540-544`). The directory is a
  **local cache of listing metadata** (symbol, name, board, exchange, industry),
  not a redistribution: it is written to the local DSH profile
  (`<DSH home>/trading-mode/universe.json`) and read only by this installation.
- **Caching instead of re-fetching, with stale labelling.** `CACHE_TTL` and
  `maxStaleAge` (`lib/trading/config.js:349-356`) are applied by the cache layer
  (`lib/trading/cache.js:58-114`): a fresh hit is served without an upstream
  call, and an expired entry may be served only as a labelled fallback when the
  loader fails, up to the `maxStaleAge` ceiling. The envelope then carries
  `stale: true` with a `staleReason` (`lib/trading/service.js:520-548`), and the
  AI snapshot forwards the data age and staleness so old data is never described
  as live (`lib/trading/api.js:600-630`, recency policy in
  `lib/trading/config.js:501-512`).

## What the plugin does not do

- **No order placement.** There is no buy, sell, transfer or order endpoint in
  the plugin — no code path that could move money or position, and the API
  surface (`lib/trading/api.js`) exposes research reads plus the local watchlist
  only.
- **No brokerage credentials.** The plugin never asks for a broker login, an API
  key, a secret or a session token, and stores none.
- **No personal-data collection.** It collects no name, email, address, phone
  number or payment detail. The only user-scoped state is the DSH user id that
  keys the local watchlist and the display-language preference
  (`lib/trading/api.js:684-690`), and both stay on this machine.
- **No cross-device sync.** Watchlist and preferences are profile-local; the
  plugin's own config states `crossDevice: false` (`lib/trading/api.js:684-690`),
  matching the storage table in [`COMPATIBILITY.md`](COMPATIBILITY.md).
- **No resale or redistribution.** The plugin bundles no market-data files and
  has no export or publish path; it renders values in the local panel for the
  operator. Any onward distribution of the data is the operator's act, not the
  plugin's.
- **No bulk scraping beyond the documented listing walk.** The only bulk
  behaviour is the listing walk described above, bounded by pagination limits,
  a wall-clock budget and a per-minute ceiling. There is no crawler, no
  recursive link following, and no background process that fetches outside a
  user-requested operation.
- **No CAPTCHA or paywall circumvention.** A challenge, a `403`/`401`/`451` or a
  bot-wall body ends that attempt; the plugin reports the block instead of
  trying to look like a browser session it does not have.
- **No paid or authenticated feeds.** Every configured host is a public
  unauthenticated endpoint; the plugin holds no subscription, key or entitlement
  of its own, and the plugin's value does not depend on one.

## If you are the operator

- [ ] Check each provider's **current** terms of use yourself, for the
      jurisdictions and use you have in mind. Nothing in this repository is a
      substitute for that reading, and none of the nine provider terms were read
      while writing this document — see
      [Provider terms and access details](#provider-terms-and-access-details) for
      the URL tried and the exact `not verified` status per provider.
- [ ] Re-read the **MIT scope** note before treating the plugin's licence as a
      data licence: it covers this source code only, not upstream data, provider
      names or the embedded widget.
- [ ] Keep the default rate limits (`HTTP_POLICY.rateLimitPerMinute: 120`,
      `API_POLICY.perUser: 240` / `global: 1200`, the expensive buckets) unless
      you have a reason and a right to raise them. They exist to protect the
      upstreams, not to be tuned away.
- [ ] Use a **licensed feed** if you need redistribution, commercial use,
      display to third parties, or guaranteed real-time data. This plugin and its
      public endpoints are not that licence.
- [ ] Respect the disclaimer: market data and AI analysis are informational only
      and are not financial advice (`DISCLAIMER`, `lib/trading/config.js:534-535`).
- [ ] Re-read this document when the plugin version changes — the provider set,
      the chain defaults and the limits are configuration, and a new version can
      change all three.

This document describes the compliance boundary of `dsh-trading-mode` version
**0.8.1** (`package.json`).
