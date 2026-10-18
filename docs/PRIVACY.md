# Privacy

`dsh-trading-mode` is a local DSH (DeepSeek Harness) plugin that shows market data and
runs research note generation over data it fetches from public providers. In one
paragraph: everything it stores lives in your local DSH profile on this machine, keyed by
the anonymous user id DSH assigns you; the plugin collects no telemetry and uploads no
usage data of any kind; the only outbound requests it makes are for market data and symbol
search from the public providers listed below, and the only place your own typed text
goes is the free-text question you enter on an analysis request, which is handed to the
model route your own DSH session is configured with (by default the DeepSeek route). The
plugin is research software: it never places an order, never connects to a broker or an
exchange account, and never handles an API key. This document describes what the code in
this repository actually does; where the code does not settle a question, this document
says so instead of guessing.

## Who this applies to

This document covers the plugin `dsh-trading-mode` version 0.8.1 as shipped in this
repository: the host half (`lib/index.js`, `lib/trading/*.js`) and the browser half
(`lib/client.js`). It does not cover DSH itself, the market data providers, or the model
provider you configure in DSH; each has its own terms and its own privacy policy.

## The HTTP surface and the DSH fence

The plugin registers exactly one HTTP surface, mounted at the prefix `/api/trading`:

```text
/api/trading
```

That prefix is served by the DSH host web server. It is not a standalone server, it has no
listener of its own, and the plugin adds no authentication of its own. The first thing the
plugin's request handler does is ask the host whether the request is allowed, by calling the
host connection's request rejection check. Two outcomes are possible before any plugin logic
runs: the host rejects the request as `403` with error code `FORBIDDEN` and the message
`this request did not pass the DSH host/origin check`, or it rejects it as `401` with error
code `UNAUTHENTICATED` and the message `no authenticated DSH browser session for this
request`.

Only when the host returns no rejection does the handler continue. A rejected request
never reaches storage, the market data service, or the model: the offline test suite
asserts that a fenced-off request leaves the watchlist store untouched.

Since 0.8.0 the fence fails closed. If the host connection is unavailable, if its request
rejection check is missing, or if that check throws, every endpoint answers `503` with code
`HOST_SECURITY_UNAVAILABLE` and the request is refused before quota accounting, storage and
upstream calls. The single exception is `GET /api/trading/health`, which is answered before
the fence and carries no data at all — it reports the plugin name and version, whether the
fence is available, and the identity *source* (never the identity itself), so you can tell a
blocked deployment apart from a broken one without opening a data route. One explicit operator
opt-out exists (`security.allowUnfencedLoopback` in the plugin configuration): when it is set
to `true`, requests whose peer address is loopback are served without the fence, the plugin
logs an error-level `SECURITY` line each time, and remote peers are still refused. It ships
disabled.

Because the fence is the host's, the security of this surface is exactly the security of
your DSH host session. Do not expose `/api/trading` directly to a network and do not treat
it as an authenticated API in its own right: anything that can talk to the DSH host as an
accepted session can use it — and if the configuration above ever disables the fence, so can
local processes.

## Identity

Every write the plugin performs acts as the user id the host identified for that request.
No route reads a user id, account name, or email from the request body or the query string.

The plugin asks the host for an anonymous user id (`@deepseek-ai/dsh-anonymous-user-id`
when that host module is available). If the host offers none, the plugin uses the single
local bucket you configured as `identity.localBucket` — an explicit single-user choice, logged
as a warning, not a default — and if you configured none either, there is no identity at all.
The plugin never invents one.

Since 0.8.0 "no identity" is a first-class state rather than a silent fallback to a shared
`local` bucket: watchlist and preference reads/writes answer `503` with code `NO_IDENTITY`
and touch no store, while the read-only market-data endpoints (quote, candles, indices,
universe, search, profile, technicals) keep working and store nothing per user. The offline
test suite asserts this directly: requests that carry `userId=attacker` or `user=attacker` in
the body or query still act as the caller, two identities sharing one storage backend never
see each other's watchlist, and a request without an identity leaves the stores untouched.

The id is a local scoping key, not an account, and it is not transmitted anywhere by the
plugin. The plugin publishes the resolved id as `userId` in the `/api/trading/status`
payload for diagnostics (local, behind the fence); `GET /health` publishes only the source,
never the id. Rate limiting counts requests under a separate, non-identifying metering key
(the resolved id when there is one, otherwise the constant `shared`), so the quota ledger is
not a second copy of your identity.

## What the plugin stores, and where

Two kinds of user data are stored, both local to this machine and this DSH profile:

- the watchlist, which stores membership only (`id`, `userId`, `symbol`, `market`, `name`,
  `nameZh`, `exchange`, `currency`, `position`, `isFavorite`, `createdAt`, `updatedAt`) for
  at most 50 symbols. It stores no quantity, no purchase price, no portfolio value, and no
  brokerage or account identifier, because the plugin has no such concept;
- preferences, which as of 0.8.0 are the interface language only (`lang` is `en` or `zh`,
  plus an `updatedAt` timestamp) stored per user id.

The panel also offers a colour scheme (black-on-white / white-on-black, 0.8.1). That choice is
**not** stored by this plugin: when the host exposes its client `theme` service the panel asks
that service to set the DSH theme preference (`setTheme('dark' | 'light')`), so the value lives
in DSH's own theme settings and is covered by DSH's privacy policy. Without that service the
choice lasts for the browser session only and nothing is written. The panel's colours are a
private palette inside this plugin; no image, screenshot or usage data leaves the page.

Both live in the local DSH profile. When the DSH storage domain module is available, the
watchlist is written as the domain `trading_watchlist` version 1 through that storage; when
it is not, the plugin falls back to a JSON file in your DSH home directory:

```text
<DSH home>/trading-mode/watchlist.json
<DSH home>/trading-mode/settings.json
```

The DSH home directory is `$DSH_HOME`, else `$DSH_DIR`, else `~/.dsh`. The plugin writes
these files atomically (temporary file plus rename) and degrades to read-only rather than
corrupting them if one cannot be parsed.

The market data cache is stored alongside them:

```text
<DSH home>/trading-mode/market-cache.json
```

with an in-memory layer that is always present, and a bounded on-disk snapshot (at most 500
cache keys and 4 MiB) so cached quotes can still be served, clearly labelled as stale,
after a restart.

There is no cross-device sync and no cloud copy of any of this. There is no account, no
login, no server-side profile, and no export or import path that would move it anywhere.
The plugin's own `/api/trading/status` response publishes a `storage` block in its
configuration that states `"scope": "profile-local"`, `"crossDevice": false`, and the note
`Watchlist and preferences live in the local DSH profile on this machine, keyed by DSH user
id; cross-device sync is not provided by this plugin.`

Because the storage is local, anyone with access to your machine and your DSH home
directory can read it, and any local backup tool that copies that directory will copy it
too. Treat the watchlist as you would any other file in your DSH profile.

## Telemetry

There is none. A search of the plugin source for telemetry, analytics, reporting, beacon,
tracking and upload keywords finds only prose and comments; there is no analytics client,
no crash reporter, no usage counter that leaves the process, and no phone-home call. The
plugin does not report which symbols you look at, which analyses you run, or how often you
open the interface. The counters that exist (`analyses`, cache hits and misses, stale
serves) are in-process diagnostics surfaced in `/api/trading/status` and are never
transmitted.

## Outbound network traffic

The plugin makes outbound HTTP requests for exactly two purposes: fetching market data and
symbols from public providers, and handing an analysis prompt to the model route your DSH
session is configured with. It makes no request to any endpoint that is not one of those
two.

The providers are declared in the plugin's provider configuration. Each is identified by a
provider id, and each has a fixed host or hosts:

| Provider id | Host(s) | What it is used for |
| --- | --- | --- |
| `yahoo` | `query1.finance.yahoo.com`, `fc.yahoo.com` | US and HK quotes, charts, profiles, search |
| `stooq` | `stooq.com` | US and HK end-of-day candles |
| `eastmoney` | `push2.eastmoney.com`, `push2his.eastmoney.com`, `searchapi.eastmoney.com`, and up to six numbered `push2*.eastmoney.com` mirrors per request | US, HK, CN and JP quotes and candles |
| `tencent` | `qt.gtimg.cn`, `web.ifzq.gtimg.cn` | US, HK, CN and JP quotes and candles |
| `sina` | `stock.finance.sina.com.cn`, `vip.stock.finance.sina.com.cn`, `money.finance.sina.com.cn` | US, HK and CN quotes, candles and listings |
| `nasdaq` | `api.nasdaq.com` | US listing directory |
| `binance` | `data-api.binance.vision` | crypto quotes and candles |
| `gate` | `api.gateio.ws` | crypto quotes, candles and pair directory |
| `coinlore` | `api.coinlore.net` | crypto directory (names), never used to answer a quote |

What is sent is limited to the lookup itself: a symbol or a search term, an interval, a
range, a page or a limit, and for a couple of providers a referer header that the provider
expects. No user id, no profile data, no watchlist contents as a batch, no question text
and no analysis result is sent to a market data provider. Which provider answers a given
symbol is a routing decision made by the plugin, not something you configure per request.

The plugin applies its own client-side politeness rules to those requests so that a busy
interface does not hammer a public endpoint: a 12 second timeout, 2 retries with backoff,
a limit of 120 outbound provider requests per minute, a shared user agent string, per
provider failure tracking, and a 60 second cooldown after three consecutive failures.
Inbound traffic to the plugin is limited too, per user and globally, with stricter buckets
for the expensive routes (analysis, brief, universe refresh) and a cap on concurrent
analyses. Those limits are operational, not privacy measures, but they also mean a stuck
client cannot turn into a flood against a third party.

One browser-side caveat you should know about. The plugin's interface can embed a
third-party TradingView chart widget in an iframe, which the browser loads directly from
`s.tradingview.com` with the symbol, interval, theme and locale in the URL. That request
comes from your browser, not from the plugin's host process, and TradingView's own policy
applies to it. The interface labels this panel as an embedded third-party chart whose
values are not used by the plugin's own analytics. If you do not want that request to
happen, do not open that panel.

## Analysis and the DeepSeek model

The plugin never calls DeepSeek itself and never handles a DeepSeek API key. It does not
send HTTP requests to a model provider, and it does not contain provider credentials.
Instead, it assembles a snapshot and hands it to the DSH host model service, which streams
the completion using the model route your DSH session is configured with. Any request the
provider sees is made by DSH, in the same way as any other DSH conversation, and your
provider's own privacy policy and terms govern what happens to it.

For a single symbol analysis (`POST /api/trading/analyze/:symbol`), the payload handed to
the host model service contains:

- the symbol and market;
- company profile fields: name, localized name, exchange, currency, industry, sector,
  country, and a description truncated to 900 characters;
- quote fields: price, change, change percent, open, high, low, previous close, volume,
  provider timestamp, source, provider delay, and a stale flag;
- data age and recency information, and a `dataAvailability` block naming which fields were
  missing;
- technical indicator values with the bar count and interval, trend alignment, level values
  and an availability flag;
- the last 20 daily closes with timestamps and volumes;
- whether the market session is currently open;
- the language of the request, and the free-text question you typed, if you typed one.

For a watchlist brief (`POST /api/trading/watchlist/analyze`), each row contains the symbol,
name, market, currency, price, change, change percent, volume, 20 day volume ratio, RSI 14,
MACD histogram, the 20, 50 and 200 period moving averages, trend alignment, 52 week high and
low, timestamp, source, stale flag, an unavailable flag and any per-symbol error; together
with the same age and quality metadata for the whole set.

The only text that originates from you in either payload is the analysis question you type
and the interface language. No account identifier, no user id, no watchlist membership list
beyond the rows being briefed, no holdings, and no device or location data is included. The
watchlist brief necessarily reveals which symbols you asked to brief, because that is what
it is about.

Model selection is DSH's: the plugin uses an explicitly configured provider and model if
one is set for it, otherwise the default model selection of your DSH session, otherwise the
first available route that looks like a DeepSeek model. The plugin does not pin a provider
of its own and does not fall back to a different vendor behind your back; when no route is
available, analysis fails with `AI_UNAVAILABLE` and a message telling you to configure a
model in DSH.

## Freshness labelling in the interface

The interface labels data age rather than implying real time. The freshness component shows
the provider timestamp as `Updated <time>` with the source, then either `Data may be
delayed` or, when the data is stale, `Last available data`; hovering explains the reason
the cached value was served.

Analysis answers carry a data quality grade computed from the age of the input: `live`,
`delayed`, `stale`, or `historical`. When the grade is not `live`, the interface states
that the analysis is based on delayed data, or on the last available data rather than a
live quote, and the answer metadata repeats the grade, the stale flag, the quote source and
the plugin disclaimer. The prompts sent to the model forbid describing delayed data as live
market data and forbid inventing prices.

Treat a grade of `delayed`, `stale` or `historical` as a warning that the numbers are not a
current quote.

## Diagnostics and scrubbing

`GET /api/trading/status` reports plugin health: service status, model status, watchlist
storage information, the resolved user id, the current preferences, the published
configuration, and the rate limits. Information that could reveal infrastructure details is
scrubbed before the response is built. Diagnostic fields are treated as sensitive by key
name: `lastError`, `error`, `errors`, `message`, `reason`, `detail`, `base`, `endpoint`,
`endpoints`, `url`, `urls`, `host`, `hosts`, `path`, `filePath`, `nextUrl`. Inside those
fields, an upstream URL becomes `<origin>/...`, an IPv4 address becomes `[redacted-ip]`, a
bare host name becomes `[redacted-host]`, and an absolute path becomes `.../<basename>`.
Symbols such as `600519.SH` or `BTC-USD` and provider ids are deliberately left intact, so
market identifiers remain readable in diagnostics.

This scrubbing is a hygiene measure, not a guarantee: it applies to the status payload, and
you should still treat logs and status output as local operational data.

## Cache retention

Market data is cached locally so the interface stays responsive and so a provider hiccup
does not empty the screen. Time to live depends on whether the market for that symbol is
open:

| Cached data | Market open | Market closed |
| --- | --- | --- |
| Quote | 20 seconds | 10 minutes |
| Candles | 60 seconds | 30 minutes |
| Technical indicators | 60 seconds | 30 minutes |
| Company profile | 24 hours | 24 hours |
| Search results | 10 minutes | 60 minutes |

A cached entry can still be served after its time to live when the provider cannot be
reached, up to a hard ceiling: quotes 72 hours, candles 7 days, technical indicators 24
hours, profiles 30 days, search results 24 hours. Anything served that way is marked stale
in the response and labelled in the interface, and the reason is logged locally.

The cache is local only. It contains market data for symbols you or the interface looked
at, which means it can indirectly reveal which symbols those were. Deleting it removes the
cache; it is rebuilt on demand.

## What we do not collect

- No account, no email address, no name, no phone number, no login of any kind.
- No telemetry, analytics, crash reports, or usage statistics.
- No holdings, positions, quantities, cost basis, portfolio value, or brokerage
  credentials: the plugin has no order routing and no brokerage connection.
- No payment or billing information, no device fingerprint, no advertising identifier, and
  no location data.
- No DeepSeek or provider API key, and no cross-device profile or cloud copy of the
  watchlist and preferences.

## Research use and third-party terms

This plugin is for research and information only. It places no orders, connects to no
broker, and gives no investment advice. Market data may be delayed, incomplete, or wrong,
and analysis text is generated by a model that can be mistaken; verify anything you intend
to act on against a primary source.

You are responsible for complying with the terms of each data provider you reach through
this plugin, and with the terms of your model provider: their availability, rate limits,
attribution requirements and handling of the requests your machine makes are outside this
plugin's control. The plugin ships a data source inventory in `docs/DATA_SOURCES.md` that
lists providers, markets and endpoints, and a compliance-oriented companion note in
`docs/DATA_COMPLIANCE.md` that records which providers' terms were verified (and which were
not) in this release. Read them together, and read each provider's own terms for the rest.

## How to remove your data

Everything the plugin stores is local, so removal is local:

1. Remove the watchlist and preferences from the interface, or
2. uninstall the plugin from DSH, or
3. delete the plugin's storage. With the DSH storage domain backend, remove the
   `trading_watchlist` domain data for your user through DSH's storage tooling. With the
   file fallback, delete the files under your DSH home directory:

```text
<DSH home>/trading-mode/
```

That directory holds `watchlist.json`, `settings.json`, `market-cache.json` and cached
universe data; deleting it removes the watchlist, the language preference and the market
data cache. Nothing needs to be deleted on a server, because nothing was ever uploaded, and
no deletion request needs to be sent to the plugin's authors, because they hold no copy of
your data.

## Changes to this document

This document describes plugin version 0.8.1 and is versioned with it. When a release
changes what the plugin stores, where it sends data, or that it sends certain data at all,
this document is expected to be updated in the same release and the plugin version here
updated to match. If this file's version does not match the installed plugin version, treat
this document as out of date and prefer the behaviour of the installed code.

Some things are outside the plugin's code and therefore outside what this document can
state: what your model provider does with the prompts DSH sends it, what the market data
providers do with the requests your machine makes, and what the embedded third-party chart
widget does in your browser. Read the corresponding privacy policies for those.
