/**
 * Repository hygiene gate (0.6.0, publication tasks A1/A2/A5).
 *
 * The published tarball is a promise: no secrets, no author-specific paths, no
 * personal data, a licence, a changelog, and the documentation a stranger needs
 * to install and trust it. Everything checked here is checked on the *shipped*
 * files, so the gate cannot pass on a repository that leaks.
 *
 *   node tests/offline/repo.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, createSuite, exitCodeFor } from './harness.mjs';

const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

const relative = (file) => path.relative(PLUGIN_ROOT, file).split(path.sep).join('/');

/** Files a user actually receives: `files` in package.json plus the manifest. */
function shippedFiles() {
  const listed = [];
  for (const entry of pkg.files || []) {
    const full = path.join(PLUGIN_ROOT, entry);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, listed);
    else listed.push(full);
  }
  listed.push(path.join(PLUGIN_ROOT, 'package.json'));
  return [...new Set(listed)];
}

const suite = createSuite('repo: publication hygiene');

await suite.check('the manifest describes a publishable package', () => {
  assert.match(pkg.name, /^dsh-[a-z0-9-]+$/);
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, undefined, 'the package must not be private if it is meant to be installed from a registry');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.engines && /^>=?\d+/.test(pkg.engines.node), 'an engines floor is what makes the Node requirement enforceable');
  assert.ok(pkg.scripts && pkg.scripts.test, 'npm test must exist (task A3)');
  assert.equal(pkg.scripts['test:offline'], 'node tests/offline/run.mjs');
  for (const entry of ['lib', 'docs', 'tests', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), `package.json files[] is missing ${entry}`);
  }
  for (const entry of ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'cordis.patch.yml']) {
    assert.ok(existsSync(path.join(PLUGIN_ROOT, entry)), `${entry} is missing`);
  }
  const peers = pkg.peerDependencies || {};
  const cordisPeer = peers.cordis ?? peers['@deepseek-ai/cordis'];
  assert.ok(cordisPeer, 'cordis is the host contract and must stay a peer dependency');
  assert.notEqual((pkg.peerDependenciesMeta || {}).cordis?.optional, true, 'the host contract cannot be optional');
  assert.notEqual((pkg.peerDependenciesMeta || {})['@deepseek-ai/cordis']?.optional, true, 'the host contract cannot be optional');
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length, 'a plugin with runtime dependencies needs them bundled; keep the tree empty');
  for (const [name, range] of Object.entries(pkg.peerDependenciesMeta || {})) {
    assert.ok(peers[name], `peerDependenciesMeta mentions ${name}, which is not a peer dependency`);
    assert.equal(range.optional, true, `${name} must be optional (it is resolved through the host at runtime)`);
  }
  return `${pkg.name}@${pkg.version}`;
});

await suite.check('no secret, key or credential is shipped', () => {
  const patterns = [
    ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['OpenAI-style key', /\bsk-[A-Za-z0-9]{16,}/],
    ['generic assignment', /\b(?:api[_-]?key|apikey|secret|passwd|password|token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
    ['bearer token', /Bearer\s+[A-Za-z0-9._-]{16,}/],
    ['authorization header', /['"]authorization['"]\s*:\s*['"][^'"]+['"]/i],
  ];
  const offenders = [];
  for (const file of shippedFiles()) {
    if (!/\.(js|mjs|json|md|yml|yaml|txt)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of patterns) {
      const match = text.match(pattern);
      if (match && !/placeholder|example|your[-_ ]?key|<.*>|xxx/i.test(match[0])) offenders.push(`${relative(file)}: ${label}`);
    }
  }
  assert.deepEqual(offenders, [], `possible credentials:\n  ${offenders.join('\n  ')}`);
  return `${shippedFiles().length} files scanned`;
});

await suite.check('no author-specific path or personal data is shipped', () => {
  const patterns = [
    ['windows user profile', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b|<|\$)/i],
    ['home directory', /[A-Za-z]:[\\/]{1,2}(?:Users|Documents)[\\/]{1,2}[\w.-]+/i],
    ['posix home directory', /\/(?:home|Users)\/(?!user\b|username\b|<|\$)[a-z0-9._-]+\//i],
    ['absolute unix path into a checkout', /\/(?:mnt|opt|srv)\/[\w.-]+\/[\w.-]+\/[\w.-]+/],
  ];
  const offenders = [];
  for (const file of shippedFiles()) {
    if (!/\.(js|mjs|json|md|yml|yaml|txt)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of patterns) {
      const match = text.match(pattern);
      if (match) offenders.push(`${relative(file)}: ${label} → ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `author-specific paths leaked into the tarball:\n  ${offenders.join('\n  ')}`);
  return 'no absolute home paths';
});

await suite.check('the licence is a real licence and the changelog covers this release', () => {
  const licence = readFileSync(path.join(PLUGIN_ROOT, 'LICENSE'), 'utf8');
  assert.match(licence, /MIT License/);
  assert.match(licence, /Permission is hereby granted, free of charge/);
  assert.match(licence, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const changelog = readFileSync(path.join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## ${pkg.version}`) || changelog.includes(`## [${pkg.version}]`), `CHANGELOG.md has no section for ${pkg.version}`);
  assert.match(changelog, /## \d+\.\d+\.\d+/, 'the changelog must keep at least one released version');
  return `LICENSE + ${pkg.version}`;
});

await suite.check('.gitignore keeps machine state and dependency trees out of the repo', () => {
  const ignore = readFileSync(path.join(PLUGIN_ROOT, '.gitignore'), 'utf8');
  for (const entry of ['node_modules', '*.log', '.DS_Store']) {
    assert.ok(ignore.includes(entry), `.gitignore is missing ${entry}`);
  }
  assert.ok(!/^\s*lib\s*$/m.test(ignore), 'lib/ is the product and must not be ignored');
  return 'machine state ignored';
});

await suite.check('the documentation set a stranger needs exists and is readable', () => {
  const required = [
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/API.md',
    'docs/ARCHITECTURE.md',
    'docs/COMPATIBILITY.md',
    'docs/DATA_COMPLIANCE.md',
    'docs/DATA_SOURCES.md',
    'docs/DELIVERY-REPORT.md',
    'docs/DEVELOPMENT.md',
    'docs/PRIVACY.md',
    'docs/TROUBLESHOOTING.md',
    'docs/ROADMAP.md',
    'docs/RELEASE_CHECKLIST.md',
    'docs/RELEASING.md',
    'docs/RELEASE_TEMPLATE.md',
    'docs/screenshots/README.md',
    '.github/workflows/ci.yml',
  ];
  const missing = required.filter((entry) => !existsSync(path.join(PLUGIN_ROOT, entry)));
  assert.deepEqual(missing, [], `missing documentation: ${missing.join(', ')}`);
  for (const entry of required.filter((e) => e.endsWith('.md'))) {
    const text = readFileSync(path.join(PLUGIN_ROOT, entry), 'utf8');
    assert.ok(text.length > 200, `${entry} looks empty`);
    assert.match(text, /^#\s+\S/m, `${entry} needs a top-level heading`);
  }
  return `${required.length} documents present`;
});

await suite.check('the README answers the first five questions on the first screen', () => {
  const readme = readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const head = readme.slice(0, 4000);
  assert.match(head, /dsh-trading-mode/, 'what is this');
  assert.match(head, /(install|安装)/i, 'how do I install it');
  assert.match(head, /(limit|limitation|not|cannot|不支持|限制)/i, 'what does it not do');
  assert.match(head, /(node(?:\.js)?|DSH)[^\n]{0,24}?(>=|≥|20\b|version)/i, 'what does it need');
  assert.match(head, /(npm test|test:offline|verify)/i, 'how do I check it works');
  assert.ok(readme.length > 3000, 'the README is still the main document');
  return 'positioning, install, limits, requirements, verification';
});

await suite.check('the storage scope is stated, not implied', () => {
  const texts = ['README.md', 'docs/COMPATIBILITY.md'].map((entry) => readFileSync(path.join(PLUGIN_ROOT, entry), 'utf8'));
  const combined = texts.join('\n');
  assert.match(
    combined,
    /(same machine|single[\s-]?machine|local machine|单机|同一台机器|本机)/i,
    'the docs must say where watchlist/preferences live',
  );
  assert.match(combined, /(cross[\s-]?device|sync|跨设备|同步)/i, 'and what is *not* promised');
  return 'single machine, no cross-device promise';
});

await suite.check('the release label comes from package.json, not from a plan document', () => {
  const readme = readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.ok(!/V0\.1/.test(readme), 'the README must not cite the design document as the release label');
  assert.ok(!/策划案\s*V?0?\.1/.test(readme), 'the README must not cite the design document as the release label');
  const changelog = readFileSync(path.join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(pkg.version), 'the changelog must name the version being published');
  return `released as ${pkg.version}`;
});

process.exit(exitCodeFor(suite.finish()));
