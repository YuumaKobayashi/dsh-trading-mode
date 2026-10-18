/**
 * Syntax gate: every shipped JS file must parse (`node --check`).
 *
 * Cheap, offline and the first thing CI runs — it catches the class of mistake
 * that a browser bundle would otherwise hide until runtime.
 *
 *   node tests/offline/syntax.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, createSuite, exitCodeFor } from './harness.mjs';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const suite = createSuite('syntax: every lib/**/*.js parses');
const files = walk(path.join(PLUGIN_ROOT, 'lib')).sort();
const broken = [];

await suite.check(`lib/**/*.js is non-empty (${files.length} files)`, () => {
  if (!files.length) throw new Error('no JavaScript files found under lib/');
  const empty = files.filter((file) => statSync(file).size === 0);
  if (empty.length) throw new Error(`empty files: ${empty.map((f) => path.relative(PLUGIN_ROOT, f)).join(', ')}`);
  return `${files.length} files`;
});

await suite.check('node --check accepts every file', () => {
  for (const file of files) {
    const child = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (child.status !== 0) broken.push(path.relative(PLUGIN_ROOT, file));
  }
  if (broken.length) throw new Error(`did not parse: ${broken.join(', ')}`);
  return `${files.length} files`;
});

process.exit(exitCodeFor(suite.finish()));
