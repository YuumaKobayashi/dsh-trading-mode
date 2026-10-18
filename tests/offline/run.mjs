/**
 * `npm test` — the offline, deterministic suite (0.6.0, publication task A3;
 * release gate added in 0.7.0 task P0-3).
 *
 * Runs every suite in this directory in a child process with inherited stdio
 * (so output stays readable and no pipe is required) and exits non-zero if any
 * suite failed. Each suite reports its own result to `DSH_TEST_RESULT_FILE`, so
 * this runner can print the pass/fail/skip counts and *why* something was
 * skipped instead of guessing from the exit code.
 *
 *   node tests/offline/run.mjs              # developer run: SKIP does not fail
 *   node tests/offline/run.mjs --release    # release gate: any SKIP fails
 *   npm run test:client | test:ai | test:config | test:router | test:api | test:repo
 *
 * Network-dependent checks are deliberately *not* here: `npm run test:network`
 * drives the live providers and is allowed to fail (DEGRADED) without blocking.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const RELEASE = process.argv.includes('--release') || process.env.DSH_TEST_RELEASE === '1';

const SUITES = [
  ['syntax', 'syntax.test.mjs'],
  ['config', 'config.test.mjs'],
  ['transport', 'transport.test.mjs'],
  ['limits', 'limits.test.mjs'],
  ['router', 'router.test.mjs'],
  ['api', 'api.test.mjs'],
  ['fence', 'fence.test.mjs'],
  ['identity', 'identity.test.mjs'],
  ['watchlist', 'watchlist.test.mjs'],
  ['ai', 'ai.test.mjs'],
  ['client', 'client.test.mjs'],
  ['release-scripts', 'release-scripts.test.mjs'],
  ['repo', 'repo.test.mjs'],
];

/** Read back what one suite reported (best effort: older suites may not report). */
function readReport(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line)).filter((item) => item && item.title);
  } catch {
    return [];
  }
}

const results = [];
for (const [name, file] of SUITES) {
  const started = Date.now();
  const report = path.join(os.tmpdir(), `dsh-trading-${name}-${process.pid}.json`);
  try {
    fs.rmSync(report, { force: true });
  } catch {
    /* a stale file is harmless: the suite rewrites it before exiting */
  }
  const child = spawnSync(process.execPath, [path.join(HERE, file)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, DSH_TEST_RESULT_FILE: report },
  });
  const code = child.status === null ? 1 : child.status;
  const reports = readReport(report);
  const totals = reports.reduce(
    (acc, item) => ({
      passed: acc.passed + (item.passed || 0),
      failed: acc.failed + (item.failed || 0),
      skipped: acc.skipped + (item.skipped || 0),
    }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  const skipReasons = reports.flatMap((item) => item.skipReasons || []);
  let verdict = code === 0 ? 'PASS' : code === 3 ? 'SKIP' : 'FAIL';
  if (RELEASE && verdict === 'SKIP') verdict = 'FAIL';
  results.push({ name, file, verdict, code, ms: Date.now() - started, totals, skipReasons });
  try {
    fs.rmSync(report, { force: true });
  } catch {
    /* ignore */
  }
}

console.log('\n== offline suite summary ==');
for (const r of results) {
  const counts = r.totals.passed + r.totals.failed + r.totals.skipped
    ? `  ${r.totals.passed} passed, ${r.totals.failed} failed, ${r.totals.skipped} skipped`
    : '';
  console.log(`  ${r.verdict.padEnd(4)}  ${r.name.padEnd(9)} ${String(r.ms).padStart(6)}ms${counts}`);
  for (const reason of r.skipReasons) console.log(`        ~ skipped ${reason.name}: ${reason.reason}`);
}
const failed = results.filter((r) => r.verdict === 'FAIL');
const skipped = results.filter((r) => r.verdict === 'SKIP');
const totalSkipped = results.reduce((sum, r) => sum + r.totals.skipped, 0);
console.log(`  ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
console.log(
  RELEASE
    ? `  release gate: ${failed.length === 0 && totalSkipped === 0 ? 'PASS — no failures and no skipped checks' : 'FAIL — a release must not contain failed or skipped checks'}`
    : `  mode: development (use npm run test:release to gate a publication)`,
);
if (failed.length) {
  for (const f of failed) console.log(`  · ${f.file} (exit ${f.code})`);
  process.exit(1);
}
if (RELEASE && totalSkipped > 0) {
  console.log(`  · ${totalSkipped} check(s) were skipped; run without --release to see the reasons above`);
  process.exit(1);
}
