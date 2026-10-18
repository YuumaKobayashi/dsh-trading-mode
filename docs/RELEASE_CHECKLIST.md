# Release checklist

How a `dsh-trading-mode` release is cut. The point of this list is that **nothing here depends on the
release engineer's machine**: every gate is either an offline command that runs anywhere, or a probe
whose failure is reported instead of blocking.

Version numbers come from `package.json`. Design documents never carry a release label.

## 0. Before you start

- [ ] The working tree is the source of truth (`link:`-style DSH install, no stale copy in any profile).
- [ ] You are on the branch you intend to release, with no unrelated changes staged.
- [ ] Node `>= 20` is the interpreter you will test with (`node --version`).

## 1. Offline gates (must all pass)

- [ ] `npm run check` — every file under `lib/` parses (`node --check`).
- [ ] `npm test` — the offline suite: syntax / config / transport / limits / router / api / fence /
      identity / watchlist / ai / client / release-scripts / repo. A missing optional prerequisite (react
      for the client suite, zod for the release-scripts suite) reports `SKIP`; anything else must be `PASS`.
      The suite must not need network access — if it does, that is a bug in the suite.
- [ ] `npm run test:release` — the **release gate**. It is `npm test` plus one extra rule: a `SKIP` is a
      failure. It must end with `release gate: PASS — no failures and no skipped checks` and exit `0`.
      If it prints `release gate: FAIL — a release must not contain failed or skipped checks`, or
      `RELEASE BLOCKER: N required check(s) were skipped, so this build is not releasable`, fix the
      missing prerequisite (usually `npm install` so `react`/`react-dom`/`zod` resolve) and re-run.
      Do not publish a build whose gate needed a skip.
- [ ] `npm run smoke:artifact` — packs the **tarball** (not the working tree) into the OS temp directory and
      inspects it without installing or loading anything: it verifies the tar headers and checksums, that the
      version matches `package.json`, that every required member is present (`lib/index.js`, `lib/client.js`,
      `package.json`, `cordis.patch.yml`, `docs/`, `tests/`, `scripts/`), that the entry list carries no
      machine state, that every packed text file is free of machine paths, and that every packed `lib/**/*.js`
      parses. It must end with `SHIPPABLE` and print the tarball `sha256`, which is the provenance record for
      a checkout with no git history. This is the gate that catches "works in my checkout, broken in the tarball".
      Installing the tarball into a *live* profile is a separate, manual step (§6/§7).
- [ ] `npm run test:repo` — publication hygiene specifically:
      no secret / API key / bearer token, no author-specific absolute path or personal data,
      a complete MIT `LICENSE`, a `CHANGELOG.md` section for this exact version,
      a `.gitignore` that keeps machine state out, the full documentation set (including
      `docs/API.md`, `docs/PRIVACY.md`, `docs/DATA_COMPLIANCE.md`, `docs/DELIVERY-REPORT.md`,
      `docs/RELEASING.md`, `docs/RELEASE_TEMPLATE.md`, `docs/screenshots/README.md`), and a
      README first screen that answers: what is it, how do I install it, what does it *not* do,
      what version does it need, how do I verify it.

## 1b. Repository history and secret scan

The offline hygiene suite scans the *working tree*. A release also has to survive someone reading the
history, so run these once per release (**only if this checkout is a git repository** — a plain
directory copy has no history and its provenance is the tarball's `sha256` plus `npm pack` output
instead):

- [ ] `git status --porcelain` is empty except for the files this release intends to change.
- [ ] `git log --oneline -20` contains no commit message with a token, a personal path or a customer name.
- [ ] Scan the full history, not just `HEAD`, for credentials and personal paths:
      `git grep -nIE "(api[_-]?key|secret|token|bearer|password|BEGIN [A-Z ]*PRIVATE KEY)" $(git rev-list --all)`
      and `git grep -nIE "([A-Za-z]:\\\\Us[e]rs\\\\|/Us[e]rs/[a-z0-9._-]+/|/hom[e]/[a-z0-9._-]+/)" $(git rev-list --all)`
      (the bracketed letters keep this lesson out of the scanners it describes).
      Either command printing a real hit is a blocker: rotate the credential and rewrite the history before
      tagging. (Matches inside `tests/` that are obviously synthetic fixtures are fine — say so in the
      release notes.)
- [ ] Confirm nothing under `.dsh/`, `node_modules/`, a cache directory or a local profile snapshot is
      tracked (`git ls-files | Select-String -Pattern "^\\.dsh/|node_modules|\\.cache/"` must be empty).
- [ ] The machine that produced the tarball is not identified by any file inside it
      (`npm pack --dry-run --json` file list, then spot-check `docs/` and `tests/` for local paths).

## 1c. Compliance confirmation

- [ ] `docs/PRIVACY.md` and `docs/DATA_COMPLIANCE.md` exist and still describe what the code does:
      local-first storage (`profile-local`, no cross-device sync), no telemetry, the exact provider set,
      and which fields are sent to the host `llm` service for an analysis.
- [ ] The provider set in `lib/trading/config.js` has not changed since the last release; if it has,
      re-read that provider's current public terms and update `docs/DATA_COMPLIANCE.md` before publishing.
- [ ] The default rate limits (`HTTP_POLICY.rateLimitPerMinute`, `API_POLICY`, `UNIVERSE_POLICY.budgetMs`)
      are still in force — a release must not raise them to make a demo faster.
- [ ] `docs/DATA_COMPLIANCE.md` records any provider whose terms were **not** verified in this release,
      so the next release knows what to re-check.
- [ ] `docs/PRIVACY.md`, `docs/API.md` and `docs/COMPATIBILITY.md` state the 0.8.0 stance: the host
      fence **fails closed** (missing or throwing `connection.requestRejection` → `503`
      `HOST_SECURITY_UNAVAILABLE`), the only unfenced route is `GET /api/trading/health`, and a missing
      per-user identity is refused (`503 NO_IDENTITY`) instead of falling back to a shared bucket.

## 1d. Release engineering inputs

- [ ] `package-lock.json` is committed and in sync with `package.json`; CI installs with `npm ci`, so a
      lockfile that drifts from the manifest fails the build instead of silently resolving new versions.
- [ ] `scripts/inspect-profile.mjs` still reports what it claims: the profile's plugin entry, the version
      `package.json` declares, the resolved entry file, and whether the profile points at this working tree
      or at a copy (a stale copy is the failure mode it exists to catch).
- [ ] `scripts/smoke-artifact.mjs` passes on the freshly packed tarball, not on the working tree.
- [ ] `docs/RELEASING.md` still matches the actual workflow, and `.github/workflows/ci.yml` runs the same
      blocking commands (`npm run test:release`, `npm run check`) with the online probe left non-blocking.


## 2. Version and changelog

- [ ] `package.json` `version` is the new semver value.
- [ ] `CHANGELOG.md` has a `## <version>` section that describes:
      **新增 / 变更 / 修复 / 测试**, with the *reason* for each behavioural change, not just the diff.
- [ ] The changelog states explicitly when behaviour is **backward compatible**, and what changed in
      configuration defaults (data-source chains, `networkMode`, health scoping).
- [ ] No document uses the design-plan label as the release version.

## 3. Configuration surface

- [ ] New or changed plugin options are documented in the README *and* `docs/DATA_SOURCES.md`
      / `docs/COMPATIBILITY.md`: key name, accepted values, default, and what happens on an invalid value.
- [ ] Invalid values are rejected loudly (logged) and the shipped default stays in force —
      never silently half-applied. Verify by hand once:
      `providers: { US: ['nosuchfeed'] }` must leave the default chain working and log one problem line.
- [ ] The one security opt-out is checked by hand once: with no `security.allowUnfencedLoopback` in the
      configuration the plugin must log `request fence: host` (or the fail-closed `SECURITY` error when the
      host offers no fence), and setting it to `true` must log an **error-level** `SECURITY` line naming
      `allowUnfencedLoopback is ON`. A value that is not a boolean must be reported as a config problem and
      leave the default in force (`security.allowUnfencedLoopback must be true or false`).
- [ ] `GET /api/trading/status` still exposes what an operator needs to debug a release:
      per-provider health with per-capability scopes, `transport`, `providerChains`, `providerChainProblems`,
      `networkMode`, `ai.reason`.

## 3b. Client panel, by hand once (0.8.1)

- [ ] Open the panel and click the header **Dark / Light** switch: the window must flip between
      **white-on-black** and **black-on-white**, and the sliding/selected state (`aria-pressed`) must move
      with it. Everything inside — cards, tables, charts, the status popover, the AI cards — must follow;
      nothing may keep dark colours in the light scheme (or the reverse).
- [ ] The window must stay **opaque**: no part of the conversation behind the panel may show through, in
      either scheme. The static guarantee is asserted in `tests/offline/client.test.mjs`
      (`.tm-window` / `.tm-status__pop` are painted from `--tm-*` and do not name a `--dsw-alias-*` token),
      but the visual check is still the human step this box records.
- [ ] With a host that exposes the client `theme` service, the choice must survive a reload (DSH persists
      its own theme preference). Without that service the panel must still switch, silently, for the
      session only — no console error, no failed request, no plugin write.
- [ ] `npm run test:client` passes (28 checks) — the three theme checks cover the switch, the
      follow-until-chosen precedence, and the opaque-palette CSS assertions.

## 4. Storage and isolation

- [ ] Watchlist and settings remain keyed by DSH user id, on the local profile; the docs still say
      **single machine** and do not promise cross-device sync.
- [ ] Nothing in the release adds a write path that can reach a broker or an order API.
- [ ] `npm run test:api` passes — it covers the auth fence, cross-user isolation, and that request bodies
      cannot override the acting user id.
- [ ] `npm run test:fence` and `npm run test:identity` pass — they pin the two 0.8.0 refusals: no host
      fence means no data routes (`GET /health` only), and no identity means no per-user storage (read-only
      market data still works). `GET /api/trading/health` must answer before the fence, carry no data, and
      spend no quota.

## 5. Packaging

- [ ] `npm pack --dry-run --json` lists exactly the intended files: `lib/`, `docs/`, `tests/`,
      `cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`,
      `package.json`. No editor state, no scratch scripts, no `.dsh/` or cache files.
- [ ] Unzip the tarball into a temporary directory and confirm the leak scanners pass on the extracted
      tree as well (they scan the manifest's `files[]`, so this is a sanity check, not a new gate).
- [ ] `cordis.patch.yml` still inserts `- id: trading-mode` and matches the current plugin id.

## 6. Online probes (non-blocking, evidence only)

- [ ] `npm run test:network` — host end-to-end against live upstreams. Report the counts.
      `DEGRADED` entries are acceptable and expected when an upstream is unreachable from this network;
      a `FAIL` that is *not* upstream-related is a release blocker.
- [ ] `npm run verify:install` — the profile points at this working tree, sees the new version, loads the
      host half, finds the client half, and (where applicable) matches file hashes.
- [ ] Probe the unfenced health route once against the running host: `GET /api/trading/health` must answer
      `200` with the plugin name, the version from `package.json`, `api`/`fence` state and the identity
      *source* — and nothing else (no path, no user id, no counters). If it answers `503`, the host fence is
      missing and every data route is correctly refusing.
- [ ] If a whole market is unreachable from your network, record which one, from where, and with what error
      text — that is the most useful part of the release notes for the next person.

## 7. Install verification on a clean profile

- [ ] Install the release into a DSH profile that has never had the plugin (fresh profile or removed
      `node_modules` entry + `dsh.profile.bundles` entry).
- [ ] Restart DSH once (host-side code loads at process start).
- [ ] Confirm the startup log names the request fence and the identity source, and that
      `npm run inspect:profile` (or the log) says the profile resolves to this working tree rather than a
      stale copy — a junction pointing at a removed directory is exactly the failure mode 0.8.0 reports.
- [ ] Open the web UI: the **Trading Mode** button appears, the panel opens, a search for a US symbol
      returns a quote, a market index renders, the language toggle switches to 中文 and survives a reload.
- [ ] Confirm the watchlist is usable on this profile (that means the host answered with an anonymous id,
      or you configured `identity.localBucket`); if the UI reports `NO_IDENTITY`, the host offered no
      identity and the per-user features are correctly refusing rather than sharing one bucket.
- [ ] If the host exposes the `llm` service with a DeepSeek route, request one AI analysis and one
      watchlist brief; otherwise confirm the UI explains the specific reason instead of failing silently.

## 8. Tag and publish

- [ ] Tag the release with the `package.json` version (`v<version>`), not a plan label.
- [ ] Publish with public access (`publishConfig.access` is already `public`).
- [ ] Attach the online-probe summary of this run to the release notes, including the `DEGRADED` list.
- [ ] Open follow-up issues for every known limitation that this release did not fix
      (see `docs/ROADMAP.md`), so the next release starts from an honest list.

## Rollback

- [ ] Keep the previous version's tarball and its probe summary.
- [ ] A rollback is a version reinstall plus a DSH restart; no data migration is involved because watchlist
      and settings live in `<DSH home>/trading-mode/` and are version-independent JSON.
      If a release ever changes that on-disk shape, it must document the migration in `CHANGELOG.md`
      before publishing.
