/**
 * Watchlist persistence across all five markets (0.6.0).
 *
 * The watchlist used to declare `market: z.enum(['US','HK'])` for the host
 * storage-domain backend while the JSON fallback accepted anything, so an
 * A-share / Tokyo / crypto row could be rejected (or backed up and skipped) on
 * a host that provides `dsh-storage-domain`. These checks pin the schema to the
 * same market list the rest of the plugin uses, and prove the file backend
 * round-trips a row per market.
 *
 * zod is an optional peer of the *host*; when it cannot be resolved the schema
 * check reports SKIP rather than pretending to have run.
 *
 *   node tests/offline/watchlist.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { exitCodeFor, PLUGIN_ROOT, createSuite } from './harness.mjs';
import { MARKETS } from '../../lib/trading/config.js';
import {
  WATCHLIST_MARKET_VALUES,
  WatchlistStore,
  itemSchema,
  makeWatchlistItem,
} from '../../lib/trading/watchlist.js';

const suite = createSuite('watchlist persistence across every market');

const SAMPLES = [
  { symbol: 'AAPL', market: 'US', currency: 'USD' },
  { symbol: '0700.HK', market: 'HK', currency: 'HKD' },
  { symbol: '600519.SH', market: 'CN', currency: 'CNY' },
  { symbol: '7203.T', market: 'JP', currency: 'JPY' },
  { symbol: 'BTC', market: 'CRYPTO', currency: 'USDT' },
];

/** The API always passes the market it resolved; the hint is part of the row. */
const rowFor = (sample) => makeWatchlistItem({ symbol: sample.symbol, market: sample.market }, 'local-1', 0);

await suite.check('the stored market list cannot drift from the supported markets', () => {
  assert.deepEqual(WATCHLIST_MARKET_VALUES, MARKETS, 'watchlist markets differ from MARKETS');
  assert.equal(WATCHLIST_MARKET_VALUES.length, 5);
  return WATCHLIST_MARKET_VALUES.join(', ');
});

await suite.check('a row per market is built with the market venue currency', () => {
  for (const sample of SAMPLES) {
    const row = rowFor(sample);
    assert.equal(row.market, sample.market, `${sample.symbol} market`);
    assert.equal(row.currency, sample.currency, `${sample.symbol} currency`);
    assert.equal(row.userId, 'local-1');
  }
  // A row built without a hint must still carry a market (the symbol decides).
  const hinted = makeWatchlistItem({ symbol: '0700.HK' }, 'local-1', 0);
  assert.equal(hinted.market, 'HK', 'the symbol suffix must decide the market');
  assert.equal(hinted.currency, 'HKD');
  // A bare crypto ticker without a hint is a US listing by construction.
  assert.equal(makeWatchlistItem({ symbol: 'BTC' }, 'local-1', 0).market, 'US');
  return `${SAMPLES.length} rows`;
});

await suite.check('the file backend round-trips one row per market', async () => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trading-watchlist-'));
  const store = new WatchlistStore({ homeDir: home });
  try {
    await store.init();
    assert.equal(store.backend, 'file');
    for (const sample of SAMPLES) {
      await store.add('local-1', { symbol: sample.symbol, market: sample.market, name: sample.symbol });
    }
    const rows = await store.list('local-1');
    assert.equal(rows.length, SAMPLES.length, `stored ${rows.length} of ${SAMPLES.length} rows`);
    assert.deepEqual(
      rows.map((r) => r.market).sort(),
      SAMPLES.map((s) => s.market).sort(),
    );
    // A second identity shares the file but not the rows, and a remove sticks.
    assert.equal((await store.list('local-2')).length, 0);
    await store.remove('local-1', '7203.T');
    assert.equal((await store.list('local-1')).length, SAMPLES.length - 1);
    return `file backend stored ${SAMPLES.length} markets`;
  } finally {
    await store.dispose();
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

// The host owns zod; resolve it the same way the client suite resolves react.
function resolveZod() {
  const roots = [
    process.env.DSH_TRADING_ZOD_DIR,
    path.join(PLUGIN_ROOT, 'node_modules'),
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'node_modules') : null,
    process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'profiles')
      : null,
    path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'profiles', 'node_modules'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const candidates = [root];
    if (path.basename(root) === 'profiles') {
      for (const entry of fs.readdirSync(root)) candidates.push(path.join(root, entry, 'node_modules'));
    }
    for (const dir of candidates) {
      try {
        const require = createRequire(path.join(dir, 'noop.js'));
        return require.resolve('zod');
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const zodPath = resolveZod();
if (!zodPath) {
  suite.skip(
    'the domain-table schema accepts a row for every market',
    'zod (a host peer) is not resolvable; the values are still pinned by the checks above',
  );
} else {
  await suite.check('the domain-table schema accepts a row for every market', async () => {
    const { z } = await import(pathToFileURL(zodPath).href);
    const schema = itemSchema(z);
    for (const sample of SAMPLES) {
      const parsed = schema.parse(rowFor(sample));
      assert.equal(parsed.market, sample.market);
    }
    assert.throws(
      () => schema.parse({ ...rowFor(SAMPLES[0]), market: 'MARS' }),
      /market/i,
      'an unsupported market must not be storable',
    );
    return `zod validated ${SAMPLES.length} markets and rejected MARS`;
  });
}

process.exit(exitCodeFor(suite.finish()));
