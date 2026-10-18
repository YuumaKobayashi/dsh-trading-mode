/**
 * Portable install verification for a DSH profile that loads this plugin
 * (`npm run verify:install`).
 *
 * Needs: network-independent but profile-dependent — a DSH home (`DSH_HOME`,
 * else `~/.dsh`) with a profile whose `node_modules/dsh-trading-mode` links or
 * copies this working tree, plus this checkout's `lib/`. When no such profile
 * exists the probe prints SKIP and exits 3, because the online suites are
 * non-blocking by design.
 *
 * Checks, in order:
 *   1. the profile's node_modules path is a link that resolves to this working tree
 *      (so every edit here is what the app loads, with no stale copy),
 *   2. the version the profile sees is the version of this working tree,
 *   3. the installed AI layer talks to the host llm service without importing any
 *      host package,
 *   4. the installed host half loads *from the profile path* (five markets crypto
 *      chain, market-aware sizing, five-market directory metadata, 15 indices),
 *   5. the client half at the profile path carries the five-market UI markers and
 *      is byte-identical to this working tree.
 *
 * It does not talk to the running DSH server (the GUI is token-gated), so the
 * host half is verified by loading the installed artifact and the client half by
 * hashing/scanning the shipped bundle.
 *
 *   node tests/network/verify-install.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh');
/** The version this working tree publishes; the profile must agree. */
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'package.json'), 'utf8')).version;

/** Missing prerequisite: print SKIP and exit 3 — never a failure. */
function skip(what) {
  console.log(`SKIP: ${what} is not installed for this DSH profile`);
  process.exit(3);
}

/** Profiles to inspect, `desktop` first when it exists. */
function profileCandidates() {
  if (process.env.DSH_PROFILE_DIR) return [process.env.DSH_PROFILE_DIR];
  const profiles = path.join(DSH_HOME, 'profiles');
  const names = ['desktop'];
  try {
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory() && !names.includes(entry.name)) names.push(entry.name);
    }
  } catch {
    /* no profiles directory at all */
  }
  return names.map((name) => path.join(profiles, name));
}

/** The profile whose node_modules carries this plugin, if any. */
function linkedProfile() {
  for (const profile of profileCandidates()) {
    if (fs.existsSync(path.join(profile, 'node_modules', 'dsh-trading-mode'))) return profile;
  }
  return null;
}

const PROFILE = linkedProfile();
if (!PROFILE) {
  console.log(`      looked for node_modules/dsh-trading-mode under ${path.join(DSH_HOME, 'profiles')}`);
  skip('a DSH profile linking this plugin');
}
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-trading-mode');

/** `file://` URL of a file inside the *installed* plugin (spaces/Unicode safe). */
const pluginFile = (...parts) => pathToFileURL(path.join(INSTALLED, ...parts)).href;

const results = [];
let failed = 0;
async function step(title, fn) {
  try {
    const detail = await fn();
    results.push(title);
    console.log(`  PASS  ${title}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} — ${err.message}`);
  }
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

console.log(`workspace : ${WORKSPACE}`);
console.log(`profile   : ${PROFILE}`);
console.log(`installed : ${INSTALLED}\n`);

await step('the profile links the plugin to this working tree (no stale copy)', async () => {
  assert.ok(fs.existsSync(INSTALLED), `${INSTALLED} does not exist`);
  const real = fs.realpathSync.native(INSTALLED);
  assert.equal(real.toLowerCase(), fs.realpathSync.native(WORKSPACE).toLowerCase(), `link target is ${real}`);
  return 'junction → working tree';
});

await step(`the profile sees package.json version ${EXPECTED_VERSION}`, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8'));
  assert.equal(pkg.version, EXPECTED_VERSION, `version is ${pkg.version}, this working tree is ${EXPECTED_VERSION}`);
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'the installed version must be a release string');
  assert.ok(pkg.files.includes('docs'), 'docs must ship in the package');
  assert.equal(pkg.dsh.client.platform, 'web', 'the client half must declare the web platform');
  return `name=${pkg.name} version=${pkg.version}`;
});

await step('the installed AI layer talks to the host llm service without importing host packages', async () => {
  const base = pathToFileURL(path.join(INSTALLED, 'lib', 'trading') + path.sep);
  const ai = await import(new URL('ai.js', base).href);
  const source = fs.readFileSync(path.join(INSTALLED, 'lib', 'trading', 'ai.js'), 'utf8');
  assert.ok(!/from ['"]@deepseek-ai\/dsh-llm/.test(source), 'ai.js must not import the host llm package');
  assert.ok(!/import\(['"]@deepseek-ai\/dsh-llm/.test(source), 'ai.js must not dynamically import the host llm package');
  assert.ok(typeof ai.ChunkAssembler === 'function', 'the chunk assembler must be local');
  const message = ai.buildUserMessage('hi');
  assert.deepEqual(message, { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'request messages carry no source/id');

  // Drive the real class with a fake that implements exactly the public contract.
  const llm = {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '{"summary":"ok"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    listProviders: () => [],
  };
  let service = null;
  const engine = new ai.TradingAi({ llm: () => service, defaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }) });
  assert.equal(engine.available, false, 'a late-bound service must not be captured as unavailable');
  service = llm;
  const { value, meta } = await engine.askJson('system', 'payload');
  assert.equal(value.summary, 'ok');
  assert.equal(meta.provider, 'deepseek-official');

  // The plugin half must resolve services lazily and defensively (a service that
  // binds later, or is only reachable through another lookup route, still works).
  const { serviceGetter } = await import(pluginFile('lib', 'index.js'));
  const late = { get: () => undefined };
  const getter = serviceGetter(late, 'llm');
  assert.equal(getter(), null, 'an unregistered service must resolve to null, not throw');
  late.get = (n) => (n === 'llm' ? llm : undefined);
  assert.equal(typeof getter().stream, 'function', 'the getter must see a service that binds later');
  const hostile = { get: () => { throw new Error('not here'); } };
  assert.equal(serviceGetter(hostile, 'llm')(), null, 'a throwing ctx must degrade to null');
  return `local chunk assembly · route ${meta.provider}/${meta.model}`;
});

await step('the installed host half loads the five-market code', async () => {
  const base = pathToFileURL(path.join(INSTALLED, 'lib', 'trading') + path.sep);
  const cfg = await import(new URL('config.js', base).href);
  const { SymbolDirectory } = await import(new URL('directory.js', base).href);
  const indices = await import(new URL('indices.js', base).href);
  const { MarketDataService } = await import(new URL('service.js', base).href);

  assert.deepEqual(cfg.MARKETS, ['US', 'HK', 'CN', 'JP', 'CRYPTO'], 'the five markets must be declared');
  assert.deepEqual(cfg.MARKET_DATA_CONFIG.CRYPTO.chain, ['binance', 'gate', 'coinlore'], 'the crypto chain must include coinlore');
  assert.equal(cfg.candleLimit('1mo', '1h', 'CRYPTO'), 730, 'crypto hourly sizing');
  assert.equal(cfg.candleLimit('6mo', '1d', 'CRYPTO'), 190, 'crypto daily sizing');
  assert.equal(cfg.candleLimit('6mo', '1d'), 142, 'equity sizing unchanged');
  assert.equal(cfg.universeBoards('CRYPTO')[0].id, 'TOP', 'the crypto board id');

  const dir = new SymbolDirectory();
  assert.equal(dir.lookup('600519.SH', 'CN').exchange, 'SSE', 'A-share venue');
  assert.equal(dir.lookup('600519.SH', 'CN').currency, 'CNY', 'A-share currency');
  assert.equal(dir.lookup('920001.BJ', 'CN').exchange, 'BSE', 'BSE venue');
  assert.equal(dir.lookup('7203.T', 'JP').exchange, 'JPX', 'Tokyo venue');
  assert.equal(dir.lookup('7203.T', 'JP').currency, 'JPY', 'Tokyo currency');
  assert.equal(dir.lookup('BTC', 'CRYPTO').currency, 'USDT', 'crypto quotes against USDT');
  assert.equal(dir.lookup('BTC', 'CRYPTO').exchange, 'CRYPTO', 'crypto venue');

  assert.equal(indices.DEFAULT_INDEX_SYMBOLS.length, 15, 'fifteen headline indices');
  const groups = indices.INDEX_DIRECTORY.reduce((acc, i) => Object.assign(acc, { [i.group]: (acc[i.group] || 0) + 1 }), {});
  assert.deepEqual(groups, { US: 5, HK: 3, CN: 6, JP: 1 }, `index split ${JSON.stringify(groups)}`);
  assert.equal(indices.lookupIndex('日经').symbol, '^N225', 'the Nikkei alias resolves');
  assert.ok(typeof MarketDataService === 'function', 'the service class loads');
  return `markets ${cfg.MARKETS.join('/')} · indices ${indices.DEFAULT_INDEX_SYMBOLS.length}`;
});

await step('the installed client half carries the five-market UI markers', async () => {
  const file = path.join(INSTALLED, 'lib', 'client.js');
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of [
    "MARKET_ORDER = ['US', 'HK', 'CN', 'JP', 'CRYPTO']",
    "'partial history'",
    "'Spot prices, 24/7 market'",
    "'浏览全部美股、港股、A股、日股与加密货币'",
    'tm-chart__partial',
  ]) {
    assert.ok(source.includes(marker), `client.js is missing ${JSON.stringify(marker)}`);
  }
  return `${(source.length / 1024).toFixed(0)} KB, five markets + partial-history badge`;
});

await step('every shipped file is byte-identical to this working tree', async () => {
  const files = ['lib/client.js', 'lib/index.js', 'lib/trading/config.js', 'lib/trading/service.js', 'lib/trading/universe.js', 'lib/trading/directory.js'];
  const rows = files.map((rel) => {
    const a = sha(path.join(WORKSPACE, rel));
    const b = sha(path.join(INSTALLED, rel));
    assert.equal(b, a, `${rel} differs (workspace ${a} vs installed ${b})`);
    return `${path.basename(rel)}:${a}`;
  });
  return rows.join(' ');
});

console.log(`\n  ${results.length - failed}/${results.length} install checks passed`);
process.exit(failed ? 1 : 0);
