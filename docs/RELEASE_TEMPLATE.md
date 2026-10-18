# Release notes template

Copy this file into the release page (or into `CHANGELOG.md`) and replace every `<angle bracket>`
placeholder. Delete any section you cannot fill in honestly, and say why it is missing — an empty
placeholder is worse than a stated gap.

Publication rules this template assumes:

- The version comes from `package.json`. Never label a release with a design-plan or roadmap label.
- A statement may only describe something that was actually run on the machine that cut the
  release. Every check listed under **Verification evidence** is a release blocker: a **skipped**
  check is a blocker, not a warning.
- No release note contains an absolute local path, a user name, a token or a watchlist sample.
  Use `<your profile>` / `<path to the plugin checkout>`.
- Trading Mode is a research panel. It never places an order, so a release note never claims
  trading, order, position or P&L behaviour.

Related documents: [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) (the full gate list),
[`COMPATIBILITY.md`](COMPATIBILITY.md) (the measured environment and capability matrix),
[`DATA_COMPLIANCE.md`](DATA_COMPLIANCE.md) (the per-provider compliance boundary).

---

## dsh-trading-mode <version>

- **Release date:** <YYYY-MM-DD>
- **Artifact:** `<release artifact name>` (produced by the repository's release script)
- **SHA-256:** `<sha256 of the artifact>`

Do not state a checksum that was not computed from the artifact you are publishing. Compute it on
the artifact you have:

```text
sha256sum <release artifact name>          # POSIX
Get-FileHash -Algorithm SHA256 <release artifact name>   # Windows PowerShell
```

## Summary

<One short paragraph: what changed for a user of the plugin, and why. No marketing language.>

## Changes

### Added

- <What is new, and what it lets an operator do.>

### Changed

- <What behaves differently now, and the reason for the change.>
- <State explicitly whether the change is backward compatible, and what changed in configuration
  defaults: the provider chains, `networkMode`, health scoping, storage shape.>

### Fixed

- <The defect, its symptom, and the file that now handles it.>

### Documentation

- <Which `docs/*.md` files were added or corrected in this release.>

## Install / upgrade / rollback / uninstall

Every action below is a call inside DSH — these are **harness tool calls, not shell commands**.
The plugin manager applies them to the currently running profile.

**Install**

```text
plugin_manager(action: "install_bundle", target: "<path to the plugin checkout>")
```

`target` is the absolute directory of the plugin (or of the unpacked artifact). Permissions and the
confirmation prompt are handled by the plugin manager. Restart DSH once afterwards: host-side code
loads at process start.

**Verify the installed plugin**

```text
node tests/network/verify-install.mjs
```

**Upgrade**

```text
plugin_manager(action: "install_bundle", target: "<path to the new plugin checkout>")
```

Restart DSH after the reinstall. The watchlist and the language preference are unaffected: they are
version-independent data under `<your profile>`.

**Rollback**

```text
plugin_manager(action: "install_bundle", target: "<path to the previous plugin checkout>")
```

Then restart DSH. Keep the previous artifact and its verification evidence until the new release has
survived a full working session. If a release ever changes the on-disk shape of the stored data, the
migration must be documented in `CHANGELOG.md` before publishing — a rollback is otherwise a version
reinstall with no data migration.

**Disable without removing**

```text
plugin_manager(action: "set_bundle", target: "dsh-trading-mode", enabled: false)
```

**Uninstall**

```text
plugin_manager(action: "remove_bundle", target: "dsh-trading-mode")
```

Restart DSH. Removing the bundle does not delete stored data; deleting `<your profile>`'s
`trading-mode` state is a separate, deliberate act.

**No profile file is edited by hand.** Do not hand-edit `cordis.yml`, the profile's `package.json`,
or its `dsh.profile.bundles` list to install, upgrade or uninstall this plugin. A manual entry is how
a plugin ends up half-installed in the wrong profile, and it leaves the profile unreproducible.

## Verified environments

Only the first row was tested. Every other row is explicitly **not verified** — listed so nobody
reads absence of a row as support.

| Environment | Node | DSH | Status |
| --- | --- | --- | --- |
| Windows 11 (x64) | 24.15.0 | 0.2.0-rc.2 | **verified** on <YYYY-MM-DD>: offline suite passed with no skips, install verification passed, panel opened |
| macOS (darwin, arm64 and x64) | any | any | **not verified** |
| Linux (x64 and arm64) | any | any | **not verified** |
| WSL / WSL2 | any | any | **not verified** |
| Windows ARM64 | any | any | **not verified** |
| Other Node versions (20, 21, 22, 23, 25 and later) | — | 0.2.0-rc.2 | **not verified**; `engines.node` declares `>= 20`, which is a floor, not a measurement |
| Other DSH versions (earlier or later than 0.2.0-rc.2, and other release channels) | any | — | **not verified** |
| Reverse proxy, VPN or corporate network egress | any | any | **not verified** |

## Known limitations

- **Research only, no trading.** The plugin reads public market data and renders it. There is no
  order placement, no position or P&L tracking, no broker integration and no automated execution.
- **Quotes can be delayed or stale.** Freshness is classified (`live` / `delayed` / `stale` /
  `historical` / `unknown`) and the UI must say which one applies; the panel must never describe
  non-live data as live. When an upstream fails, a cached value may be served only as a labelled
  fallback.
- **The JP market has reduced capability.** Search accepts Tokyo codes and Chinese names only, and
  the reachable history for JP symbols is thin, so candles and the technical indicators derived from
  them are not guaranteed for JP.
- **Per-user storage is local to one machine profile, with no cross-device sync.** The watchlist and
  the language preference live in the profile of the machine running DSH, keyed by DSH user id. A
  second machine does not see them.
- **Rate limits are inbound and the plugin is in-process only.** The per-user and global quotas bound
  what the panel may ask for, and an action can be refused with `429 RATE_LIMITED`; the plugin has no
  background worker, no daemon and no scheduler, so nothing is fetched while the panel is idle.
- **Third-party terms are recorded but not legally verified.** The compliance document records what
  each provider is asked for and records that its terms were **not verified** in this repository.
  Checking the current terms is the operator's responsibility, per
  [`DATA_COMPLIANCE.md`](DATA_COMPLIANCE.md).

## Verification evidence

Paste the **exact output** of each command below. A row with no pasted output is not evidence.

1. **Offline release gate** — must end with `release gate: PASS — no failures and no skipped checks`
   and exit `0`:

   ```text
   npm run test:release
   ```

2. **Syntax check** — every file under `lib/` parses:

   ```text
   npm run check
   ```

3. **Install verification** — the running profile really points at this build, and reports
   `6/6 install checks passed`:

   ```text
   npm run verify:install
   ```

4. **Release-artifact smoke test** — unpack the artifact into a temporary directory, then run the
   offline suite from the unpacked tree (not from the working tree), so the shippable files are what
   was tested:

   ```text
   npm run test:release   # executed inside the unpacked artifact directory
   ```

Include, when you have it, the non-blocking probe summary from `npm run test:network`: report the
counts and the `DEGRADED` entries separately. An upstream outage is not a defect, but it belongs in
the release notes.

## Release blockers

- **A skipped check is a release blocker.** The gate only passes when every required check actually
  ran; `SKIP` is a failure for a release, not a warning. Fix the missing prerequisite and re-run —
  do not publish a build whose gate needed a skip.
- A failed check, or a check whose output was not pasted above, is likewise a blocker.
- A version number that disagrees with `package.json`, or a release label taken from a plan document,
  is a blocker.
- Claiming a platform, a provider, or a behaviour in these notes that was not tested on the machine
  that cut the release is a blocker.
