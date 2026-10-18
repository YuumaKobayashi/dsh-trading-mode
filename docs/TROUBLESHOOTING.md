# Troubleshooting

Symptom → cause → fix, grounded in what the plugin actually checks. If the panel is
empty or every request fails, start with the unfenced health probe — it answers even
when the plugin is refusing everything else (0.8.0):

```text
GET /api/trading/health
```

It returns only `plugin`, `version`, `api`, `fence`, `identity` and `note`. If `api` is
`blocked` (or `ready-on-loopback-only`), the host did not provide a request fence and
every data route is answering `503 HOST_SECURITY_UNAVAILABLE` by design — see §8. If the
version here disagrees with `package.json`, the profile is loading a stale copy (see
`npm run inspect:profile`).

For everything else, the status endpoint answers what a bug report needs without
reading source (it is fenced, so it needs a working host session):

```text
GET /api/trading/status
```

It returns the market-data status plus `ai`, `watchlist`, `userId`, `settings`,
`limits` and `config`:

- `providers[]` — per provider: `healthy`, `degraded`, `calls`, `successes`,
  `failures`, `consecutiveFailures`, `cooldownRemainingMs`, `lastError`, and a
  **per-capability** `scopes` map (`search`, `quote`, `candles`, `profile`,
  `universe`). Diagnostic values are redacted: an upstream URL becomes
  `<origin>/...`, an IPv4 address becomes `[redacted-ip]`, a bare host becomes
  `[redacted-host]`, an absolute path becomes `.../<basename>`.
- `transport` — `mode`, `compatibilityHosts[]`, `workingFamilies{}`.
- `chains` — the effective chain per market, in order.
- `config` — `providerChains`, `providerChainProblems`, `networkMode`, `aiModel`.
- `ai` — `available`, `state`, `reason`, `route`, `lastRoute`, `calls`,
  `failures`, `lastError`, `maxTokens`, `timeoutMs`.
- `identity` — `source` (`host` / `localBucket` / `none`), plus `userId`
  (`null` when there is no trustworthy identity).
- `limits` — the quota ledger: window, per-bucket `used`/`limit` and the
  in-flight AI count.
- `fenceFailures` — how many requests the plugin refused because it had no fence.
- `counters` — `quotes`, `candleRequests`, `analyses`, `briefs`, `searches`,
  `degraded`; `cache` — the cache snapshot; `universe` — the listing index.

## 1. "AI brief / AI analysis is unavailable"

**Symptom.** The brief button is disabled, or the panel shows
`DeepSeek is not available in this DSH session… Reason: …`, or a request fails with
`AI_UNAVAILABLE`.

**Cause.** The plugin talks to the host LLM service; there is no bundled client and
no API key inside the plugin. `ai.reason` names the exact blocker:

| `ai.reason` | Meaning |
| --- | --- |
| `the plugin did not receive the llm service (ctx.llm)` | the plugin was composed without the `llm` service wired in |
| `ctx.get("llm") is not registered (is the dsh-llm plugin loaded?)` | the host has no `llm` service registered (the LLM plugin is disabled or missing) |
| `the llm service exposes no stream() method` | an unexpected `llm` implementation |
| `no DeepSeek model route is configured in DSH` | no default model and no discoverable DeepSeek model |

The host log carries the same text on startup:
`trading-mode: ready (…; ai: available)` or
`…; ai: unavailable — <reason>)`.

**Fix.**

1. Enable the host LLM plugin so `ctx.get('llm')` resolves, and set a default model
   in the DSH GUI (`agentDefaultModel`). The plugin prefers that selection, then
   falls back to any provider advertising a `deepseek`-named model.
2. Re-check `GET /api/trading/status` → `ai.available === true` and `ai.route`
   naming a provider/model.
3. If it is still unavailable, the message is authoritative: the plugin **streams
   through `ctx.get('llm')` only** and imports no private host package, so a
   missing service cannot be worked around from the plugin side.
4. A failing call reports the model's own failure:
   `DeepSeek analysis failed: …` (retried up to 3 times with backoff for
   rate-limit / server / timeout / empty / invalid-output codes). Check
   `ai.failures`, `ai.lastError` and the `counters.analyses` / `counters.briefs`
   movement.

## 2. "Quotes work, but candles fail"

**Cause.** Health is tracked **per provider capability**, not per provider
(`healthScope(provider, feature)` → `eastmoney::candles`). A single flaky endpoint
opens a cooldown for that capability only; the other capabilities keep answering.

**Diagnose.** Look at the provider's `scopes` in the status payload:

```json
{ "id": "eastmoney",
  "scopes": {
    "search":  { "healthy": true,  "successes": 12, "cooldownRemainingMs": 0 },
    "quote":   { "healthy": true,  "successes": 30, "cooldownRemainingMs": 0 },
    "candles": { "healthy": false, "failures": 3, "cooldownRemainingMs": 41230,
                 "lastError": "… socket hang up" } } }
```

**Fix.** Wait out `cooldownRemainingMs` (the chain tries the next source
meanwhile), or reorder that market's chain so a provider with a working candle
endpoint comes first (see §3). This is by design: a refusal on one endpoint is not
evidence that the provider is dead.

## 3. "Every upstream for a market fails" / `socket hang up`

**Symptom.** Quotes and candles for one market fail together, `lastError` mentions
`socket hang up`, `ECONNRESET`, `ETIMEDOUT` or `EAI_AGAIN`, and all live requests
are cycling through the chain.

**Cause.** A transport-level failure, typically a network whose IPv4/IPv6 path to
that host accepts the connection and then resets it. The plugin's transport
distinguishes this from a server verdict: an HTTP 403/429 does *not* switch policy.

**Fix.**

1. Set `networkMode: compatibility` in the plugin entry so the transport pins one
   address family per attempt and flips between them:

   ```yaml
   - id: trading-mode
     name: 'dsh-trading-mode'
     config:
       networkMode: compatibility
   ```

   On the default `auto` the same switch happens, but only for hosts that actually
   failed — `transport.compatibilityHosts` lists them and
   `transport.mode` reports the active policy.
2. Or reorder / trim the chain without patching source:

   ```yaml
   config:
     providers:
       US: [nasdaq, stooq]
   ```

   Validation is strict and reported, never silent: an unknown market, an unknown
   provider id, a duplicate entry or an empty chain is **ignored**, the shipped
   default stays in force, and the host log says
   `trading-mode: invalid configuration — <problem> (the shipped default stays in
   force)`. The same problems appear in `config.providerChainProblems`.
3. Confirm what the plugin currently believes: `config.providerChains` (effective
   order) and `config.networkMode`.

## 4. "Searching a Japanese name in kana finds nothing"

**Cause.** Search for stock markets is answered by upstream suggestion endpoints,
and those index codes and Chinese/Latin names, not Japanese kana. A query such as
`トヨタ` or `ソニー` returns zero rows upstream.

**Fix.** The plugin ships a local seed directory that covers the major Tokyo names
in kana, rōmaji and Chinese (`トヨタ` / `トヨタ自動車` / `toyota` / `丰田` →
`7203.T`; `ソニー`, `キーエンス`, `ソフトバンク`, `任天堂`, …). Those queries resolve
locally, with no upstream call. For names outside the seed, search by the four-digit
TSE code (`7203`) or the Chinese name the upstream feed does index.

## 5. "The chart says `partial history`"

**Cause.** The chart is showing a **degraded** series: every source in the chain
returned fewer bars than the requested range needs. The router marks the answer
`degraded: true` after trying the chain, and the client labels it instead of
pretending the range is complete.

**Fix.** Nothing to configure — check `providers[].scopes.candles` to see which
source refused. If the whole market's candle capability is cooling down (§2), the
next attempt after the cooldown may fill the range; if no reachable source publishes
the rest of the history (the Tokyo case), the badge is the honest answer and the
data is not invented.

## 6. Quotes look old or the panel says "Last available data"

**This is a label, not a bug.** Freshness is graded against the market session, and
the UI never claims live data:

- `Updated HH:MM:SS` with `Data may be delayed` on every fresh quote;
- `Last available data` when the plugin knowingly serves something stale (cache
  past its TTL, closed session, a known-stale upstream snapshot), plus a `cached`
  chip whose tooltip carries `staleReason`;
- `updatedAt` / `stale` / `freshness` travel with each quote in the API payload.

**Fix if the label is wrong.** Compare `quote.timestamp` with the market session:
`GET /api/trading/status` → `markets.<MARKET>.session`. A timestamp from a previous
session is expected on weekends, holidays and outside trading hours. If a *fresh*
session shows a stale timestamp, record `quote.source`, `cache.staleServed` and
`counters.degraded` in the report and open an issue with those numbers.

## 7. "Every route answers `503 HOST_SECURITY_UNAVAILABLE`" (0.8.0)

**This is the fence failing closed, not a broken install.** Before 0.8.0 a deployment
whose host offered no request check served every route openly; now the plugin refuses
unless it can ask the host whether the request is allowed.

Diagnose in this order:

1. `GET /api/trading/health` — the only unfenced route. `api: "blocked"` means the host
   provided no `connection.requestRejection`; `api: "ready-on-loopback-only"` means an
   operator enabled the loopback exception.
2. Host log lines matching `trading-mode:` — the startup line prints
   `request fence: host` / `unavailable — the API refuses with 503` / `OPEN — loopback
   debugging exception`, followed by an error-level `SECURITY` line when the fence is
   missing. Refusals are logged as `refusing <METHOD> <path>`.
3. `GET /api/trading/status` → `fenceFailures` counts refusals since start.

**Fix.** Run the plugin inside a DSH host that exposes the connection service (the
normal case — a capable host means `fence: "host"` and no refusals). If you are
developing against a host without it, the only supported escape hatch is the explicit
`security.allowUnfencedLoopback: true` in the plugin configuration: it serves loopback
peers only, logs an error-level `SECURITY` line every time it is used, and still refuses
remote peers. Never leave it on, and never expose the port to a network.

## 8. "The watchlist is empty and saving says `NO_IDENTITY`" (0.8.0)

**This is the identity gate, not data loss.** Watchlist and settings are keyed by the
identity the host resolved for the request. If the host offers no anonymous user id and
you configured no `identity.localBucket`, the plugin has nothing to key on — and it
refuses instead of falling back to one shared `local` bucket that every browser would
share.

Diagnose: `GET /api/trading/status` → `identity.source`. `host` means a real host id;
`localBucket` means your configured single-user bucket; `none` means per-user routes
answer `503 NO_IDENTITY` while read-only market data (quote, candles, indices, universe,
search, profile, technicals) keeps working and stores nothing.

**Fix.** Either use a host that provides the anonymous user id (normal), or explicitly
declare the single-user bucket in the plugin configuration:

```yaml
identity:
  localBucket: desktop-single-user   # any stable string you choose
```

That is a deliberate "one machine, one user" choice — it is logged as a warning, and every
client on this deployment shares that bucket.

## 8b. "The panel shows the wrong colours, or the window is see-through" (0.8.1)

The header has a **Dark / Light** switch: dark is white-on-black (`--tm-bg: #000000`), light is
black-on-white (`--tm-bg: #ffffff`). The panel keeps its own opaque palette, so the window must
never show the conversation behind it, in either scheme.

- **Before 0.8.1 the window could go transparent.** Its background was
  `var(--dsw-alias-bg-overlay, #131313)`. When that alias is not defined in the current theme
  scope — a custom `ThemeDefinition` that registers only some tokens, or an overlay mounted
  outside the theme scope — CSS treats `var()` as *invalid at computed-value time*: the
  **fallback does not apply**, the declaration is dropped, and the background falls back to
  `transparent`. 0.8.1 paints from its own literal palette instead of a host token chain, so that
  failure mode is gone (pinned by three checks in `tests/offline/client.test.mjs`).
- **The switch does not seem to do anything.** The choice is written to the DSH theme service so
  it survives a reload; with a host that exposes no `theme` service it still switches, for the
  session only. Either way the *panel* must flip immediately — if it does not, the browser is
  still holding an older `lib/client.js`: reload the page, then confirm the profile copy matches
  this checkout with `npm run verify:install` (it prints per-file hashes).
- **The whole interface changed colour too.** That is expected and intentional: the panel writes
  its choice through DSH's own theme preference (the only persisted colour setting a client
  plugin can reach), so the surrounding app follows. Until you choose, the panel follows DSH.
- **TradingView inside the chart is still white**: the embedded chart is a third-party page with
  its own colours; the plugin deliberately does not repaint it.

## 9. Collecting evidence for a report

```text
npm test                 # offline, deterministic, no network (exit 0 = pass, 1 = fail, 3 = skipped)
npm run test:network     # online probes against the real providers (non-blocking: DEGR, not FAIL)
npm run verify:install   # is the installed profile copy the one this checkout describes?
npm run inspect:profile  # what the profile actually loads: entry, version, link vs copy
npm run smoke:artifact   # does the packed tarball contain a working plugin?
npm run check            # syntax gate only
npm run test:config | test:router | test:transport | test:api | test:fence | test:identity | test:ai | test:client | test:repo
```

- `npm test` runs `tests/offline/run.mjs` (suites: syntax, config, transport, limits,
  router, api, fence, identity, watchlist, ai, client, release-scripts, repo). It never
  needs network or a DSH profile; the client suite reports SKIP when it cannot find
  `react`/`react-dom`, and the release-scripts suite reports SKIP when it cannot find
  `zod` (`npm install` fixes both).
- `npm run test:fence` and `npm run test:identity` are the two 0.8.0 refusals in
  isolation: no host fence → only `GET /health` answers; no identity → no per-user
  storage while read-only market data still works.
- `npm run test:release` is the same run with one extra rule: **a SKIP is a failure**. Use it
  before publishing; `npm test` is for everyday work.
- `npm run test:network` drives `tests/network/host.test.mjs` against live
  providers. Upstream outages are reported as `DEGR` rather than failures, so it is
  safe to run on a bad network day, and it writes a machine-readable run report to
  `dsh-trading-mode-host-report.json` in the OS temp directory (tests never write
  inside the checkout). It prints the provider health table and the service
  `counters` at the end; re-run with `VERBOSE=1` for stack traces.
- `npm run verify:install` checks the profile that loads the plugin: the link
  target, the version, the AI layer (no private host import), the five-market host
  code and the client bundle hash. Without a linked profile it prints SKIP (exit 3)
  — that is not a failure.
- `npm run inspect:profile` reports the same facts read-only, without loading the
  plugin, so it is safe to run while DSH is open.
- `npm run smoke:artifact` packs the tarball and checks the packed file list — the
  gate that catches "works in the checkout, broken in the package".

When filing a bug, include: `GET /api/trading/health` and `GET /api/trading/status`
verbatim (status redacts upstream URLs, IPs, bare hosts and absolute paths for you), the
host log lines matching `trading-mode:`, the exact UI wording, and the failing
symbol/market/interval/range.
