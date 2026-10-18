#!/usr/bin/env node
/**
 * Read-only DSH-profile inspector (0.8.0, round-3 audit findings P0-a3 / P0-c1).
 *
 * The installation question this answers is not "is the package on disk?" but
 * "is the profile that is *running* DSH loading **this** build, or a stale
 * copy?". A `link:`-style install and a copied install look identical through a
 * plain existence check, and the failure mode this repository hit during
 * development was exactly that: a profile kept a copy of an older revision while
 * the working tree moved on.
 *
 * What it reports, without changing one byte of the machine:
 *
 *   * which DSH home is in force and how it was resolved
 *     (`$DSH_HOME`, else `$DSH_DIR`, else the `~/.dsh` convention, honouring
 *     `HOME` / `USERPROFILE` on Windows);
 *   * which profiles exist under `<home>/profiles`;
 *   * per profile: whether its `package.json` declares `dsh-trading-mode`
 *     (dependencies / devDependencies / `dsh.profile.bundles`), what kind of
 *     entry `node_modules/dsh-trading-mode` is — **junction**, **symlink**, a
 *     real **directory** (a copy), or missing — the installed version, and
 *     whether the installed `lib/index.js` sha256 equals this checkout's.
 *
 * A junction (or a symlink into this checkout) reports a junction plus a hash
 * match; a copy reports a directory plus whichever hash that copy has. That pair
 * is what makes drift visible.
 *
 * READ-ONLY GUARANTEE: the only filesystem calls in this file are
 * `readFileSync`, `readdirSync`, `lstatSync`, `statSync`, `realpathSync` and
 * `readlinkSync`. It never writes a file, never creates a directory (not even
 * the home directory it is asked about), never runs a package manager, and never
 * touches the network.
 *
 * Exit codes
 *   0  a profile has the plugin installed, same version, same lib/index.js hash
 *   1  not installed anywhere, or installed with a different version / hash
 *   2  usage error, or an explicit `--profile` directory cannot be read
 *
 *   node scripts/inspect-profile.mjs [--profile <dir>] [--json] [--help]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-trading-mode';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXIT_OK = 0;
const EXIT_NOT_INSTALLED = 1;
const EXIT_USAGE = 2;

const USAGE = `dsh-trading-mode — read-only profile inspector

Usage:
  node scripts/inspect-profile.mjs [options]

Options:
  --profile <dir>   inspect this directory as a profile instead of enumerating
                    <DSH home>/profiles (repeatable)
  --json            print one JSON document on stdout (the only stdout output)
  --help, -h        print this help and exit 0

Environment:
  DSH_HOME, DSH_DIR  DSH home override, in that order
  HOME, USERPROFILE  used for the fallback convention (<home>/.dsh)

Exit codes:
  0  installed, version and lib/index.js hash match this checkout
  1  not installed, or version/hash mismatch
  2  usage or I/O error`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { json: false, help: false, profiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new UsageError('--profile needs a directory');
      opts.profiles.push(value);
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (!value) throw new UsageError('--profile needs a directory');
      opts.profiles.push(value);
    } else if (arg === '--read-only') {
      /* accepted and ignored: this tool is read-only by construction */
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** `os.homedir()` can throw on a broken environment; the tool must not. */
function safeHomedir() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

function envValue(env, name) {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Resolve the DSH home exactly the way the plugin does: DSH_HOME, DSH_DIR, `~/.dsh`. */
function resolveDshHome(env) {
  const fromDshHome = envValue(env, 'DSH_HOME');
  if (fromDshHome) return { path: path.resolve(fromDshHome), source: 'DSH_HOME' };
  const fromDshDir = envValue(env, 'DSH_DIR');
  if (fromDshDir) return { path: path.resolve(fromDshDir), source: 'DSH_DIR' };
  const home = envValue(env, 'HOME') || envValue(env, 'USERPROFILE') || safeHomedir();
  if (!home) return { path: null, source: 'unresolved (no DSH_HOME, DSH_DIR, HOME, USERPROFILE or homedir)' };
  return { path: path.join(home, '.dsh'), source: 'default convention (<home>/.dsh)' };
}

function sha256OfFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Windows reports a junction as a symlink too; the `\\?\` device prefix is the tell. */
function classifyEntry(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    const type = error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { type, path: target, linkTarget: null, resolvedTarget: null, error: (error && error.code) || 'unknown' };
  }
  const readLink = () => {
    try {
      return fs.readlinkSync(target);
    } catch {
      return null;
    }
  };
  const resolve = () => {
    try {
      return fs.realpathSync(target);
    } catch {
      return null;
    }
  };
  if (stats.isSymbolicLink()) {
    const linkTarget = readLink();
    const junction = process.platform === 'win32' && typeof linkTarget === 'string' && linkTarget.startsWith('\\\\?\\');
    return { type: junction ? 'junction' : 'symlink', path: target, linkTarget, resolvedTarget: resolve(), error: null };
  }
  if (stats.isDirectory()) return { type: 'directory', path: target, linkTarget: null, resolvedTarget: resolve(), error: null };
  if (stats.isFile()) return { type: 'file', path: target, linkTarget: null, resolvedTarget: resolve(), error: null };
  return { type: 'other', path: target, linkTarget: null, resolvedTarget: resolve(), error: null };
}

function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => {
    const cleaned = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
  };
  return normalize(a) === normalize(b);
}

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: (error && (error.code || error.message)) || 'unreadable' };
  }
}

function inspectProfile(dir, checkout) {
  const problems = [];
  const manifest = readJson(path.join(dir, 'package.json'));
  const declaredIn = [];
  if (manifest.value) {
    for (const field of ['dependencies', 'devDependencies']) {
      const value = manifest.value[field] && manifest.value[field][PLUGIN_NAME];
      if (value) declaredIn.push(`${field}:${value}`);
    }
  }
  let bundlesEntry = null;
  if (manifest.value && manifest.value.dsh && manifest.value.dsh.profile && Array.isArray(manifest.value.dsh.profile.bundles)) {
    bundlesEntry = manifest.value.dsh.profile.bundles.includes(PLUGIN_NAME);
  }

  const entry = classifyEntry(path.join(dir, 'node_modules', PLUGIN_NAME));
  const installedManifest = readJson(path.join(entry.path, 'package.json'));
  const installedVersion = installedManifest.value && typeof installedManifest.value.version === 'string' ? installedManifest.value.version : null;
  const indexSha256 = sha256OfFile(path.join(entry.path, 'lib', 'index.js'));

  const installed = Boolean(installedVersion) && entry.type !== 'missing' && entry.type !== 'unreadable' && entry.type !== 'file';
  const versionMatches = Boolean(installed && installedVersion === checkout.version);
  const indexHashMatches = Boolean(installed && indexSha256 && checkout.indexSha256 && indexSha256 === checkout.indexSha256);
  const pointsAtThisCheckout = samePath(entry.resolvedTarget, checkout.root);

  if (!manifest.value && manifest.error !== 'ENOENT') problems.push(`cannot read package.json (${manifest.error})`);
  if (installed && !versionMatches) problems.push(`installed version ${installedVersion} != checkout ${checkout.version}`);
  if (installed && !indexHashMatches) {
    problems.push(
      indexSha256
        ? 'installed lib/index.js sha256 differs from this checkout (stale or edited copy)'
        : 'installed lib/index.js is missing or unreadable',
    );
  }
  if (!installed && declaredIn.length) problems.push('declared as a dependency but node_modules/dsh-trading-mode is not an installed directory');

  return {
    name: path.basename(dir),
    path: dir,
    packageJsonExists: manifest.error !== 'ENOENT',
    dependencyDeclared: declaredIn.length > 0,
    declaredIn,
    bundlesEntry,
    entryType: entry.type,
    entryPath: entry.path,
    linkTarget: entry.linkTarget,
    resolvedTarget: entry.resolvedTarget,
    pointsAtThisCheckout,
    installed,
    installedVersion,
    versionMatches,
    indexSha256,
    indexHashMatches,
    matches: Boolean(installed && versionMatches && indexHashMatches),
    problems,
  };
}

function listProfileDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return { dirs: [], error: (error && error.code) || 'unreadable' };
  }
  const dirs = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    // `profiles/node_modules` is the hoisted dependency tree, not a profile, and
    // a dot-directory is host state kept next to the profiles.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    try {
      if (fs.statSync(full).isDirectory()) dirs.push(full);
    } catch {
      /* a dangling entry is not a profile */
    }
  }
  dirs.sort();
  return { dirs, error: null };
}

function main(argv, env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  const home = resolveDshHome(env);
  const checkout = {
    root: PLUGIN_ROOT,
    name: PLUGIN_NAME,
    version: (readJson(path.join(PLUGIN_ROOT, 'package.json')).value || {}).version || null,
    indexPath: path.join(PLUGIN_ROOT, 'lib', 'index.js'),
    indexSha256: sha256OfFile(path.join(PLUGIN_ROOT, 'lib', 'index.js')),
  };

  let profileDirs = [];
  let profilesRoot = null;
  let profilesError = null;
  if (opts.profiles.length) {
    for (const raw of opts.profiles) {
      const full = path.resolve(raw);
      let stats;
      try {
        stats = fs.statSync(full);
      } catch (error) {
        throw new UsageError(`--profile ${raw}: ${(error && error.code) || 'unreadable'}`);
      }
      if (!stats.isDirectory()) throw new UsageError(`--profile ${raw}: not a directory`);
      profileDirs.push(full);
    }
  } else if (home.path) {
    profilesRoot = path.join(home.path, 'profiles');
    const listed = listProfileDirs(profilesRoot);
    profileDirs = listed.dirs;
    profilesError = listed.error;
  }

  const profiles = profileDirs.map((dir) => inspectProfile(dir, checkout));
  const matching = profiles.filter((item) => item.matches);
  const installedAnywhere = profiles.some((item) => item.installed);

  let verdict;
  let exitCode;
  const messages = [];
  if (!profiles.length) {
    verdict = 'no-profiles';
    exitCode = EXIT_NOT_INSTALLED;
    if (!home.path) messages.push('no profiles found: the DSH home could not be resolved');
    else if (profilesError === 'ENOENT') messages.push(`no profiles found: ${profilesRoot} does not exist`);
    else if (profilesError) messages.push(`no profiles found: cannot read ${profilesRoot} (${profilesError})`);
    else messages.push(`no profiles found under ${profilesRoot}`);
  } else if (matching.length) {
    verdict = 'ok';
    exitCode = EXIT_OK;
    messages.push(`${matching.length}/${profiles.length} profile(s) load this checkout (version ${checkout.version}, lib/index.js sha256 match)`);
  } else if (installedAnywhere) {
    verdict = 'mismatch';
    exitCode = EXIT_NOT_INSTALLED;
    messages.push('the plugin is installed, but no profile matches this checkout (version and/or lib/index.js)');
  } else {
    verdict = 'not-installed';
    exitCode = EXIT_NOT_INSTALLED;
    messages.push(`${PLUGIN_NAME} is not installed in any of the ${profiles.length} profile(s) found`);
  }

  const report = {
    tool: 'inspect-profile',
    plugin: PLUGIN_NAME,
    readOnly: true,
    platform: process.platform,
    node: process.version,
    checkout,
    dshHome: { path: home.path, source: home.source, exists: Boolean(home.path && fs.existsSync(home.path)) },
    profilesRoot,
    profilesRootReadable: profilesError === null,
    profileCount: profiles.length,
    profiles,
    verdict,
    messages,
    exitCode,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${PLUGIN_NAME} — profile inspection (read-only)\n`);
    process.stdout.write(`  checkout            ${checkout.root}\n`);
    process.stdout.write(`  checkout version    ${checkout.version}\n`);
    process.stdout.write(`  checkout lib sha256 ${checkout.indexSha256 || 'unreadable'}\n`);
    process.stdout.write(`  DSH home            ${home.path || '(unresolved)'}  [${home.source}]\n`);
    if (profilesRoot) process.stdout.write(`  profiles root       ${profilesRoot}\n`);
    if (!profiles.length) {
      process.stdout.write('  no profiles found\n');
    }
    for (const profile of profiles) {
      process.stdout.write(`\n  profile ${profile.name}\n`);
      process.stdout.write(`    dir                 ${profile.path}\n`);
      process.stdout.write(`    dependency declared ${profile.dependencyDeclared ? profile.declaredIn.join(', ') : 'no'}\n`);
      if (profile.bundlesEntry !== null) process.stdout.write(`    in dsh bundles      ${profile.bundlesEntry ? 'yes' : 'no'}\n`);
      process.stdout.write(`    node_modules entry  ${profile.entryType}\n`);
      if (profile.linkTarget) process.stdout.write(`    link target         ${profile.linkTarget}\n`);
      if (profile.resolvedTarget) process.stdout.write(`    resolves to         ${profile.resolvedTarget}\n`);
      process.stdout.write(`    points at checkout  ${profile.pointsAtThisCheckout ? 'yes' : 'no'}\n`);
      process.stdout.write(`    installed version   ${profile.installedVersion || '(not installed)'}\n`);
      process.stdout.write(`    version matches     ${profile.versionMatches ? 'yes' : 'no'}\n`);
      process.stdout.write(`    lib sha256          ${profile.indexSha256 || '(unreadable)'}\n`);
      process.stdout.write(`    hash matches        ${profile.indexHashMatches ? 'yes' : 'no'}\n`);
      for (const problem of profile.problems) process.stdout.write(`    problem             ${problem}\n`);
    }
    for (const message of messages) process.stdout.write(`\n  ${message}\n`);
    const hints = [];
    if (verdict === 'mismatch') hints.push('reinstall the plugin from this checkout with plugin_manager({ action: "install_bundle", target: "<absolute path to this checkout>" }) and restart DSH');
    if (verdict === 'not-installed') hints.push('install with plugin_manager({ action: "install_bundle", target: "<absolute path to this checkout>" }) and restart DSH');
    for (const hint of hints) process.stdout.write(`  hint: ${hint}\n`);
  }

  return exitCode;
}

let code = EXIT_USAGE;
try {
  code = main(process.argv.slice(2), process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ tool: 'inspect-profile', verdict: 'error', error: message, exitCode: EXIT_USAGE }, null, 2)}\n`);
  } else {
    process.stderr.write(`inspect-profile: ${message}\n\n${USAGE}\n`);
  }
  code = EXIT_USAGE;
}
process.exit(code);
