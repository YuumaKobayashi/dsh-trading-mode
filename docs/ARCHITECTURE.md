# Architecture

`dsh-trading-mode` is a **DSH (DeepSeek Harness) Cordis plugin**. It adds a market-research
panel to the DSH web UI: watchlists, quotes, candles, indices, technical indicators and an
AI research brief. It is **research only** — it never connects to a broker, never places an
order and never claims to be real-time.

The package ships **two halves from one `package.json`**:

| Half | Entry | Loaded by |
| --- | --- | --- |
| Host (Node) | `lib/index.js` | the DSH plugin loader (`main`), one Cordis plugin |
| Client (browser) | `lib/client.js` | the DSH web UI (`exports["./client"]`, `dsh.client.platform: "web"`) |

Both are plain ESM/JS; there is no build step and no runtime dependency (`dependencies` is
empty on purpose — a plugin that needs a library has to bundle it).

---

## Host half — `lib/index.js`

`apply(ctx, config)` composes the modules and owns the lifecycle. It does no market-data
access, no indicator maths and no prompt text.

- `export const inject = ['connection', 'webServer']` — the web server serves the prefix
  route, and the `connection` service owns the request fence (see `api.js` below).
- `export const TRADING_API_PREFIX = '/api/trading'` — the single prefix route.
- **`serviceGetter(ctx, name)`** resolves a host service *lazily* (three lookup routes:
  `ctx.get`, `ctx.root.get`, property access). This exists because the plugin applies before
  every service is guaranteed to be registered — the `llm` plugin may bind after this one —
  so `TradingAi` is handed a getter, not a value. A missing service degrades to `null`
  instead of a load-time failure.
- **Wiring** (`ready()`): `resolveIdentity()` → `StockUniverse` → `MarketDataService` →
  `WatchlistStore` → `UserSettingsStore` → `TradingAi` → `ApiRoutes`. State lives under the
  harness home (`$DSH_HOME/trading-mode/…`, or `~/.dsh/trading-mode/…`); `cachePath`,
  `settingsPath`, `universePath` and `identity.localBucket` may be overridden through plugin config.
- **`resolveIdentity(config, logger)`** (0.8.0, replaces the old `resolveUserId()`) is the only
  place an identity is decided, in order: ① the harness anonymous-user-id service
  (`getOrCreateAnonymousUserId()` → source `host-anonymous-id`); ② an operator-declared
  `config.identity.localBucket` (source `configured-local-bucket`, for a single-user profile —
  logged as a warning because every browser on that profile then shares one bucket); ③ neither →
  `{ id: null, source: 'none' }`, and the HTTP layer refuses per-user data with `503 NO_IDENTITY`
  instead of falling back to a shared literal. The plugin deliberately does **not** invent an
  identity from a machine name, a port or a cookie, because any of those would be
  attacker-chosen or unstable.
- **`PLUGIN_VERSION`** is read from `package.json` at load time (best effort, `null` on failure)
  and is what `GET /api/trading/health` reports, so a stale junction install is visible.
- **Startup log** names the fence verdict and the identity source: `request fence: host`,
  `OPEN — loopback debugging exception` or `unavailable — the API refuses with 503`, plus
  `identity: <source>`; a missing fence without the exception also logs a `SECURITY` error line.
- **`applyUserConfig(config, logger)`** applies user configuration at startup: per-market
  provider chains (`config.providers`) and the transport mode (`config.networkMode`). A bad
  value is reported **once** and the shipped default stays in force — never a silent change
  and never a failed start.
- **Route registration**: `webServer.register({ kind: 'prefix', path: '/api/trading',
  handler })`. If initialisation failed, the handler answers `503` with
  `{ ok: false, error: { code: 'INIT_FAILED' } }` rather than a 404 or an empty success.
- **Dispose**: the route disposer, `api.dispose()` and flushes of the watchlist, settings,
  universe snapshot and market cache run through `ctx.effect`.

## Trading core — `lib/trading/*.js`

| Module | Responsibility |
| --- | --- |
| `service.js` | `MarketDataService`: the single seam between business logic and the outside world. Validates/normalises requests, serves through the cache, delegates upstream work to the router (never to a provider directly), decorates every payload with `source` / `timestamp` / `delaySeconds` / `stale` / freshness note, and turns any unrecoverable condition into a typed error. Public surface: `resolveSymbol` / `resolveRange` / `resolveInterval`, `getQuote`, `getCandles`, `getProfile`, `getTechnicals`, `search`, `listIndices`, `listCrypto`, `universePage`, `universeRefresh`, `universeStatus`, `status`. |
| `router.js` | `MarketDataRouter`: `chainFor(market)` (ordered ids from `MARKET_DATA_CONFIG`, filtered to registered providers), `candidates(feature, market, interval, symbol)` (capability + interval + symbol filter, healthy first), `run(req)` (walks the chain, records health, half-open probe when everything is cooling down), `aggregate(req, attempts, tried)` (folds failures into one typed error) and `status()`. It is the **only** place that knows chain order. |
| `http.js` | Transport and resilience primitives: `RateLimiter` (per-provider token bucket), `ProviderHealth` (consecutive-failure tracker that trips a cooldown), **`healthScope(provider, feature)`** (health is keyed per provider *capability*, so a flaky candle endpoint cannot take provider search/quote down with it), `networkMode()` / `transportState()`, and `httpGet(url, opts)`. Transport is `node:http(s)` — not global `fetch` — with gzip/br decompression, redirect following, per-attempt address-family policy in compatibility mode, and typed errors (`UPSTREAM_TIMEOUT`, `UPSTREAM_BLOCKED`, `UPSTREAM_ERROR`, `PARSE_ERROR`). |
| `providers/*.js` | One module per upstream (`yahoo`, `eastmoney`, `tencent`, `stooq`, `sina`, `nasdaq`, `binance`, `gate`, `coinlore`). Each implements the same `MarketDataProvider` shape (`supports`, `supportsInterval`, `supportsSymbol`, `getQuote` / `getCandles` / `getCompanyProfile` / `searchStocks` / `listSecurities` as applicable) and returns the same normalised schema — no provider payload reaches business code. `providers/index.js` holds `PROVIDER_CLASSES` and **`buildProviders()`**, which instantiates every configured provider with its own rate limiter. |
| `cache.js` | Two-tier market-data cache: an always-present in-memory map plus an optional persistent adapter. Keyed **per symbol, never per user** — four thousand users watching the same ticker cause one upstream request. |
| `persist.js` | `FileCachePersist`: the cache snapshot as one atomic JSON file (temp file + rename, debounced) under the harness home. It is a cache, so losing it costs latency, never correctness. |
| `settings.js` | `UserSettingsStore`: per-user UI preferences (currently the display language), atomic writes, corrupt file degrades to read-only defaults. |
| `watchlist.js` | `WatchlistStore`: **membership only**, private per DSH user, preferring the host `dsh-storage-domain` service and falling back to a JSON file. Prices are not stored here — they are public data served by the service/cache. |
| `directory.js` | `SymbolDirectory`: maps a ticker, an English name, a Chinese name or a bare HK number to the canonical unified symbol, merges live search hits over a seed table, and tags each market with its own venue and currency. |
| `universe.js` | `StockUniverse`: the full listing browser (boards per market, `page()`, `loadAll()` background walk, local searchable index, JSON snapshot, multi-feed fallback with an active-feed memory). Since 0.7.0 the walk is single-flight **and bounded**: a wall-clock budget (`UNIVERSE_POLICY.budgetMs`) plus `cancel()`, with `complete` / `reason` / `cancelled` / `budgetMs` in the result; `totalRows()` (not a two-market sum) is the single source for every size figure. |
| `symbols.js` | Canonical symbol parsing and provider dialect translation (`parseSymbol`, `providerKey`, `currencyOf`, `exchangeOf`, `venueName`, …). |
| `indicators.js` | Deterministic technical indicators (SMA/EMA/RSI/MACD/ATR, pivots, 52-week range, trend alignment, annualised volatility) — computed by the plugin, never by the model. Since 0.7.0 every result also carries `quality` from `technicalQuality()` (`full` / `partial` / `limited` / `insufficient`) so callers can tell "no value" apart from "not enough history". |
| `indices.js` | The curated index directory (15 headline indices across US/HK/CN/JP), alias resolution and the per-provider capability matrix (`indexSupportFor`). |
| `limits.js` | Inbound protection (0.7.0): `QuotaLimiter` (sliding-window per-user / global quotas with per-endpoint buckets, and a rejection that does not spend quota) and `ConcurrencyGate` (per-user / global in-flight ceiling for AI work). Pure accounting — no I/O, no knowledge of HTTP; `api.js` turns a denial into `429 RATE_LIMITED` + `Retry-After`. |
| `ai.js` | `TradingAi`: builds the structured input, calls the **host `llm` service**, assembles the streamed response locally, reparses/repairs JSON, retries and reports provenance. It also grades the snapshot's age (`recencyOf` / `qualityFor`, surfaced as `meta.dataQuality`) and appends `RECENCY_DIRECTIVE` to the system prompt so stale data may not be described as live. See the AI path below. |
| `api.js` | The HTTP surface: one prefix route, **fail-closed** request fencing (0.8.0), `GET /health` answered *before* the fence with only non-sensitive fields, dispatch, identity-gated per-user isolation, the inbound quota/concurrency gate, `/status` diagnostic redaction (`sanitizeStatus` / `redactDiagnostic`), the `{ ok, value }` / `{ ok, error }` envelope and the error-code → status mapping. Identity and fence logic live here; the *choice* of identity is `lib/index.js`. |

## Request flow

```
 web UI (lib/client.js)
        │  same-origin fetch, /api/trading/*
        ▼
 api.js ── GET /health: answered before any fence check (plugin state only)
        │  fence: connection.requestRejection(req) → 403/401; missing/failed fence → 503
        │         HOST_SECURITY_UNAVAILABLE for every other route (fail closed, 0.8.0)
        │  inbound quota → identity gate for per-user routes (503 NO_IDENTITY)
        │  route(method, segments, ctx) → service call
        ▼
 service.js ── validate · cache-through · decorate meta (source/timestamp/stale)
        │
        ▼
 router.js ── chainFor → candidates (capability + health) → run
        │
        ▼
 http.js ── rate limit · timeout · retries · transport mode
        │
        ▼
 upstream provider (providers/<id>.js)  →  normalised quote/candles/profile/listing
```

The chain is walked until one provider answers; a per-capability breaker skips providers
that are cooling down. An answer that arrives but fails validation (for example a candle
series with far too few bars for the requested range) is treated as a failed attempt and the
next provider is tried; if no provider clears the bar, the largest answer is returned and
flagged `degraded: true` so the UI can say the history is incomplete instead of pretending.

## AI path

```
 api.js  POST /api/trading/analyze/:symbol        (or /watchlist/analyze)
        ▼
 service.js  gathers a structured, already-computed snapshot (quote/profile/technicals)
        ▼
 ai.js  TradingAi.askJson(system, userText)
        │  ctx.get('llm').stream({ provider, model, messages, system, maxTokens, temperature, signal })
        ▼
 host llm service  (public StreamChunk protocol)
        │  block-start · text-delta · reasoning-delta · block-end · usage · finish
        ▼
 ai.js  local ChunkAssembler → text → repair() → JSON.parse() → validated output
```

- The plugin talks to the host LLM **only through the public `llm` service**. It does not
  import host-internal packages, so a host upgrade cannot break it and a missing `llm`
  service degrades to a clear `AI_UNAVAILABLE` with a reason (no silent failure).
- The stream is assembled locally against the documented `StreamChunk` union: only `text`
  blocks are read, reasoning blocks never leak into the JSON.
- The model route is: plugin config → the harness's current default model → discovery of a
  DeepSeek-capable provider. The model receives **only** the structured snapshot; it never
  fetches market data and never computes indicators.

## Client half — `lib/client.js`

The client is a **single client plugin** built from the same `package.json`
(`dsh.client.platform: "web"`, `exports["./client"]`). It must be a plain side-effect script:
it calls `window.__ModuleLoader__.load({ id, factory })`, takes React from the loader, and
contains no top-level ESM `import`/`export`.

It registers exactly two slots:

- `conversation.session.header.actions` (id `trading-mode`, order 30) — the "Trading Mode"
  button in the session header;
- `shell.overlay` (id `trading-mode-app`, order 500) — the full-frame panel overlay.

Inside the overlay: Home (search, watchlist, crypto spotlight, market overview, AI brief),
Detail (quote, candles, market data, technical grid, AI analysis, source links), a status
strip and two client-side preference switches — EN/中文 and Dark/Light (0.8.1). The browser only
ever talks to this host's own `/api/trading` endpoints — there is no third-party URL in the
browser and no direct front-to-upstream connection.

Two optional host services are bound when present, each behind an `typeof ctx.get === 'function'`
guard so a host that lacks them still loads the panel: `locale` (`bindPlatformLocale`, one-way —
adopt the platform language until the user chooses) and `theme` (`bindPlatformTheme` — adopt
`getTheme().active.colorScheme`, follow `theme/change` until the user chooses, then write the
user's choice back through `service.setTheme()`, which the host persists). The panel paints
itself from its own opaque palette in `.tm-layer` (`--tm-bg` / `--tm-text` / …) and only *maps*
the host aliases (`--dsw-alias-*`) inside that scope: a host alias that is undefined would make
`var(alias, fallback)` invalid at computed-value time — the fallback does not apply and the
background would become transparent — so no panel surface depends on it.

## Design invariants

These must not change without a deliberate, documented decision:

1. **Provider abstraction and one uniform schema.** Providers never call each other and
   business code never names one; adding an upstream means adding a provider module and a
   config entry, nothing else.
2. **Quotes and AI stay separated.** The model receives structured, system-computed data and
   is forbidden from inventing numbers; it never prices a security.
3. **Cache, timeout, retry and stale labelling.** Every payload carries its source, timestamp
   and freshness; delayed or cached data is labelled as such and never called live.
4. **Depend only on public host services** (`webServer`, `connection`, `llm`, storage domain,
   anonymous user id). Nothing imports another plugin's internals.
5. **Research only, never trade.** No brokerage connection, no order routing, no execution,
   no P&L.
6. **All configuration lives in `lib/trading/config.js`.** No endpoint, chain, TTL or timeout
   is hard-coded elsewhere, which is what makes the chains and the transport mode user
   configurable.
