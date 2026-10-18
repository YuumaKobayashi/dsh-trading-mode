# Roadmap

Current release: **0.8.1** (see `package.json`; the changelog is the authoritative history).

This project is a research tool for one DSH installation. It is deliberately not a trading
system, and the roadmap below is deliberately conservative: the honest constraint on progress
is upstream data availability, not UI work.

## Shipped

- **Five markets** quoted side by side: US, Hong Kong, mainland China (A-shares), Japan and
  crypto (`MARKETS = ['US', 'HK', 'CN', 'JP', 'CRYPTO']`).
- **Market data**: symbol search, quotes, candles (5m through weekly), a 15-index market
  overview across the four equity markets, a crypto spotlight, company profiles, and
  technical indicators computed by the plugin.
- **Watchlist**: private per user, membership only, reordering and favourites, surviving a
  restart; prices are fetched once per symbol and shared process-wide.
- **Listing browser**: full per-market listing tables with background walks, a local
  searchable index, and multi-feed fallback when a bulk endpoint is refused.
- **AI research**: single-stock analysis and a watchlist brief written by the harness's
  configured DeepSeek model through the host `llm` service. The model receives only a
  structured, system-computed snapshot and never fetches market data itself.
- **Bilingual UI**: English and Simplified Chinese, with the choice persisted per user.
- **Switchable scheme (0.8.1)**: the panel header toggles the window between white-on-black and
  black-on-white. Every surface is painted from the plugin's own opaque palette, so the window
  can never show the conversation behind it, and the choice is handed to the host `theme`
  service when one exists (persisted by DSH) instead of being stored by the plugin.
- **Source links**: every quote, chart and index links out to the public page for that
  instrument (TradingView, Yahoo Finance, eastmoney, Sina, Tencent, Yahoo!ファイナンス,
  Binance, Gate) opened in a new tab. Links only — nothing is scraped into the panel.
- **Operator controls**: per-market provider chains and a transport `networkMode`
  (`auto` / `standard` / `compatibility`) set through plugin config, validated at startup
  with the shipped default kept when a value is rejected.
- **Resilience**: per-provider rate limiting, timeouts with retries, per-capability health
  isolation with cooldowns, cache with session-aware TTLs, and explicit stale/degraded
  labelling instead of fabricated values.
- **Tests**: an offline suite (`npm test`, `node tests/offline/run.mjs`) that runs without
  network access, a release gate (`npm run test:release`) that refuses a build which skipped
  any check, plus optional network-gated checks, and a repository hygiene gate covering
  manifest, secrets, personal paths and the documentation set.
- **Inbound protection (0.7.0)**: per-user and global request quotas, dedicated buckets for the
  expensive endpoints (analysis, watchlist brief, listing walk) and a concurrency gate on AI
  analyses, all answering `429` with `Retry-After`; a rejected request never spends quota and
  never reaches an upstream.
- **Bounded, cancellable long tasks (0.7.0)**: a full listing walk has a wall-clock budget and a
  `DELETE /api/trading/universe` cancel entry, and reports `complete` / `reason`
  (`budget`, `cancelled`, `incomplete walk`) instead of quietly running on.
- **Honest freshness (0.7.0, renamed in 0.8.0)**: every analysis and brief is graded `fresh` /
  `delayed` / `stale` / `historical` / `unknown` by data age, the system prompt forbids describing
  stale data as live *whatever* the grade, `meta.dataQuality` travels with the answer, and the UI
  shows a note when an answer is not based on the newest available print.
- **Indicator sample-size grading (0.7.0)**: `quality` (`full` / `partial` / `limited` /
  `insufficient`) travels with the technical payload, and the panel shows a banner instead of
  rendering long-horizon indicators from too few bars.
- **Diagnostic redaction (0.7.0)**: `/status` collapses upstream URLs to their origin, masks IPs,
  bare host names and absolute paths, while provider ids and instrument symbols survive.
- **Fail-closed host fence (0.8.0)**: the HTTP layer now refuses every route with
  `503 HOST_SECURITY_UNAVAILABLE` when the DSH host does not supply `connection.requestRejection`
  (no more "missing fence means open"). `GET /api/trading/health` answers before the fence and
  publishes only plugin version, fence state and identity *source*, so an operator can tell
  "plugin down" from "plugin up, host fence missing" at a glance. The loopback debugging
  exception is explicit, default off, and logged loudly when used.
- **No shared storage bucket (0.8.0)**: per-user data needs a trustworthy id (host anonymous id,
  or an operator-declared `identity.localBucket` for a single-user profile). Without one,
  watchlist and settings answer `503 NO_IDENTITY` instead of silently sharing the old literal
  `local` bucket, while market data keeps working. `/status` and `/bootstrap` publish the identity
  *source* and whether it stores per-user data.
- **Reproducible release engineering (0.8.0)**: `package-lock.json` + blocking `npm ci` in CI,
  a blocking `npm run smoke:artifact` that packs, unpacks, whitelists and `node --check`s every
  shipped file (printing tarball sha256 and size), and `npm run inspect:profile`, a read-only
  check of what each DSH profile has installed and whether it is a junction or a copy.

## Known limitations

- **Japanese cash-equity historical candles have no reachable source.** Every candidate was
  measured: Tencent's Tokyo kline endpoint answers a single bar for any range, eastmoney's
  history hosts are reset from some networks, stooq and Yahoo answer 403, and the Japanese
  portals expose no structured endpoint. The chart therefore shows what exists and badges it
  `partial history` rather than drawing a line through one point.
- **`^N225` is single-source** (eastmoney's index secid). When that feed is unreachable the
  Nikkei tile is empty; the other four markets' tiles are unaffected.
- **Profiles for A-shares, Japan and the US depend on eastmoney.** Sina and Tencent publish
  no company profile, so when that feed is blocked the profile panel reports data
  unavailable instead of guessing.
- **Upstream reset and flakiness.** Bulk endpoints (listing tables, kline history) are
  periodically refused by their operators from some networks. The chains fall through to a
  second feed where one exists, and otherwise report a labelled failure; a provider's
  cooldown is scoped to the capability that failed so its other endpoints keep working.
- **Single-machine state.** The watchlist, preferences, listing snapshot and market cache
  live under the harness home directory on the machine running DSH. They survive a restart,
  but cross-device or multi-user sharing is not implemented and not promised.
- **Crypto naming.** Names and market capitalisation come from a ranked public directory;
  coins it does not list appear by ticker only.

## Next

- **More provider coverage per market** — the single highest-value item. A second reachable
  Tokyo history feed would remove the biggest limitation above; additional listing and
  profile feeds would reduce the number of capabilities that depend on one upstream.
- **Non-blocking online probes in CI** — the network-dependent checks already exist as a
  separate entry point; running them on a schedule and publishing the result (instead of
  gating merges) would catch upstream drift early without making builds flaky.
- **2–3 external trial users** on different networks and regions, to find out which
  providers are reachable elsewhere and whether the default chains are the right order for
  anyone who is not on the machine this was built on.
- **Shared rate limiting for multi-instance deployments** — the 0.7.0 quotas live in the
  process: two DSH instances on one machine each get their own 240 requests/minute, and a
  restart clears the window. Making the limiter host-scoped (or delegating it to a harness
  service) is the next step before this can be described as protecting a shared upstream
  budget rather than one process's share of it.
- **Compliance review that ages well** — `docs/DATA_COMPLIANCE.md` records which providers'
  terms were verified and when. Re-checking that list each release (and fetching the terms
  instead of citing second-hand summaries) is deliberately left as recurring human work.
  The 0.8.0 pass left 46 explicit `not verified` markers because most terms pages could not be
  fetched from this machine; closing them requires a network that the operators' pages accept.
- **Real screenshots** — `docs/screenshots/README.md` fixes the policy (real captures only, no
  fabricated placeholders). No capture has been taken yet, so the README deliberately embeds none.
- **Per-user storage backends** — keep the watchlist on the harness storage domain when it is
  available and make the file fallback explicit in the status output, so a future host
  service can be adopted without touching business code.
- **Broader storage scope only if the host provides it** — cross-device or shared watchlists
  depend on a host-level service that does not exist today; the plugin will not invent one,
  and will keep documenting the single-machine boundary until it does.
