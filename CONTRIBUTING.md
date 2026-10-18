# Contributing to dsh-trading-mode

`dsh-trading-mode` is a research-only market panel for DSH (DeepSeek Harness): a
watchlist, quotes, candles, market indices, a listing browser for five markets,
and a DeepSeek-backed analysis/brief layer. It never places orders and never
touches money. Issues and pull requests are welcome — this document describes
what a change has to clear.

## Prerequisites

- **Node.js `>=20`** — the floor declared in `package.json` (`engines.node`).
  There is no lockfile; the plugin itself has **no runtime dependencies**.
- **DSH with this plugin linked into a profile.** Installation is a `link:`
  dependency in `<profile>/package.json` plus an entry in
  `dsh.profile.bundles`. Because the host loads plugin code at startup, restart
  DSH after changing anything under `lib/`.
- **Optional: react / react-dom** (`devDependencies`). They are only needed by
  the client render suite. The suite resolves them from its own
  `node_modules`, from `$DSH_HOME/profiles/**/node_modules`, or from
  `DSH_TRADING_REACT_DIR` — and reports `SKIP` when it cannot find them.

## Setting up

```bash
# from <plugin-root>
npm install --no-audit --no-fund   # optional: react/react-dom for the client suite
```

Linking into a profile (paths are placeholders — use your own):

```jsonc
// <profile>/package.json
{
  "dependencies": { "dsh-trading-mode": "link:<plugin-root>" },
  "dsh": { "profile": { "bundles": ["dsh-trading-mode"] } }
}
```

## Running the checks

The **offline suite is the gate** — deterministic, network-free, and runnable in
a fresh clone:

```bash
npm test              # every offline suite (this is what CI blocks on)
npm run check         # syntax / module shape
npm run test:config   # provider and market configuration
npm run test:router   # provider selection, health, fallback, degrade
npm run test:api      # HTTP surface, validation, envelope
npm run test:ai       # DeepSeek layer against the public host llm contract
npm run test:client   # client bundle + server-side render smoke checks
npm run test:repo     # publication hygiene (paths, secrets, docs, licence)
```

An individual suite may exit **3** to report `SKIP` (an optional prerequisite
such as react is missing). `npm test` treats `SKIP` as non-fatal and still exits
`0`; only a real failure exits non-zero.

The **online probes are non-blocking**. They talk to third-party market-data
sites and may fail because those sites are unreachable, rate-limiting, or have
changed shape:

```bash
npm run test:network     # live provider probe (expect DEGR, not perfection)
npm run verify:install   # inspects an installed DSH profile on this machine
```

Never make a pull request depend on the online probes passing.

## Reporting a bug

Please include, in plain text:

1. the plugin version (the `version` field of `package.json`);
2. the failing check name, or the exact UI action that failed;
3. the upstream error text (`TradingError` code plus message), not a screenshot of it;
4. the provider-health JSON from `GET /api/trading/status` (the `providers`
   array and the `ai` block). It lists provider ids, call/failure counters and
   cooldown state — it contains no credentials, so paste it as-is.

If a chart or quote is degraded, say so explicitly: "shows
partial history / Data unavailable" is a useful report, "it's broken" is not.

## Review rules that protect the product

These are not style preferences; they are the properties the test suite and the
release gate exist to defend.

1. **Never import private host packages.** The plugin runs from a profile, and
   host internals such as `@deepseek-ai/dsh-llm` are not installed where a
   plugin can resolve them. Talk to the model through the host service
   (`ctx.get('llm').stream(...)`) and assemble the **public** `StreamChunk`
   protocol (`block-start`, `text-delta`, `reasoning-delta`, `block-end`,
   `usage`, `finish`) locally. Resolve services lazily — a service captured at
   load time can be `undefined` forever.
2. **No runtime dependencies.** `dependencies` stays empty; the tree ships as
   source. Anything a provider needs is written in `lib/`.
3. **Keep the uniform provider schema.** Every provider returns the same
   `quote` / `candle` / `profile` shapes through `makeQuote` / `makeCandles` /
   `makeProfile`, so no business code learns a vendor dialect.
4. **Quotes and AI stay separate.** The AI layer receives an already-computed
   snapshot and returns prose/JSON; it must never fetch market data, and numbers
   in its output must come from the snapshot.
5. **Never hide degraded or stale data.** A short series, an expired cache or a
   refused provider must surface as `degraded` / `stale` with a visible note —
   never as a silently plausible number.
6. **Research only.** No order placement, no brokerage connection, no portfolio
   or P&L features. A pull request that adds trading execution is out of scope.

## Adding a market-data provider

1. Create `lib/trading/providers/<name>.js` and extend `MarketDataProvider`
   (`lib/trading/schema.js`): declare `capabilities`, `markets`, `intervals`,
   and implement `getQuote` / `getCandles` / `getCompanyProfile` /
   `searchStocks` / `listSecurities` only for what the source really serves.
2. Register the class in `lib/trading/providers/index.js` (`PROVIDER_CLASSES`).
3. Configure it in `lib/trading/config.js`: a `PROVIDER_CONFIG.<name>` block
   (endpoints, intervals) and its place in `MARKET_DATA_CONFIG[market].chain`.
4. Prefer `supportsSymbol(symbol, feature)` over a doomed request: a provider
   that cannot serve a symbol should be filtered out, not tried and failed.
5. **Keep health scoped per capability.** `healthScope(provider, feature)`
   (`lib/trading/http.js`) is what stops a failure on one endpoint from cooling
   down every other capability of the same provider. Record successes and
   failures against the scope you actually exercised.
6. Add an offline test. Router-level fallback/degrade cases belong next to the
   existing ones in `tests/offline/router.test.mjs`; provider parsing can be
   tested against fixtures without touching the network.

## Commits and pull requests

- One concern per pull request; keep the diff small enough to review in one sitting.
- Update or add tests with the change — a behavioural change without a test will
  be asked for one.
- `npm test` must be green locally, and `npm run check` must pass.
- Update the docs (`README.md`, `CHANGELOG.md`, `docs/**`) when behaviour,
  configuration or limitations change.
- Leave the release version bump and the changelog heading for the release
  pull request unless your change *is* that release.
- Describe what changed, why, and how you verified it (the exact commands and
  the observed result are ideal).
