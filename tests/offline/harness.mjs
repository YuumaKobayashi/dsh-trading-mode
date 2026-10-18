/**
 * Minimal zero-dependency harness for the offline suite (0.6.0, publication
 * task A3; required/optional semantics added in 0.7.0 task P0-3).
 *
 * The offline suite is what `npm test` runs: it must work in a fresh clone with
 * no network and no DSH profile. Every suite is a plain Node script that ends
 * with `process.exit(exitCodeFor(result))`:
 *
 *   0 = passed   1 = at least one check failed (or a *required* check was
 *   skipped)   3 = skipped (nothing ran because the suite is optional and its
 *   prerequisites are missing, e.g. react for the server-side-render checks)
 *
 * A suite that gates a release calls `createSuite(title)` (required by default)
 * and must therefore never skip silently: a missing prerequisite is a build
 * failure, not a reason to publish untested code. Suites that only run when an
 * optional dependency happens to resolve call `createSuite(title, { required:
 * false })` and may exit 3.
 *
 * Nothing here reaches the network: the network-dependent suites live in
 * `tests/network/` and never gate a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the plugin root (the directory holding package.json). */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Suites append one JSON line describing their result to this file when the
 * runner sets the variable, so `run.mjs` can report skip reasons per suite
 * instead of parsing console text.
 */
export const RESULT_FILE_ENV = 'DSH_TEST_RESULT_FILE';

export function createSuite(title, { required = true } = {}) {
  const failures = [];
  const skips = [];
  let passed = 0;

  return {
    required,
    title,
    async check(name, fn) {
      try {
        const detail = await fn();
        passed += 1;
        console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
      } catch (error) {
        failures.push(`${name}: ${error && error.message}`);
        console.log(`  FAIL  ${name} — ${error && error.message}`);
      }
    },
    skip(name, reason) {
      skips.push({ name, reason: reason || 'no reason given' });
      console.log(`  SKIP  ${name}${reason ? ` — ${reason}` : ''}`);
    },
    finish() {
      const result = {
        title,
        required,
        passed,
        failed: failures.length,
        skipped: skips.length,
        skipReasons: skips.slice(),
        failures: failures.slice(),
        ok: failures.length === 0 && (!required || skips.length === 0),
      };
      console.log(`  ${passed}/${passed + failures.length} checks passed, ${failures.length} failed${skips.length ? `, ${skips.length} skipped` : ''}`);
      for (const line of failures) console.log(`  · ${line}`);
      for (const item of skips) console.log(`  ~ skipped ${item.name}: ${item.reason}`);
      if (required && skips.length) {
        console.log(`  RELEASE BLOCKER: ${skips.length} required check(s) were skipped, so this build is not releasable`);
      }
      persist(result);
      return result;
    },
  };
}

/** Record the suite result for the runner (best effort: never fails a suite). */
function persist(result) {
  const target = process.env[RESULT_FILE_ENV];
  if (!target) return;
  try {
    fs.appendFileSync(target, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {
    /* reporting must never break the suite itself */
  }
}

/**
 * Suite exit code.
 *  - 1 when a check failed, or when a required suite skipped anything
 *  - 3 when nothing ran at all and the suite is optional
 *  - 0 otherwise
 */
export function exitCodeFor(result) {
  if (result.failed) return 1;
  if (result.required !== false && result.skipped > 0) return 1;
  return result.passed === 0 && result.skipped > 0 ? 3 : 0;
}
