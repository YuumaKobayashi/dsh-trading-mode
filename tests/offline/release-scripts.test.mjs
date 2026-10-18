/**
 * Release-engineering scripts and the CI contract (0.8.0, round-3 audit findings
 * P0-c1 / P0-c2 and the §1d release-engineering inputs).
 *
 * Three things a release depends on but nothing else in the offline suite would
 * notice if they rotted:
 *
 *   * `scripts/smoke-artifact.mjs` and `scripts/inspect-profile.mjs` still parse
 *     and still behave like command-line tools on bad input (a gate that exits
 *     `0` because it crashed after printing nothing is worse than no gate);
 *   * `scripts/inspect-profile.mjs` answers honestly when there is no DSH home
 *     and when the profile holds a stale copy — the two cases it exists for;
 *   * `.github/workflows/ci.yml` and `package-lock.json` still describe the same
 *     release: a lockfile-backed `npm ci`, the three blocking offline commands,
 *     the non-blocking live probe, and no "this repository has no lockfile" left
 *     over from before the lock existed.
 *
 * Every check here is offline and read-only: the scripts are run in a temporary
 * directory and nothing is written inside the checkout. Two of them do run
 * `npm pack` — always against a throwaway copy of the package, never against the
 * checkout — because a gate that cannot fail is not a gate: one copy has a
 * required member deleted and another has a machine path planted in a packed
 * file, and both must make `smoke-artifact` exit 1.
 *
 *   node tests/offline/release-scripts.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PLUGIN_ROOT, createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('release-scripts: artifact smoke, profile inspector and the CI contract');

const SMOKE = path.join('scripts', 'smoke-artifact.mjs');
const INSPECT = path.join('scripts', 'inspect-profile.mjs');
const MANIFEST = path.join(PLUGIN_ROOT, 'package.json');
const LOCKFILE = path.join(PLUGIN_ROOT, 'package-lock.json');
const CI = path.join(PLUGIN_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASING = path.join(PLUGIN_ROOT, 'docs', 'RELEASING.md');

const OFFLINE_SUITES = [
  'syntax',
  'config',
  'transport',
  'limits',
  'router',
  'api',
  'fence',
  'identity',
  'watchlist',
  'ai',
  'client',
  'release-scripts',
  'repo',
];

const tempRoots = [];

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`));
  tempRoots.push(dir);
  return dir;
}

/**
 * Run a child process with its streams redirected to real files.
 *
 * `spawnSync` with piped stdio cannot be used in this project's confined
 * environment (the pipe handshake is refused, so the child reports
 * `status: null` and an empty stdout), and the same trick is what
 * `scripts/smoke-artifact.mjs` uses to run `npm pack`.
 */
function runChild(command, args, { env, timeout = 60_000 } = {}) {
  const dir = tempDir('child');
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', outFd, errFd],
      env: env || process.env,
      timeout,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  return { status: result.status, error: result.error, stdout, stderr };
}

/** Run one of the two release scripts with the current interpreter. */
function runScript(relative, args, options) {
  return runChild(process.execPath, [path.join(PLUGIN_ROOT, relative), ...args], options);
}

/** An environment whose DSH home is `homePath` and nothing else. */
function envWithDshHome(homePath) {
  const env = { ...process.env };
  delete env.DSH_DIR;
  env.DSH_HOME = homePath;
  return env;
}

function readCi() {
  return fs.readFileSync(CI, 'utf8');
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `path|size|sha256` for every file under `root`, to prove nothing was written. */
function snapshotTree(root) {
  const rows = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else rows.push(`${path.relative(root, full)}|${fs.statSync(full).size}|${sha256OfFile(full)}`);
    }
  };
  walk(root);
  return rows;
}

/**
 * A throwaway copy of the plugin for the negative controls. `node_modules`, the
 * git directories and DSH state are skipped: `npm pack` does not need them and a
 * copy of them would only make the check slow.
 */
function copyPackage(label) {
  const target = path.join(tempDir('package'), label);
  fs.cpSync(PLUGIN_ROOT, target, {
    recursive: true,
    filter: (source) => !/(?:^|[\\/])(?:node_modules|\.git|\.dsh)(?:[\\/]|$)/.test(source),
  });
  return target;
}

/** The `--json` document of a run that is expected to produce one. */
function jsonOf(run, label) {
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`${label} did not print JSON (exit ${run.status}): ${String(run.stdout).slice(0, 200)}`);
  }
}

/**
 * Split a workflow into its job blocks (`  <name>:` at two-space indentation)
 * so a contract such as "the offline job must not tolerate failure" is checked
 * against the right job instead of against the whole file.
 */
function jobBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

try {
  await suite.check('both release scripts exist and parse (node --check)', () => {
    for (const relative of [SMOKE, INSPECT]) {
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, relative)), `${relative} is missing`);
      const checked = runChild(process.execPath, ['--check', path.join(PLUGIN_ROOT, relative)]);
      assert.equal(checked.status, 0, `${relative} does not parse: ${checked.stderr.trim().split('\n')[0]}`);
    }
    return 'node --check scripts/smoke-artifact.mjs scripts/inspect-profile.mjs';
  });

  await suite.check('package.json still declares the gate scripts and ships scripts/ and docs/', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    for (const script of ['check', 'test:release', 'smoke:artifact', 'inspect:profile']) {
      assert.ok(manifest.scripts && manifest.scripts[script], `package.json is missing the "${script}" script`);
    }
    for (const entry of ['lib', 'docs', 'scripts', 'tests']) {
      assert.ok(manifest.files.includes(entry), `package.json files[] must ship ${entry}/`);
    }
    for (const member of [
      'lib/index.js',
      'lib/client.js',
      'cordis.patch.yml',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'docs/RELEASING.md',
      'docs/RELEASE_CHECKLIST.md',
      'docs/RELEASE_TEMPLATE.md',
      'scripts/smoke-artifact.mjs',
      'scripts/inspect-profile.mjs',
      '.github/workflows/ci.yml',
    ]) {
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, member)), `${member} is missing from the checkout`);
    }
    return `${Object.keys(manifest.scripts).length} scripts, files[] ships ${manifest.files.join(', ')}`;
  });

  await suite.check('inspect-profile --help exits 0 and documents its contract', () => {
    const run = runScript(INSPECT, ['--help']);
    assert.equal(run.status, 0, `--help must exit 0, got ${run.status}`);
    for (const needle of ['Usage:', '--profile', '--json', '--help', 'Exit codes:', 'DSH_HOME']) {
      assert.ok(run.stdout.includes(needle), `--help output is missing ${needle}`);
    }
    assert.equal(run.stderr.trim(), '', `--help must not write to stderr: ${run.stderr.trim()}`);
    return 'usage, environment and exit codes are documented';
  });

  await suite.check('inspect-profile rejects an unknown flag with exit 2', () => {
    const run = runScript(INSPECT, ['--bogus-flag']);
    assert.equal(run.status, 2, `an unknown flag must exit 2, got ${run.status}`);
    assert.ok(run.stderr.includes('unknown argument: --bogus-flag'), `stderr did not explain the usage error: ${run.stderr.trim()}`);
    assert.equal(run.stdout.trim(), '', 'a usage error must not print a report on stdout');
    return 'exit 2 and the offending argument is named';
  });

  await suite.check('inspect-profile refuses --profile without a directory', () => {
    const run = runScript(INSPECT, ['--profile']);
    assert.equal(run.status, 2, `--profile without a value must exit 2, got ${run.status}`);
    assert.ok(run.stderr.includes('--profile needs a directory'), `stderr did not name the missing value: ${run.stderr.trim()}`);
    return 'exit 2 with the flag named';
  });

  await suite.check('inspect-profile reports "no profiles found" when the DSH home does not exist', () => {
    const home = path.join(tempDir('dsh-home'), 'absent');
    const run = runScript(INSPECT, ['--json'], { env: envWithDshHome(home) });
    assert.equal(run.status, 1, `an absent DSH home must exit 1 (not installed), got ${run.status}`);
    const report = jsonOf(run, 'inspect-profile --json');
    assert.equal(report.readOnly, true);
    assert.equal(report.dshHome.exists, false, 'the absent home must be reported as absent');
    assert.equal(report.profileCount, 0);
    assert.equal(report.verdict, 'no-profiles');
    assert.ok(
      report.messages.join(' ').includes('no profiles found'),
      `the report must say "no profiles found", got: ${report.messages.join(' ')}`,
    );
    return report.messages[0];
  });

  await suite.check('inspect-profile prints the missing-profile case in text mode too', () => {
    const home = path.join(tempDir('dsh-home'), 'absent');
    const run = runScript(INSPECT, [], { env: envWithDshHome(home) });
    assert.equal(run.status, 1, `an absent DSH home must exit 1, got ${run.status}`);
    assert.ok(run.stdout.includes('no profiles found'), `stdout did not report the missing profiles: ${run.stdout.slice(0, 200)}`);
    assert.ok(!/TypeError|ReferenceError/.test(run.stdout + run.stderr), 'a missing DSH home must not be reported as a crash');
    return 'exit 1 with an explanation, no stack trace';
  });

  await suite.check('inspect-profile accepts an explicit --profile directory', () => {
    const profile = path.join(tempDir('profile'), 'empty-profile');
    fs.mkdirSync(profile, { recursive: true });
    const run = runScript(INSPECT, ['--profile', profile, '--json'], { env: envWithDshHome(profile) });
    assert.equal(run.status, 1, `an empty profile must exit 1, got ${run.status}`);
    const report = jsonOf(run, 'inspect-profile --profile --json');
    assert.equal(report.profileCount, 1);
    assert.equal(report.profiles[0].installed, false);
    assert.equal(report.verdict, 'not-installed');
    return 'the explicit directory is inspected instead of <DSH home>/profiles';
  });

  await suite.check('inspect-profile flags an installed copy whose version and hash differ', () => {
    const profile = path.join(tempDir('profile'), 'stale');
    const installed = path.join(profile, 'node_modules', 'dsh-trading-mode');
    fs.mkdirSync(path.join(installed, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      JSON.stringify({ name: 'stale-profile', dependencies: { 'dsh-trading-mode': '0.7.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(installed, 'package.json'),
      JSON.stringify({ name: 'dsh-trading-mode', version: '0.7.0' }, null, 2),
    );
    fs.writeFileSync(path.join(installed, 'lib', 'index.js'), 'export const stale = true;\n');

    const run = runScript(INSPECT, ['--profile', profile, '--json'], { env: envWithDshHome(profile) });
    assert.equal(run.status, 1, `a stale copy must exit 1, got ${run.status}`);
    const profileReport = jsonOf(run, 'inspect-profile --profile --json').profiles[0];
    assert.equal(profileReport.installed, true, 'the node_modules entry exists, so the plugin is installed');
    assert.equal(profileReport.entryType, 'directory', 'a copied install is a directory, not a link');
    assert.equal(profileReport.installedVersion, '0.7.0');
    assert.equal(profileReport.versionMatches, false, 'the version differs from this checkout and must be reported');
    assert.equal(profileReport.indexHashMatches, false, 'the lib/index.js hash differs and must be reported');
    assert.equal(profileReport.matches, false);
    return 'installed 0.7.0, version and lib/index.js hash both differ';
  });

  await suite.check('inspect-profile reports ok for a profile holding an exact copy of this build', () => {
    const profile = path.join(tempDir('profile'), 'matching');
    const installed = path.join(profile, 'node_modules', 'dsh-trading-mode');
    fs.mkdirSync(path.join(installed, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      JSON.stringify(
        { name: 'matching-profile', dependencies: { 'dsh-trading-mode': 'file:./node_modules/dsh-trading-mode' }, dsh: { profile: { bundles: ['dsh-trading-mode'] } } },
        null,
        2,
      ),
    );
    fs.copyFileSync(MANIFEST, path.join(installed, 'package.json'));
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'lib', 'index.js'), path.join(installed, 'lib', 'index.js'));

    const before = snapshotTree(profile);
    const run = runScript(INSPECT, ['--profile', profile, '--json'], { env: envWithDshHome(profile) });
    assert.equal(run.status, 0, `a matching copy must exit 0, got ${run.status}: ${run.stdout.slice(0, 300)}`);
    const report = jsonOf(run, 'inspect-profile --profile --json');
    const profileReport = report.profiles[0];
    assert.equal(profileReport.bundlesEntry, true, 'the dsh.profile.bundles entry must be recognised');
    assert.equal(profileReport.versionMatches, true);
    assert.equal(profileReport.indexHashMatches, true);
    assert.equal(profileReport.matches, true);
    assert.equal(profileReport.pointsAtThisCheckout, false, 'a copy is not this checkout, even when it matches');
    assert.equal(report.verdict, 'ok');
    assert.deepEqual(
      snapshotTree(profile),
      before,
      'inspect-profile is read-only: it must not add, rewrite or touch a byte of the profile it inspects',
    );
    return 'version and lib/index.js hash match, and the profile is byte-identical afterwards';
  });

  await suite.check('smoke-artifact --help exits 0 and documents its flags', () => {
    const run = runScript(SMOKE, ['--help']);
    assert.equal(run.status, 0, `--help must exit 0, got ${run.status}`);
    for (const needle of ['Usage:', '--json', '--keep', '--package', '--help']) {
      assert.ok(run.stdout.includes(needle), `--help output is missing ${needle}`);
    }
    assert.equal(run.stderr.trim(), '', `--help must not write to stderr: ${run.stderr.trim()}`);
    return 'usage and flags are documented';
  });

  await suite.check('smoke-artifact rejects an unknown flag with exit 2', () => {
    const run = runScript(SMOKE, ['--no-such-flag']);
    assert.equal(run.status, 2, `an unknown flag must exit 2, got ${run.status}`);
    assert.ok(run.stderr.includes('unknown argument: --no-such-flag'), `stderr did not explain the usage error: ${run.stderr.trim()}`);
    return 'exit 2 and the offending argument is named';
  });

  await suite.check('smoke-artifact refuses a --package directory without a manifest (exit 2)', () => {
    const empty = tempDir('empty-package');
    const run = runScript(SMOKE, ['--package', empty]);
    assert.equal(run.status, 2, `a directory without package.json must exit 2, got ${run.status}`);
    assert.ok(run.stderr.includes('no package.json'), `stderr did not name the missing manifest: ${run.stderr.trim()}`);
    return 'exit 2 before npm pack is even attempted';
  });

  // ---------------------------------------------------------------------------
  // Negative controls: a release gate that cannot fail is not a gate. Both pack
  // a throwaway copy of the package, so the checkout itself stays untouched.
  // ---------------------------------------------------------------------------

  await suite.check('smoke-artifact fails when a required member is missing from the pack', () => {
    const copy = copyPackage('broken');
    fs.rmSync(path.join(copy, 'lib', 'client.js'));
    const run = runScript(SMOKE, ['--package', copy, '--json']);
    assert.equal(run.status, 1, `a missing required member must fail the gate, got ${run.status}: ${run.stdout.slice(0, 300)}`);
    const report = jsonOf(run, 'smoke-artifact --package --json');
    assert.equal(report.ok, false, 'a pack without lib/client.js must not be reported as shippable');
    const failed = report.checks.filter((check) => !check.ok).map((check) => `${check.name} — ${check.detail}`);
    assert.ok(
      failed.some((line) => /required member/.test(line) && /lib\/client\.js/.test(line)),
      `the failing check must name the missing member, got: ${failed.join(' | ') || '(no failing check)'}`,
    );
    return failed[0];
  });

  await suite.check('smoke-artifact fails when a packed text file leaks a machine path', () => {
    const copy = copyPackage('leaky');
    // Assembled from fragments so this test file never contains the literal path it plants.
    const leakyPath = ['C:', 'Users', 'nobody'].join(String.fromCharCode(92));
    fs.writeFileSync(
      path.join(copy, 'lib', 'trading', 'zz-leak-probe.js'),
      `// probe: this machine keeps its cache under ${leakyPath} \nexport const zzLeakProbe = true;\n`,
    );
    const run = runScript(SMOKE, ['--package', copy, '--json']);
    assert.equal(run.status, 1, `a planted machine path must fail the gate, got ${run.status}: ${run.stdout.slice(0, 300)}`);
    const report = jsonOf(run, 'smoke-artifact --package --json');
    const leak = report.checks.find((check) => /machine path/.test(check.name));
    assert.ok(leak, 'the machine-path scan must be part of the report');
    assert.equal(leak.ok, false, 'the machine-path scan must fail on the planted file');
    assert.ok(/zz-leak-probe\.js/.test(leak.detail), `the leak check must name the offending file, got: ${leak.detail}`);
    return leak.detail;
  });

  await suite.check('ci.yml installs the committed lockfile and blocks on the three gates', () => {
    const text = readCi();
    const offline = jobBlock(text, 'offline');
    assert.ok(offline, 'ci.yml must declare the "offline" job');
    assert.ok(offline.includes('npm ci'), 'the offline job must install with npm ci (a lockfile is committed)');
    assert.ok(!offline.includes('npm install '), 'the offline job must not fall back to a floating npm install');
    assert.ok(!offline.includes('continue-on-error'), 'the offline job must not tolerate a failure');
    for (const command of ['npm run check', 'npm run test:release', 'npm run smoke:artifact']) {
      assert.ok(offline.includes(command), `the offline job must run "${command}"`);
    }
    return 'npm ci, check, test:release and smoke:artifact are all blocking';
  });

  await suite.check('ci.yml keeps the live provider probe non-blocking and off the release gate', () => {
    const text = readCi();
    const probe = jobBlock(text, 'network-probe');
    assert.ok(probe, 'ci.yml must declare the "network-probe" job');
    assert.ok(probe.includes('continue-on-error: true'), 'the live probe must stay non-blocking');
    assert.ok(probe.includes('npm run test:network'), 'the probe job must run npm run test:network');
    assert.ok(
      !/run:\s*npm run (?:verify:install|inspect:profile)/.test(text),
      'verify:install and inspect:profile inspect a developer machine and must not run on a runner',
    );
    return 'the probe job is continue-on-error and the install probe is not wired into CI';
  });

  await suite.check('ci.yml lists every offline suite and keeps the lockfile story honest', () => {
    const text = readCi();
    assert.ok(!/no\s+lockfile/i.test(text), 'the stale "no lockfile" claim must be gone now that package-lock.json is committed');
    const missing = OFFLINE_SUITES.filter((name) => !text.includes(name));
    assert.deepEqual(missing, [], `ci.yml does not name every offline suite: missing ${missing.join(', ')}`);
    assert.ok(!/^\t/m.test(text), 'ci.yml must be indented with spaces (YAML forbids tabs)');
    return `all ${OFFLINE_SUITES.length} suites named, no stale lockfile claim`;
  });

  await suite.check('package-lock.json pins the three dev dependencies and no host peer', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
    assert.ok(Number(lock.lockfileVersion) >= 3, `lockfileVersion must be >= 3, got ${lock.lockfileVersion}`);
    const root = lock.packages[''];
    assert.equal(root.name, manifest.name);
    assert.equal(root.version, manifest.version);
    for (const name of ['react', 'react-dom', 'zod']) {
      assert.equal(root.devDependencies[name], manifest.devDependencies[name], `${name} must be pinned at the manifest range`);
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${name} must have a lock entry`);
      assert.equal(entry.dev, true, `${name} is a devDependency`);
      assert.ok(/^sha512-/.test(entry.integrity || ''), `${name} must carry a sha512 integrity sum`);
      assert.ok(/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || ''), `${name} must resolve to the registry tarball`);
    }
    assert.equal(lock.packages['node_modules/react'].version.split('.')[0], '18', 'react must stay on the 18.x line');
    assert.equal(lock.packages['node_modules/react-dom'].version.split('.')[0], '18', 'react-dom must stay on the 18.x line');
    assert.equal(lock.packages['node_modules/zod'].version.split('.')[0], '3', 'zod must stay on the 3.x line');
    return `lockfileVersion ${lock.lockfileVersion}, ${Object.keys(lock.packages).length} entries`;
  });

  await suite.check('the lockfile runs no third-party install script and resolves no @deepseek-ai package', () => {
    const lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
    const withScripts = Object.entries(lock.packages)
      .filter(([, entry]) => entry && entry.hasInstallScript)
      .map(([key]) => key || '(root)');
    assert.deepEqual(withScripts, [], `no locked package may run an install script: ${withScripts.join(', ')}`);
    const hosts = Object.keys(lock.packages).filter((key) => key.includes('@deepseek-ai/'));
    assert.deepEqual(hosts, [], `the host contract must come from the DSH runtime, not the lockfile: ${hosts.join(', ')}`);
    return `${Object.keys(lock.packages).length} entries, none with an install script`;
  });

  await suite.check('the manifest still ships zero runtime dependencies', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies || {}), [], 'a runtime dependency would have to be vendored and pinned');
    assert.ok(manifest.peerDependencies['@deepseek-ai/cordis'], 'the host contract peer must stay declared');
    return `peers: ${Object.keys(manifest.peerDependencies).join(', ')}`;
  });

  await suite.check('docs/RELEASING.md describes the same gates as this suite', () => {
    const text = fs.readFileSync(RELEASING, 'utf8');
    for (const needle of ['npm run check', 'npm run test:release', 'npm run smoke:artifact', 'npm ci', '--legacy-peer-deps', 'sha256']) {
      assert.ok(text.includes(needle), `docs/RELEASING.md must mention ${needle}`);
    }
    assert.ok(text.includes('RELEASE_CHECKLIST.md'), 'docs/RELEASING.md must point at the authoritative checklist');
    assert.ok(!/\bTODO\b/.test(text), 'a release runbook must not ship a TODO');
    return `${text.split('\n').length} lines of release runbook`;
  });
} finally {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
  }
}

process.exit(exitCodeFor(suite.finish()));
