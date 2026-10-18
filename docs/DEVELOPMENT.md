# Development

Everything here works offline. Nothing in this document needs a broker account, an
API key, or a live market: the plugin only reads public market-data pages.

## Requirements

| Need | Version / note |
| --- | --- |
| Node.js | `>= 20` (declared in `package.json` `engines.node`) |
| DSH | a running host with the web server and the connection service (`inject = ['connection', 'webServer']`) |
| `react` / `react-dom` | optional — only the client-side check of the offline suite needs them (pulled from the host profile when present) |
| Network | optional. `npm test` must pass with the network cable unplugged |

## Layout

```
lib/index.js              host half: apply(ctx, config), prefix route /api/trading, per-user wiring
lib/client.js             browser half: the ./client export, UI slots, SSE-free fetch calls
lib/trading/config.js     every market, chain, range, interval, policy and TTL
lib/trading/service.js    facade: validation → router → cache → envelope (data + stale + source)
lib/trading/router.js     provider chain walk, per-capability health, half-open probe, aggregation
lib/trading/http.js       httpGet, rate limiter, ProviderHealth, healthScope, networkMode/transport
lib/trading/providers/    one module per upstream (yahoo, eastmoney, tencent, stooq, sina, nasdaq, binance, gate, coinlore)
lib/trading/{watchlist,settings,persist,cache}.js   storage: host storage domain first, atomic JSON fallback
lib/trading/{symbols,directory,universe,indices,indicators,schema,errors,ai}.js
tests/offline/            `npm test` — deterministic, no network
tests/network/            live probes — never gate a release
docs/                     this document and the rest of the guides
```

## First run from source

1. Link the plugin into a DSH profile (a junction/symlink is enough, since the host
   reads the source directly):

   ```powershell
   # inside the DSH profile directory (the one with cordis.yml)
   New-Item -ItemType Junction -Path .\node_modules\dsh-trading-mode -Target <plugin-root>
   ```

2. Make sure `cordis.yml` contains the plugin row (`- id: trading-mode`), e.g. by
   applying `cordis.patch.yml`, or by installing the bundle through the plugin
   manager.
3. **Restart DSH.** The host loads host-side modules once at startup, so a code
   change is not visible until the process restarts. The client bundle is served
   per request, so the browser needs a page refresh instead.
4. Confirm the install, then look at the live state:

   ```powershell
   node tests/network/verify-install.mjs    # is the profile really running this checkout?
   ```

   ```text
   GET /api/trading/status     # provider health, scopes, transport, chains, ai, storage
   GET /api/trading/config     # what the API publishes (chains, storage scope, languages)
   ```

## Tests

```powershell
npm test                  # offline suite: syntax, config, transport, limits, router, api, fence, identity, watchlist, ai, client, release-scripts, repo
npm run test:release      # the same suites, but a SKIP is a failure (the release gate)
npm run check             # syntax only (fast)
npm run test:config       # one suite; same for test:transport / test:limits / test:router / test:api / test:fence / test:identity / test:watchlist / test:ai / test:client / test:repo
npm run test:network      # live probes (host end-to-end); allowed to fail with DEGRADED
npm run verify:install    # verify the profile is running this checkout
npm run inspect:profile   # read-only: what the profile loads (entry, version, link vs copy)
npm run smoke:artifact    # pack the tarball and check the packed file list loads
```

Install deterministically with `npm ci` (the lockfile is committed); `npm install` is for
deliberately changing dependencies, and either way the release gate must pass afterwards.

Exit codes for every suite in `tests/offline/`: `0` passed, `1` at least one check
failed, `3` skipped because an optional prerequisite is missing (for example react
for the client check, zod for the storage-domain check). `npm test` fails only on `1`;
`npm run test:release` fails on `1` **and** on any `3`, because a release must not be
cut from a build that skipped a class of checks. `npm run test:release` prints either
`release gate: PASS — no failures and no skipped checks` or
`release gate: FAIL — a release must not contain failed or skipped checks`.

Rules for new tests:

- Offline tests must not touch the network and must not need a DSH profile. Use a
  loopback `node:http` server when transport behaviour has to be exercised.
- Never assert on a live upstream value. Assert on the *contract*: typed errors,
  `stale` / `degraded` labelling, and the fact that nothing is invented.
- When a check needs an optional peer (react, zod, a host module), resolve it the
  same way `tests/offline/watchlist.test.mjs` does and report SKIP when it is
  absent — never silently pass.

## Adding or changing a data source

1. Add the module under `lib/trading/providers/<id>.js` and export the same shape
   as its siblings: `id`, `label`, `markets`, `features`, `supportsInterval()`,
   `supportsSymbol()`, and the feature methods you implement (`getQuote`,
   `getCandles`, `getCompanyProfile`, `searchStocks`, `boards`, `page`, …).
   Partial providers are fine — the router filters by `supports()`.
2. Register it in `lib/trading/providers/index.js` and describe it in
   `PROVIDER_CONFIG` (`lib/trading/config.js`) with its markets, capabilities and
   whether it may serve quotes.
3. Put it in the market chain(s) in `MARKET_DATA_CONFIG[market].chain`. Order is
   preference, not exclusivity: the router walks the chain and falls through on
   failures. Health is tracked per `provider::feature`, so a source that cannot do
   history does not lose its quote ability.
4. If it is a listing/universe source, add it to `UNIVERSE_PROVIDERS`.
5. Add an offline test for the pure parts (parsing, symbol mapping, degradation) and
   extend `tests/network/host.test.mjs` only for the live shape.

## Rules that reviews enforce

- **No new runtime dependency.** `dependencies` stays empty; anything optional is a
  peer (`peerDependenciesMeta` marks it optional).
- **Never import a private host package** (`@deepseek-ai/dsh-llm`,
  `@deepseek-ai/dsh-client-*`, …). Reach host capabilities through the public
  service contract only — `ctx.get('llm')`, `ctx.get('connection')`,
  `ctx.get('webServer')` — and assemble streamed output from the documented
  `StreamChunk` protocol. This is exactly what broke 0.5.0's AI brief.
- **One error vocabulary.** Throw `TradingError` with a `CODES` value; the API layer
  maps codes to HTTP statuses.
- **Never hide degraded data.** Every value carries `source`, `timestamp`, `stale`
  (and `degraded` on the route result); the UI must show that instead of pretending.
- **Research only.** No order paths, no positions, no portfolio/P&L, no broker
  integration. A change that adds one is out of scope for this plugin.
- **No secrets or personal paths in shipped files.** `npm run test:repo` checks it.

## Configuration surface

| Key | Values | Effect |
| --- | --- | --- |
| `providers` | `{ US: ['yahoo', …], HK: […], CN: […], JP: […], CRYPTO: […] }` | overrides the chain per market; invalid values are ignored with a log line and the shipped default stays in force |
| `networkMode` | `auto` (default) / `standard` / `compatibility` | `auto` only upgrades hosts that actually failed at the transport level; `standard` never does; `compatibility` always enables address-family memory/flip |

Both are optional and are surfaced by `GET /api/trading/status` and the client's
config snapshot, so a deployment can be inspected without reading the source.

## Packaging

```powershell
npm pack --dry-run --json     # must contain only lib/, docs/, tests/, cordis.patch.yml, the markdown files and package.json
```

`docs/RELEASE_CHECKLIST.md` is the ordered release procedure, including the rollback
note: the plugin's own state lives in `<DSH home>/trading-mode/` and is not tied to a
plugin version.
