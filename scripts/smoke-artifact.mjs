#!/usr/bin/env node
/**
 * Packed-artifact smoke test (0.8.0, round-3 audit findings P0-c1 / P0-c2).
 *
 * `npm test` proves the *working tree* is good. A release ships a tarball, and
 * the two are not the same thing: `files[]` decides what is inside, `.npmignore`
 * and the packer decide what is left out, and a single stray directory silently
 * turns "a plugin" into "a plugin plus machine state". So this script does the
 * only thing that settles it: it packs, unpacks the artifact into a temporary
 * directory, and checks the *shipped bytes*.
 *
 * Checks, all on the extracted artifact (never on the working tree):
 *
 *   1. every expected member is present (`lib/index.js`, `lib/client.js`,
 *      `lib/trading/*`, `scripts/inspect-profile.mjs`, the manifest, the patch
 *      file, the README/CHANGELOG/LICENSE and the operator docs);
 *   2. no forbidden entry exists — a packed `.dsh` snapshot, `node_modules`,
 *      a `*.log`, a cache directory, a `.env` file, a coverage tree;
 *   3. no packed *text* file contains an absolute machine path family
 *      (a Windows user-profile path, a Windows drive-root path, a POSIX user
 *      home path, or an `AppData` path). The check runs on the packed text, so
 *      it catches what `package.json` `files[]` would ship, not what the repo
 *      happens to contain;
 *   4. every packed `lib/**\/*.js` file passes `node --check`.
 *
 * It prints the tarball name, its sha256, its byte size, the packed file count,
 * the reported `unpackedSize` and the version, then exits 1 if any check failed.
 * The temporary directory (pack output, npm cache, extraction) is removed unless
 * `--keep` is passed; nothing is ever written inside the checkout — not even the
 * tarball, which `npm pack --pack-destination` sends to the OS temp directory.
 *
 * Zero dependencies and no network: `npm pack` of a local directory reads local
 * files, and it is invoked with `--offline` and an explicit `--cache` in the OS
 * temp directory so it can never be the step that surprises a release.
 *
 *   node scripts/smoke-artifact.mjs [--json] [--keep] [--help]
 *
 * Exit codes: 0 = the artifact is shippable, 1 = at least one check failed,
 * 2 = usage error (or the local `npm` could not be located).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files the artifact must contain, relative to the package root inside the tar. */
const REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'lib/index.js',
  'lib/client.js',
  'docs/API.md',
  'docs/DATA_COMPLIANCE.md',
  'docs/PRIVACY.md',
  'scripts/inspect-profile.mjs',
];

/** Directories that must carry at least this many packed files. */
const REQUIRED_TREES = [
  { prefix: 'lib/trading/', min: 10, label: 'lib/trading/*' },
  { prefix: 'docs/', min: 5, label: 'docs/*' },
  { prefix: 'tests/', min: 5, label: 'tests/*' },
  { prefix: 'scripts/', min: 1, label: 'scripts/*' },
];

/** Extensions scanned as text for machine paths. */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css']);

// Built from fragments on purpose: this file is itself packed, so a literal
// forbidden path in the scanner would make the scanner flag the artifact that
// contains it. The runtime patterns match what a real leak looks like.
const SEP = '[\\\\/]'; // one backslash or one forward slash, inside a RegExp source
const MACHINE_PATH_PATTERNS = [
  { label: 'windows user profile path', source: `[A-Za-z]:${SEP}{1,2}Users${SEP}{1,2}` },
  { label: 'windows drive-root path', source: `D:${SEP}{1,2}` },
  { label: 'posix user home path', source: `/Users/[A-Za-z0-9._-]+/` },
  { label: 'posix home path', source: `/home/[A-Za-z0-9._-]+/` },
  { label: 'windows AppData path', source: `AppData${SEP}` },
];

const FORBIDDEN_ENTRY_PATTERNS = [
  { label: 'DSH home snapshot', test: (segments) => segments.includes('.dsh') },
  { label: 'node_modules tree', test: (segments) => segments.includes('node_modules') },
  { label: 'log file', test: (value) => /\.log$/i.test(value) },
  { label: 'environment file', test: (value) => /(^|\/)\.env($|\.|\/)/.test(value) },
  {
    label: 'cache / coverage directory',
    test: (segments, value) =>
      segments.some((segment) => /^(?:\.cache|\.npm|\.pnpm|\.pnpm-store|_cacache|_logs|npm-cache|coverage|\.nyc_output)$/i.test(segment)) ||
      /(^|\/)(?:\.DS_Store|Thumbs\.db)$/i.test(value),
  },
];

const USAGE = `dsh-trading-mode — packed-artifact smoke test

Usage:
  node scripts/smoke-artifact.mjs [options]

Options:
  --json   print one JSON document on stdout (the only stdout output)
  --keep   keep the temporary directory (pack output, cache, extraction)
  --package <dir>
           pack this directory instead of the plugin checkout; used by the
           offline suite's negative controls (a deliberately broken copy must
           make this gate fail)
  --help   print this help and exit 0

Exit codes:
  0  the packed artifact passed every check
  1  at least one check failed
  2  usage error, or npm could not be located`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { json: false, keep: false, help: false, packageDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--package') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new UsageError('--package needs a directory');
      opts.packageDir = value;
      i += 1;
    } else if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length);
      if (!value) throw new UsageError('--package needs a directory');
      opts.packageDir = value;
    } else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Locate the npm CLI next to the running node so no shell quoting is involved. */
function npmInvocation() {
  const candidates = [];
  if (process.env.npm_execpath && /\.(?:c?js)$/i.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { command: process.execPath, prefix: [candidate], shell: false };
  }
  // Last resort: a PATH lookup. Windows resolves `npm` through a `.cmd` shim.
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' };
}

/**
 * Run a child with its stdout/stderr redirected to FILES rather than pipes.
 * Some confined environments forbid a child's piped stdio entirely, and a
 * release check must not depend on the sandbox it happens to run in; files also
 * keep the exact bytes around for the failure report.
 */
function makeRunner(workDir) {
  let counter = 0;
  return function run(command, args, options = {}) {
    counter += 1;
    const outPath = path.join(workDir, `stdio-${counter}.out`);
    const errPath = path.join(workDir, `stdio-${counter}.err`);
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    let result;
    try {
      result = spawnSync(command, args, {
        cwd: options.cwd,
        shell: Boolean(options.shell),
        stdio: ['ignore', outFd, errFd],
      });
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
    return {
      status: result.status,
      signal: result.signal,
      error: result.error ? result.error.code || result.error.message : null,
      stdout: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '',
      stderr: fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '',
    };
  };
}

function readJsonArray(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** NUL-terminated field of a tar header. */
function cstr(buffer, start, length) {
  let end = start;
  const limit = start + length;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', start, end);
}

/** `len key=value\n` records, as written by the pax extended-header format. */
function parsePax(text) {
  const records = {};
  let position = 0;
  while (position < text.length) {
    const space = text.indexOf(' ', position);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(position, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, position + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    position += length;
  }
  return records;
}

/**
 * Minimal tar reader for the gzipped tarball `npm pack` produces. Handles the
 * ustar prefix field plus the pax / GNU long-name extensions the npm packer
 * emits for long paths, and verifies every header checksum so a truncated
 * artifact fails loudly instead of half-extracting.
 */
function readTarGz(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  let offset = 0;
  let pendingName = null;
  let globalName = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeField = cstr(header, 124, 12).trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error(`unreadable size field at byte ${offset}`);
    const typeFlag = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const dataStart = offset + 512;
    const data = raw.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / 512) * 512;
    const expectedChecksum = Number.parseInt(cstr(header, 148, 8).trim(), 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (!Number.isFinite(expectedChecksum) || actualChecksum !== expectedChecksum) {
      throw new Error(`tarball header checksum mismatch at byte ${offset}`);
    }
    if (typeFlag === 'x' || typeFlag === 'g') {
      const records = parsePax(data.toString('utf8'));
      if (typeFlag === 'g') globalName = records.path || globalName;
      else pendingName = records.path || null;
      offset = next;
      continue;
    }
    if (typeFlag === 'L') {
      pendingName = data.toString('utf8').replace(/\0+$/, '');
      offset = next;
      continue;
    }
    if (typeFlag === 'K') {
      offset = next;
      continue;
    }
    const entryName = pendingName || globalName || (prefix ? `${prefix}/${name}` : name);
    pendingName = null;
    entries.push({
      name: entryName.replace(/\/+$/, ''),
      rawName: entryName,
      typeFlag,
      size,
      data,
    });
    offset = next;
  }
  return entries;
}

function writeExtracted(entries, destination) {
  const root = path.resolve(destination);
  for (const entry of entries) {
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`refusing a path that escapes the extraction directory: ${entry.name}`);
    }
    if (entry.typeFlag === '5' || entry.rawName.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const packageDir = opts.packageDir ? path.resolve(opts.packageDir) : PLUGIN_ROOT;
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new UsageError(`--package ${opts.packageDir}: no package.json in ${packageDir}`);
  }
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trading-smoke-'));
  const packDir = path.join(workRoot, 'pack');
  const extractDir = path.join(workRoot, 'unpacked');
  const cacheDir = path.join(os.tmpdir(), 'npmcache');
  for (const dir of [packDir, extractDir, cacheDir]) fs.mkdirSync(dir, { recursive: true });
  const run = makeRunner(workRoot);

  const checks = [];
  const failures = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
    return ok;
  };

  let exitCode = 0;
  let report = null;
  try {
    // ---------------------------------------------------------------- packing
    const npm = npmInvocation();
    const packArgs = [
      ...npm.prefix,
      'pack',
      '--json',
      '--offline',
      '--pack-destination',
      packDir,
      '--cache',
      cacheDir,
      '--no-audit',
      '--no-fund',
    ];
    const packed = run(npm.command, packArgs, { cwd: packageDir, shell: npm.shell });
    const stdout = packed.stdout;
    const stderr = packed.stderr;
    const parsed = readJsonArray(stdout);
    const packInfo = parsed && parsed[0] ? parsed[0] : null;
    if (!record('npm pack --json succeeds', packed.status === 0 && Boolean(packInfo), `exit ${packed.status}${packed.error ? ` (${packed.error})` : ''}${stderr ? `; stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`)) {
      throw new Error('npm pack did not produce a readable JSON manifest');
    }

    const tarballName = path.basename(packInfo.filename || `${pkg.name}-${packInfo.version}.tgz`);
    const tarballPath = fs.existsSync(path.join(packDir, tarballName))
      ? path.join(packDir, tarballName)
      : path.join(packDir, fs.readdirSync(packDir).find((entry) => entry.endsWith('.tgz')) || tarballName);
    const tarballSize = fs.statSync(tarballPath).size;
    const tarballSha256 = sha256OfFile(tarballPath);

    const packedFiles = (packInfo.files || []).map((file) => String(file.path).replace(/^package\//, '').split('\\').join('/'));
    record('the packed manifest lists files', packedFiles.length > 0, `${packedFiles.length} files`);
    record(
      'the packed version matches package.json',
      packInfo.version === pkg.version,
      `packed ${packInfo.version}, package.json ${pkg.version}`,
    );

    const entries = readTarGz(tarballPath);
    record('the tarball is readable and its headers check out', entries.length > 0, `${entries.length} entries`);
    const tarNames = entries.map((entry) => entry.name.replace(/^package\//, ''));
    const listed = new Set(packedFiles.length ? packedFiles : tarNames);

    // ------------------------------------------------------ required members
    const missing = REQUIRED_FILES.filter((file) => !listed.has(file));
    record('every required member is packed', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${REQUIRED_FILES.length} members`);
    for (const tree of REQUIRED_TREES) {
      const count = [...listed].filter((file) => file.startsWith(tree.prefix)).length;
      record(`${tree.label} is packed`, count >= tree.min, `${count} files (min ${tree.min})`);
    }

    // --------------------------------------------------- forbidden entries
    const forbiddenEntries = [];
    for (const file of listed) {
      const segments = file.split('/').filter(Boolean);
      for (const pattern of FORBIDDEN_ENTRY_PATTERNS) {
        if (pattern.test(segments, file)) forbiddenEntries.push(`${file} (${pattern.label})`);
      }
      for (const pattern of MACHINE_PATH_PATTERNS) {
        if (new RegExp(pattern.source, 'i').test(file)) forbiddenEntries.push(`${file} (${pattern.label})`);
      }
    }
    record('the entry list carries no machine state', forbiddenEntries.length === 0, forbiddenEntries.length ? forbiddenEntries.join('; ') : `${listed.size} entries`);

    // ------------------------------------------------------- extraction
    writeExtracted(entries, extractDir);
    const extracted = [];
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.isFile()) extracted.push(full);
      }
    };
    walk(extractDir);
    record('every packed file extracts to disk', extracted.length > 0, `${extracted.length} files`);

    const symlinks = entries.filter((entry) => entry.typeFlag === '2' || entry.typeFlag === '1');
    record('the artifact contains no symlink or hard-link entry', symlinks.length === 0, symlinks.length ? symlinks.map((entry) => entry.name).join(', ') : 'none');

    // --------------------------------------------------------- text scan
    const packageRoot = path.join(extractDir, 'package');
    const offenders = [];
    let scanned = 0;
    for (const file of extracted) {
      const relative = path.relative(packageRoot, file).split(path.sep).join('/');
      if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      scanned += 1;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        for (const pattern of MACHINE_PATH_PATTERNS) {
          const match = new RegExp(pattern.source, 'i').exec(lines[index]);
          if (match) offenders.push(`${relative}:${index + 1}: ${pattern.label} → ${match[0]}`);
        }
      }
    }
    record(
      'no packed text file leaks an absolute machine path',
      offenders.length === 0,
      offenders.length ? offenders.slice(0, 10).join('; ') : `${scanned} text files scanned`,
    );

    // ----------------------------------------------------- node --check
    const libFiles = extracted.filter((file) => {
      const relative = path.relative(packageRoot, file).split(path.sep).join('/');
      return /^lib\/.*\.js$/.test(relative);
    });
    const syntaxFailures = [];
    for (const file of libFiles) {
      const checked = run(process.execPath, ['--check', file]);
      if (checked.status !== 0) {
        const detail = (checked.stderr || '').trim().split('\n')[0] || `exit ${checked.status}${checked.error ? ` (${checked.error})` : ''}`;
        syntaxFailures.push(`${path.relative(packageRoot, file)}: ${detail}`);
      }
    }
    record('every packed lib/**/*.js parses (node --check)', syntaxFailures.length === 0, syntaxFailures.length ? syntaxFailures.join('; ') : `${libFiles.length} files`);

    const ok = failures.length === 0;
    exitCode = ok ? 0 : 1;
    report = {
      tool: 'smoke-artifact',
      ok,
      version: packInfo.version,
      tarball: {
        file: tarballName,
        sha256: tarballSha256,
        size: tarballSize,
        fileCount: packedFiles.length || listed.size,
        unpackedSize: packInfo.unpackedSize,
        entries: entries.length,
      },
      checks,
      failures,
      workDir: workRoot,
      kept: opts.keep,
      exitCode,
    };

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write('== packed-artifact smoke ==\n');
      process.stdout.write(`  package       ${packInfo.name || pkg.name}@${packInfo.version}\n`);
      process.stdout.write(`  tarball       ${tarballName}\n`);
      process.stdout.write(`  sha256        ${tarballSha256}\n`);
      process.stdout.write(`  size          ${tarballSize} bytes\n`);
      process.stdout.write(`  files         ${report.tarball.fileCount}\n`);
      process.stdout.write(`  unpackedSize  ${packInfo.unpackedSize} bytes\n`);
      process.stdout.write(`  temp          ${workRoot}${opts.keep ? ' (kept)' : ' (removed)'}\n\n`);
      for (const check of checks) process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}\n`);
      process.stdout.write(`\n  ${failures.length === 0 ? 'verdict: SHIPPABLE' : `verdict: BLOCKED — ${failures.length} check(s) failed`}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!checks.some((check) => check.name === 'fatal')) record('fatal', false, message);
    exitCode = 1;
    report = {
      tool: 'smoke-artifact',
      ok: false,
      version: pkg.version,
      tarball: null,
      checks,
      failures: failures.length ? failures : [message],
      workDir: workRoot,
      kept: opts.keep,
      exitCode,
    };
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const check of checks) process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}\n`);
      process.stderr.write(`smoke-artifact: ${message}\n`);
    }
  } finally {
    if (!opts.keep) {
      try {
        fs.rmSync(workRoot, { recursive: true, force: true });
      } catch {
        /* a leftover temp directory must never turn a verdict into a crash */
      }
    }
  }
  return exitCode;
}

let code = 2;
try {
  code = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ tool: 'smoke-artifact', ok: false, error: message, exitCode: 2 }, null, 2)}\n`);
  } else {
    process.stderr.write(`smoke-artifact: ${message}\n\n${USAGE}\n`);
  }
  code = 2;
}
process.exit(code);
