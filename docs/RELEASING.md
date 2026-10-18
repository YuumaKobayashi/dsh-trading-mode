# Releasing `dsh-trading-mode`

This is the operator-facing *how*. It is the walkthrough behind the tick-boxes in
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) (the *what must be true* list), the
command-level companion to [`RELEASE_TEMPLATE.md`](RELEASE_TEMPLATE.md) (the release-note skeleton) and
[`DEVELOPMENT.md`](DEVELOPMENT.md) (how to build and test the plugin itself).

Read all three before cutting a release. If this page and the checklist ever disagree, the checklist wins
and this page is the bug.

Version numbers always come from `package.json` (`version`). A design-plan label is never a release label.

## 0. What you need

- Node `>= 20` (`node --version`); the engine floor is declared in `package.json` `engines.node`.
- npm (11.x is what this project is tested with).
- Nothing else for the blocking gates: `npm run check`, `npm run test:release` and
  `npm run smoke:artifact` are offline. They need no registry, no DSH host and no profile.
- A reachable registry **only** for a real `npm ci`, and a working network **only** for
  `npm run test:network` (which is evidence, not a gate).
- A DSH install with at least one profile **only** for `npm run verify:install` and
  `npm run inspect:profile`. Those two inspect the machine that runs them and are never run on CI.

## 1. The short version

Run from the plugin checkout, in this order:

| # | Command | What a good run looks like |
|---|---------|----------------------------|
| 1 | `npm run check` | exit `0`; every file under `lib/` parses (`node --check`). |
| 2 | `npm run test:release` | the 13 offline suites — syntax, config, transport, limits, router, api, fence, identity, watchlist, ai, client, release-scripts, repo — end with `release gate: PASS — no failures and no skipped checks`, exit `0`. |
| 3 | `npm run smoke:artifact` | packs the tarball, unpacks it in the OS temp dir and re-checks the shipped bytes; prints `verdict: SHIPPABLE` plus the tarball `sha256`, byte size and file count; exit `0`. |
| 4 | `npm run test:network` | non-blocking evidence against live upstreams. `DEGRADED` is expected on a restricted network; an upstream-independent `FAIL` is a blocker for the *release note*, not for the build. |
| 5 | `npm run inspect:profile` | exit `0` when a profile resolves to this checkout with a matching `lib/index.js` hash; exit `1` when nothing is installed there or a version/hash mismatch is found; exit `2` on a usage or I/O problem. |
| 6 | `npm run verify:install` | the profile-level install probe: host half loads, client half is found, hashes match where applicable. |

Then follow `RELEASE_CHECKLIST.md` §2 (version + changelog), §3 (configuration surface), §5 (packaging),
§7 (a clean-profile install) and §8 (tag and publish). Section 6 of the checklist is the online-probe
evidence that goes into the release notes.

`npm run smoke:artifact` and `npm run test:release` are the two gates that catch the expensive mistakes:
the first one catches "works in my checkout, broken in the tarball", the second one refuses a build whose
gate needed a `SKIP` (for example a missing `react`/`react-dom`/`zod`, which is a prerequisite problem, not
a passing test).

## 2. Dependencies and the lockfile

`package-lock.json` is committed. It is a `lockfileVersion` 3 lock (npm 9+) and it pins exactly:

| package | pinned | why it is here |
|---------|--------|----------------|
| `react` | 18.3.1 | the client render suite (`npm run test:client`) |
| `react-dom` | 18.3.1 | the client render suite |
| `scheduler` | 0.23.2 | transitive dependency of `react-dom` |
| `loose-envify` | 1.4.0 | transitive dependency of `react` |
| `js-tokens` | 4.0.0 | transitive dependency of `loose-envify` |
| `zod` | 3.25.76 | the watchlist storage-domain suite (`npm run test:watchlist`) |

All six are `dev: true`. None of them has an install script (`hasInstallScript` is absent from every
entry), so `npm ci` never runs third-party build code. The plugin itself ships **zero runtime
dependencies** — `dependencies` in `package.json` is empty on purpose; the host contract
(`@deepseek-ai/cordis`) and the optional `@deepseek-ai/dsh-*` services are supplied by the DSH runtime
that loads the plugin. That is why the lockfile contains no peer entries and why the CI install is:

```sh
npm ci --legacy-peer-deps --no-audit --no-fund
```

`--legacy-peer-deps` is required, not cosmetic: without it npm tries to resolve the non-optional peer
`@deepseek-ai/cordis@^4.0.1` from a registry, which is exactly the dependency the host provides. Do not
"fix" that by adding the peer to the lockfile or by moving it to `devDependencies`.

The lockfile is generated, never hand-edited. After any change to `dependencies` / `devDependencies` /
`peerDependencies` in `package.json`, refresh it and re-run the gates:

```sh
npm install --package-lock-only --legacy-peer-deps   # refresh the lock
npm run test:release                                 # the gate must go green again
```

CI fails the build when the lockfile has drifted from the manifest, which is the point: a release must
install the tree that was tested, not whatever the registry resolves today. Never add a dependency to
make a check pass — fix the missing prerequisite instead.

## 3. The artifact

`npm pack` ships the members listed in `package.json` `files[]`: `lib/`, `docs/`, `tests/`, `scripts/`,
`cordis.patch.yml`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` and the
manifest itself.

`npm run smoke:artifact` (`scripts/smoke-artifact.mjs`, zero dependencies, no network) does all of this,
inside a temp directory it creates and removes itself:

1. `npm pack --json` into `<temp>/pack` and reads the packed file list from the JSON (never from a
   hand-copied number).
2. Requires the members a `link:`/bundle install needs: `package.json`, `cordis.patch.yml`, `README.md`,
   `LICENSE`, `CHANGELOG.md`, `lib/index.js` (the host half), `lib/client.js` (the client half),
   `docs/API.md`, `docs/DATA_COMPLIANCE.md`, `docs/PRIVACY.md`, `scripts/inspect-profile.mjs`, and
   minimum counts for `lib/trading/`, `docs/`, `tests/` and `scripts/`.
3. Fails if any entry is machine state: a `.dsh/` segment, `node_modules`, a `*.log`, a `.env*`, a cache
   or coverage directory, `.DS_Store`/`Thumbs.db`, or a symlink/hard-link entry.
4. Unpacks the tarball with its own reader (header checksums verified, no path traversal) and scans every
   packed text file for an absolute machine path: a `Windows` user profile, a drive root, a POSIX
   `/home/<name>` or `/Users/<name>`, or an `AppData` segment. This is the check that would have caught
   the personal-path examples that used to live in the `README.md`.
5. Runs `node --check` on every packed `lib/**/*.js`, so a tarball that only *looks* complete fails.
6. Prints the package name/version, the tarball name, the `sha256`, the byte size, the file count, the
   unpacked size, one `PASS`/`FAIL` line per check, and a final `SHIPPABLE`/`BLOCKED` verdict.
7. Exits `1` when any check fails, `2` on a usage error or a missing `npm`, and cleans the temp directory
   unless `--keep` is passed. It never writes inside the checkout.

`--json` prints the same result as one JSON document; `--keep` leaves the temp directory behind and tells
you its path when you want to look inside the tarball yourself.

The `sha256` this script prints is the release's provenance — paste it (and the file count) into the
release notes as described in `RELEASE_TEMPLATE.md`. Nothing else identifies the build: see §5.

## 4. Continuous integration

`.github/workflows/ci.yml` runs two jobs:

- **`offline` (blocking)** — `npm ci --legacy-peer-deps --no-audit --no-fund`, then `npm run check`, then
  `npm run test:release`, then `npm run smoke:artifact`. The Node matrix is `20` and `22`: the declared
  engine floor and the next LTS. A failure in any of the four steps fails the pull request. The install is
  deliberately blocking — a best-effort install would only move the failure down to the gate, where a
  missing dependency shows up as a skipped check with worse diagnostics.
- **`network-probe` (non-blocking)** — `continue-on-error: true`, Node 20, `npm run test:network`. Live
  upstreams are allowed to be down, rate-limited or shaped differently; the job reports, it does not gate.

`npm run verify:install` is intentionally not run on a runner: it inspects an installed DSH profile on a
developer machine and is meaningless on a clean host.

Honest status: this workflow has not yet had its first run on a runner (the checkout is a plain directory,
not a git working tree, so there is nothing to push). Until it reports green, Node 20/22 support is
*declared and offline-tested*, not runner-measured. Say so in the release notes rather than implying
otherwise.

## 5. Provenance when there is no git history

This checkout is a plain directory copy: not a git working tree, no remote, no commits to tag. Provenance
for such a build is:

1. `package.json` `version` (a `git tag` equivalent does not exist here).
2. The packed tarball's `sha256` from `npm run smoke:artifact`.
3. The `npm pack --json` file list and file count, from the same run.

Paste all three into the release notes. If this directory later becomes a git repository, the checklist's
§1b history scan and the `v<version>` tag rule apply again, and the commit becomes the fourth provenance
item.

## 6. Install, upgrade, rollback, disable, uninstall

All five are host operations on a DSH profile; the plugin does not install itself.

| Operation | What to do |
|-----------|------------|
| install | add the plugin to the profile (a `link:`/`file:` dependency for a checkout, or an installed bundle), then restart DSH once — the host half loads at process start. |
| upgrade | install the new version into the profile and restart. Watchlist and settings are version-independent JSON, so no migration is involved unless `CHANGELOG.md` says otherwise. |
| rollback | install the previous version's tarball (keep it plus its probe summary), then restart. |
| disable | turn the bundle off rather than deleting it, so the stored data is untouched. |
| uninstall | remove the bundle and the profile's `node_modules` entry; the data under `<DSH home>/trading-mode/` stays until you delete it. |

After any of these, `npm run inspect:profile` is the fast truth check: it reports the profile's dependency
declaration, the `node_modules` entry type (`junction`/`symlink`/`dir`), the resolved target, the installed
version and the installed `lib/index.js` hash against this checkout. Exit `0` means this checkout is what
the profile loads; exit `1` means the profile has a stale copy, a missing install or a version/hash
mismatch — which is the failure mode the script exists to catch.

## 7. What must not reach a release note

`RELEASE_TEMPLATE.md` states the rule and this page repeats it because it is the one that leaks: no
absolute local path, no user name, no credential and no watchlist sample. Write `<your profile>` and
`<path to the plugin checkout>` instead. Server names, provider URLs and public registry paths are fine.

The blocking gates already check the shipped text (the offline hygiene suite over `package.json`
`files[]`, and `smoke:artifact` over the packed tree), but release notes are written by hand outside the
tarball, so they are on you.

## 8. When a gate refuses

| Symptom | What it means | What to do |
|---------|---------------|------------|
| `npm run test:release` prints `FAIL` | a real failed check | read the failing check; do not publish. |
| `npm run test:release` prints `RELEASE BLOCKER: N required check(s) were skipped` | a prerequisite is missing (usually `react`/`react-dom`/`zod`) | resolve the dependency (`npm ci`), re-run; never lower the gate. |
| `smoke:artifact` prints `verdict: BLOCKED` | a packed member is missing, the entry list carries machine state, a packed file leaks a machine path, or a packed `lib/` file does not parse | fix the source file; if a leaked path is reported, remove the literal from the shipped text and re-run. |
| `npm ci` fails on a runner | the lockfile drifted from `package.json`, or the registry is unreachable | refresh the lock as in §2; a registry outage fails fast rather than silently resolving new versions. |
| `inspect:profile` exits `1` | the profile does not load this checkout, or its version/hash differs | reinstall the profile entry against this checkout and restart DSH; a `junction` pointing at a removed directory is the classic case. |
| `inspect:profile` exits `2` | usage error or an unreadable DSH home | check the flags (`--profile`, `--json`, `--help`) and `DSH_HOME` / `DSH_DIR`. |
| `npm run test:network` reports `DEGRADED` | an upstream is unreachable or rate-limited from this network | expected; record which market, from where, and with what error text in the release notes. |
| A gate cannot run at all (no network, no profile) | the offline gates need neither | only `npm ci`, `test:network`, `verify:install` and `inspect:profile` need a registry, a network or a profile. |

## 9. Where the release machinery lives

| Path | Purpose |
|------|---------|
| `docs/RELEASE_CHECKLIST.md` | the ordered tick-box gate list; authoritative. |
| `docs/RELEASE_TEMPLATE.md` | the release-note skeleton, including the evidence rule. |
| `docs/RELEASING.md` | this walkthrough. |
| `.github/workflows/ci.yml` | the blocking offline job and the non-blocking probe job. |
| `scripts/smoke-artifact.mjs` | packs, unpacks and re-checks the shipped tarball; prints the `sha256`. |
| `scripts/inspect-profile.mjs` | read-only profile truth check (`--profile`, `--json`, `--help`). |
| `tests/offline/release-scripts.test.mjs` | guards these two scripts and the CI contract offline. |
| `tests/network/host.test.mjs`, `tests/network/verify-install.mjs` | the online probe (`test:network`) and the profile install probe (`verify:install`). |
| `docs/screenshots/README.md` | how the release screenshots are captured and stored. |
