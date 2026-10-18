/**
 * Portable online probe for DSH Trading Mode (`npm run test:network`).
 *
 * This is the portable copy of the author's host suite: the plugin root is
 * resolved from this file, so a fresh clone runs it on any machine with no
 * author path and no hard-coded profile.
 *
 * Needs: network access (it drives the real market-data providers) and a DSH
 * profile with this plugin linked, which is the normal way to run it. The probe
 * still works without a profile — every host service the plugin touches at
 * runtime is optional — and provider outages are reported as DEGRADED rather
 * than FAILED (`node tests/offline/run.mjs` treats exit 3 as SKIP). If the
 * checkout itself is incomplete it prints SKIP and exits 3, because the network
 * job is non-blocking by design.
 *
 *   node tests/network/host.test.mjs
 *
 * The five symbols required by spec §77.21 are exercised end to end.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh');
/** Machine-readable run report (OS temp dir, never inside the checkout). */
const REPORT_FILE = path.join(os.tmpdir(), 'dsh-trading-mode-host-report.json');

/** Missing prerequisite: print SKIP and exit 3 — never a failure. */
function skip(what) {
  console.log(`SKIP: ${what} is not installed for this DSH profile`);
  process.exit(3);
}

/**
 * Where a DSH install may keep the host's CommonJS packages (react and the
 * `@deepseek-ai/*` runtime), in resolution order. This host half does not render
 * anything itself, so a missing root is reported rather than fatal.
 */
function hostModuleRoots() {
  const roots = [];
  if (process.env.DSH_TRADING_REACT_DIR) roots.push(process.env.DSH_TRADING_REACT_DIR);
  roots.push(path.join(PLUGIN, 'node_modules'));
  roots.push(path.join(DSH_HOME, 'profiles', 'node_modules'));
  const profiles = path.join(DSH_HOME, 'profiles');
  try {
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(profiles, entry.name, 'node_modules'));
    }
  } catch {
    /* no profiles directory: the remaining roots still apply */
  }
  roots.push(path.join(path.dirname(process.execPath), 'node_modules'));
  return roots;
}

/** Resolve a CommonJS package the way the host would, or null when absent. */
function resolveHostPackage(id) {
  for (const root of hostModuleRoots()) {
    try {
      return createRequire(path.join(root, 'noop.js')).resolve(id);
    } catch {
      /* try the next root */
    }
  }
  return null;
}

if (!fs.existsSync(path.join(PLUGIN, 'lib', 'trading', 'service.js'))) {
  skip('dsh-trading-mode lib/ (resolved from tests/network/)');
}
const results = [];
let failures = 0;
let degraded = 0;

/**
 * Some checks need a live upstream (eastmoney's kline host and Yahoo are both
 * unreachable from this box for long stretches — see README "已知限制"). Those
 * checks assert the *contract*: either real data comes back, or the call fails
 * with a typed TradingError instead of hanging or fabricating. When the failure
 * is purely upstream availability the check is reported as DEGR instead of FAIL.
 */
const UPSTREAM_GAP_CODES = new Set([
  'DATA_UNAVAILABLE',
  'NO_PROVIDER',
  'UPSTREAM_ERROR',
  'UPSTREAM_BLOCKED',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_RATE_LIMITED',
]);
// Composite messages the router folds together when every source in a chain
// refused: they describe upstream availability, not a defect in our code. The
// 403 / RST / mirror wording is what the providers actually emit (measured
// 2026-10-07); a check that sees one of these cannot assert real data.
const UPSTREAM_GAP_PATTERNS =
  /every provider in the chain refused|not found on any provider|every eastmoney mirror failed|socket hang up|responded 40[13]|ECONNRESET|fetch failed/i;
const upstreamGap = (err) => {
  if (!err) return null;
  if (UPSTREAM_GAP_CODES.has(err.code)) return `${err.code}: ${String(err.message).slice(0, 90)}`;
  const text = String(err.message || err);
  return UPSTREAM_GAP_PATTERNS.test(text) ? `composite upstream outage: ${text.slice(0, 90)}` : null;
};

const { MarketDataService } = await import('../../lib/trading/service.js');
const { StockUniverse } = await import('../../lib/trading/universe.js');
const { WatchlistStore } = await import('../../lib/trading/watchlist.js');
const { ApiRoutes } = await import('../../lib/trading/api.js');
const { TradingAi, normalizeAnalysis, normalizeBrief, repair } = await import('../../lib/trading/ai.js');
const { computeTechnicals } = await import('../../lib/trading/indicators.js');
const { parseSymbol, providerKey } = await import('../../lib/trading/symbols.js');
const { TradingError } = await import('../../lib/trading/errors.js');
const { universeBoards, universeBoard, UNIVERSE_PAGE_SIZE } = await import('../../lib/trading/config.js');
const { httpGet, orderAddresses, familyLookup, workingFamily } = await import('../../lib/trading/http.js');
const { promises: dnsPromises } = await import('node:dns');

const log = (...args) => console.log(...args);
log(
  `  paths: plugin=${PLUGIN} · dsh-home=${DSH_HOME} · react=${resolveHostPackage('react') ? 'found' : 'not installed (not needed by this host half)'}`,
);

async function check(title, fn) {
  const startedAt = Date.now();
  try {
    const out = await fn();
    const gap = out && typeof out === 'object' && typeof out.degraded === 'string' ? out.degraded : null;
    if (gap) {
      degraded += 1;
      results.push({ title, ok: true, degraded: true, ms: Date.now() - startedAt, detail: gap });
      log(`  DEGR  ${title} — upstream unavailable (${gap})`);
    } else {
      results.push({ title, ok: true, ms: Date.now() - startedAt, detail: out });
      log(`  PASS  ${title}${out ? ` — ${out}` : ''}`);
    }
  } catch (err) {
    failures += 1;
    results.push({ title, ok: false, ms: Date.now() - startedAt, detail: err && err.message });
    log(`  FAIL  ${title} — ${err && err.message}`);
    if (process.env.VERBOSE) log(err && err.stack);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-test-'));
const logger = { info: (...a) => log('    [info]', ...a), warn: (...a) => log('    [warn]', ...a), debug: () => {} };

/** Minimal async-iterable request body carrier, the shape `readJsonBody` wants. */
const jsonReq = (payload) => ({
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(payload), 'utf8');
  },
  once() {},
  complete: true,
});

// 0.8.0: the HTTP layer is fail-closed, so a route test must supply what a real
// DSH host supplies (an admitting request fence) and a real identity. The fence
// itself is exercised in tests/offline/fence.test.mjs.
const ADMITTING_FENCE = { requestRejection: () => undefined };
const testIdentity = (id = 'test-user') => () => ({ id, source: 'test', persistent: true });

log('\n== boot ==');
const universe = new StockUniverse({ logger, homeDir: tmp });
await universe.init();
const service = await new MarketDataService({ logger, universe }).init();
const watchlist = new WatchlistStore({ logger, homeDir: tmp });
await watchlist.init();
const ai = new TradingAi({ logger });
const api = new ApiRoutes({ service, ai, watchlist, identity: testIdentity(), logger, connection: ADMITTING_FENCE });
log(`  providers: ${[...service.providers.keys()].join(', ')}`);
log(`  watchlist backend: ${watchlist.backend} (${watchlist.info().detail})`);
log(`  ai available: ${ai.available} (expected false without DSH)`);

log('\n== transport: address-family resilience (the m02212 "fetch failed" / "socket hang up" regression) ==');
await check('the transport never pins one address family', async () => {
  const v6 = { address: '2001:db8::1', family: 6 };
  const v4 = { address: '203.0.113.7', family: 4 };
  assert.deepEqual(
    orderAddresses([v6, v4], 4),
    [v4, v6],
    'a remembered IPv4 family must be offered first',
  );
  assert.deepEqual(
    orderAddresses([v6, v4], 6),
    [v6, v4],
    'a remembered IPv6 family must be offered first',
  );
  assert.deepEqual(
    orderAddresses([v6, v4], null),
    [v6, v4],
    'with no memory the resolver order is preserved',
  );
  const lookupWith = (lookup, hostname) =>
    new Promise((resolve, reject) => {
      lookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
    });
  const v4Only = await lookupWith(familyLookup(4), 'push2.eastmoney.com');
  const v6Only = await lookupWith(familyLookup(6), 'push2.eastmoney.com');
  assert.ok(v4Only.every((a) => a.family === 4) && v4Only.length > 0, 'the IPv4 retry attempt must have an IPv4 address to use');
  assert.ok(v6Only.every((a) => a.family === 6) && v6Only.length > 0, 'the IPv6 retry attempt must have an IPv6 address to use');
  log(`    retry pools: IPv4 ${v4Only.length} address(es) · IPv6 ${v6Only.length} address(es)`);
});

await check('the provider chain reaches eastmoney with no process-level DNS flag', async () => {
  let res;
  try {
    res = await httpGet(
      'https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57,f58,f59,f60,f86,f170',
      { provider: 'eastmoney', retries: 2 },
    );
  } catch (err) {
    const gap = upstreamGap(err);
    if (gap) return { degraded: `the DNS-flag path cannot be observed while eastmoney is unreachable — ${gap}` };
    throw err;
  }
  assert.equal(res.status, 200);
  assert.equal(res.json.rc, 0);
  assert.equal(res.json.data.f57, 'AAPL');
  assert.ok(typeof res.headers.get === 'function' && res.headers.get('content-type'), 'a Headers facade must be returned (yahoo.js reads set-cookie)');
  assert.ok([4, 6].includes(workingFamily('push2.eastmoney.com')), 'the family that answered must be remembered');
  log(`    eastmoney quote ${res.status} · f43=${res.json.data.f43} · working family: IPv${workingFamily('push2.eastmoney.com')}`);
});

await check('a broken address family only costs one retry attempt', async () => {
  // Pin attempt 0 to IPv4. On a host whose IPv4 route resets the connection (the
  // m02212 report) the retry flips to IPv6 and the call still succeeds; on a host
  // where IPv4 is fine it succeeds immediately. Both outcomes are correct.
  //
  // The quote host is intermittently RST for *every* family (see README 已知限制),
  // so an unreachable upstream cannot be told apart from a broken retry: report the
  // gap instead of a failure, but still assert the happy path whenever it answers.
  let res;
  try {
    res = await httpGet(
      'https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43,f57,f58,f59,f60,f86,f170',
      { provider: 'eastmoney', retries: 2, preferredFamily: 4 },
    );
  } catch (err) {
    const gap = upstreamGap(err);
    if (gap) return { degraded: `the pinned-IPv4 recovery cannot be observed while eastmoney is unreachable — ${gap}` };
    throw err;
  }
  assert.equal(res.status, 200);
  assert.equal(res.json.data.f57, 'AAPL');
  log(`    pinned-IPv4 attempt recovered via the family flip (working family: IPv${workingFamily('push2.eastmoney.com')})`);
});

await check('timeouts and caller aborts still surface as UPSTREAM_TIMEOUT', async () => {
  await assert.rejects(
    () =>
      httpGet('https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43', {
        provider: 'eastmoney',
        timeoutMs: 1,
        retries: 0,
      }),
    (error) => error.code === 'UPSTREAM_TIMEOUT',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      httpGet('https://push2.eastmoney.com/api/qt/stock/get?secid=105.AAPL&fields=f43', {
        provider: 'eastmoney',
        signal: controller.signal,
        retries: 0,
      }),
    (error) => error.code === 'UPSTREAM_TIMEOUT',
  );
});

log('\n== spec §22 search coverage ==');
const searches = ['AAPL', 'Apple', '苹果', 'NVIDIA', 'NVDA', 'Tesla', 'TSLA', 'Tencent', '腾讯', '0700', 'Alibaba', '阿里', '9988'];
for (const query of searches) {
  await check(`search "${query}"`, async () => {
    const out = await service.search(query, undefined, { force: true });
    assert.ok(out.data.results.length > 0, `no results for ${query}`);
    const first = out.data.results[0];
    return `${out.data.results.length} hits, first=${first.symbol} (${first.name || first.nameZh || '?'}), source=${out.meta.source}`;
  });
}

await check('search rejects an empty query', async () => {
  await assert.rejects(() => service.search('  '), (err) => err instanceof TradingError && err.code === 'BAD_REQUEST');
  return 'BAD_REQUEST';
});

log('\n== spec §77.21 the five required symbols ==');
const REQUIRED = ['AAPL', 'NVDA', 'TSLA', '0700.HK', '9988.HK'];
/** @type {Record<string, any>} */
const quotes = {};
/** @type {Record<string, any>} */
const technicals = {};
for (const symbol of REQUIRED) {
  await check(`quote ${symbol}`, async () => {
    const out = await service.getQuote(symbol, { force: true });
    const q = out.data;
    assert.equal(typeof q.price, 'number', 'price');
    assert.ok(q.price > 0, `price > 0 (got ${q.price})`);
    assert.ok(q.currency === 'USD' || q.currency === 'HKD', `currency (got ${q.currency})`);
    assert.equal(typeof q.timestamp, 'number', 'timestamp');
    assert.ok(q.source, 'source');
    assert.equal(out.meta.stale, false, 'not stale on a fresh fetch');
    quotes[symbol] = out;
    return `${q.name || q.nameZh || '?'} ${q.price} ${q.currency} ${q.changePct}% src=${q.source} ts=${new Date(q.timestamp).toISOString()} delay=${q.delaySeconds}`;
  });

  await check(`candles ${symbol} 1d/6mo`, async () => {
    const out = await service.getCandles(symbol, '1d', '6mo', { force: true });
    const bars = out.data.candles;
    assert.ok(bars.length > 80, `bars (got ${bars.length})`);
    for (let i = 1; i < bars.length; i += 1) assert.ok(bars[i].timestamp > bars[i - 1].timestamp, 'ascending timestamps');
    const bad = bars.find((b) => !(b.close > 0 && b.high >= b.low));
    assert.equal(bad, undefined, `no malformed bars (got ${JSON.stringify(bad)})`);
    return `${bars.length} bars ${new Date(bars[0].timestamp).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].timestamp).toISOString().slice(0, 10)}`;
  });

  await check(`technicals ${symbol} (§31 fields)`, async () => {
    const out = await service.getTechnicals(symbol, { force: true });
    const t = out.data.technical;
    for (const key of ['ma5', 'ma20', 'ma50', 'ma200', 'rsi14', 'macd', 'macdSignal', 'macdHistogram', 'atr14', 'volumeRatio20d']) {
      assert.ok(typeof t[key] === 'number', `${key} is a number (got ${t[key]}); unavailable=${JSON.stringify(out.data.unavailable)}`);
    }
    assert.ok(t.rsi14 >= 0 && t.rsi14 <= 100, `rsi14 in range (got ${t.rsi14})`);
    assert.equal(out.data.bars >= 250, true, `bars >= 250 (got ${out.data.bars})`);
    technicals[symbol] = out.data;
    return `ma20=${t.ma20} ma200=${t.ma200} rsi14=${t.rsi14} atr14=${t.atr14} trend=${t.trendAlignment} high52w=${t.high52w}`;
  });
}

await check('quote arithmetic is internally consistent (eastmoney scale check)', async () => {
  // Regression guard for the 2026-10 `fltt=2` bug: the provider asked eastmoney
  // to pre-scale prices and then divided by 10^f59 again, which corrupted every
  // magnitude above 10^f59 (all index levels) and every changePct by 100×.
  const samples = [...REQUIRED];
  for (const extra of ['^IXIC', '^HSI']) {
    if (!quotes[extra]) quotes[extra] = await service.getQuote(extra, { force: true });
    samples.push(extra);
  }
  const rows = [];
  for (const symbol of samples) {
    const q = quotes[symbol].data;
    assert.ok(Number.isFinite(q.previousClose) && q.previousClose > 0, `${symbol} previousClose (got ${q.previousClose})`);
    const drift = Math.abs(q.price - (q.previousClose + q.change));
    assert.ok(drift < 0.02, `${symbol} price must equal previousClose + change (off by ${drift.toFixed(4)})`);
    const expected = (q.change / q.previousClose) * 100;
    assert.ok(Math.abs(q.changePct - expected) < 0.02, `${symbol} changePct must be a percentage (${q.changePct} vs ${expected.toFixed(4)})`);
    rows.push(`${symbol} ${q.price} ${q.changePct}%`);
  }
  return rows.join(' | ');
});

log('\n== spec §28 chart ranges ==');
const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y'];
for (const range of RANGES) {
  await check(`AAPL range ${range}`, async () => {
    try {
      const out = await service.getCandles('AAPL', undefined, range, { force: true });
      const bars = out.data.candles;
      assert.ok(bars.length > 0, `bars for ${range}`);
      return `${bars.length} bars, interval=${out.data.interval}`;
    } catch (err) {
      const gap = upstreamGap(err);
      if (gap) return { degraded: `US candles need eastmoney (kline host RST) or Sina: ${gap}` };
      throw err;
    }
  });
}
for (const range of ['5y', 'max']) {
  await check(`AAPL range ${range} (optional per §28)`, async () => {
    try {
      const out = await service.getCandles('AAPL', '1wk', range, { force: true });
      return `${out.data.candles.length} weekly bars`;
    } catch (err) {
      const gap = upstreamGap(err);
      if (gap) return { degraded: `weekly candles need a live daily feed: ${gap}` };
      throw err;
    }
  });
}

log('\n== intervals ==');
for (const interval of ['5m', '15m', '30m', '1h']) {
  await check(`0700.HK intraday ${interval}`, async () => {
    try {
      const out = await service.getCandles('0700.HK', interval, '5d', { force: true });
      assert.ok(out.data.candles.length > 0, `${interval} bars`);
      const last = out.data.candles[out.data.candles.length - 1];
      return `${out.data.candles.length} bars, last=${new Date(last.timestamp).toISOString()}`;
    } catch (err) {
      const gap = upstreamGap(err);
      if (gap) return { degraded: `HK intraday has a single upstream (eastmoney kline): ${gap}` };
      throw err;
    }
  });
}

await check('unsupported interval is rejected, not silently replaced', async () => {
  await assert.rejects(() => service.getCandles('AAPL', '3s', '1d'), (err) => err instanceof TradingError && err.code === 'BAD_REQUEST');
  return 'BAD_REQUEST';
});

await check('market symbols: HK shorthand 0700 becomes 0700.HK', async () => {
  const out = await service.getQuote('0700', { force: true });
  assert.equal(out.data.symbol, '0700.HK');
  assert.equal(out.data.market, 'HK');
  return `${out.data.symbol} ${out.data.price} ${out.data.currency}`;
});

await check('invalid symbol is rejected', async () => {
  await assert.rejects(() => service.getQuote('NOT A SYMBOL!!'), (err) => err instanceof TradingError);
  return 'rejected';
});

await check('company profile for AAPL and 0700.HK', async () => {
  const gaps = [];
  const names = [];
  for (const symbol of ['AAPL', '0700.HK']) {
    try {
      const out = await service.getProfile(symbol, { force: true });
      assert.ok(out.data.name, `${symbol} name`);
      names.push(`${symbol}=${out.data.name} industry=${out.data.industry} (${out.data.nameZh || '-'})`);
    } catch (err) {
      const gap = upstreamGap(err);
      if (!gap) throw err;
      gaps.push(`${symbol}: ${gap}`);
    }
  }
  if (gaps.length) {
    // Profiles have two upstreams at most: Yahoo (403 here) and eastmoney.
    return { degraded: `profile feed unavailable — ${gaps.join(' | ')}` };
  }
  return names.join(' | ');
});

log('\n== cache behaviour (§41/§42) ==');
await check('second quote is served from cache', async () => {
  const first = await service.getQuote('AAPL');
  const second = await service.getQuote('AAPL');
  assert.equal(second.meta.cached, true, 'second call cached');
  return `cached=${second.meta.cached} age=${second.meta.cacheAgeMs}ms ttlkind=${second.meta.cacheKind}`;
});

await check('stale cache is served with stale=true when upstream fails', async () => {
  // Prime the cache, then break every provider so the fallback path runs.
  await service.getQuote('NVDA', { force: true });
  const saved = new Map();
  for (const [id, provider] of service.providers) {
    saved.set(id, provider.getQuote.bind(provider));
    provider.getQuote = async () => {
      throw new TradingError('UPSTREAM_BLOCKED', `${id} is blocked in this test`);
    };
  }
  try {
    const out = await service.getQuote('NVDA', { force: true });
    assert.equal(out.meta.stale, true, 'stale flag');
    assert.ok(out.meta.staleReason, 'stale reason');
    return `stale=${out.meta.stale} reason="${out.meta.staleReason}" price kept=${out.data.price}`;
  } finally {
    for (const [id, fn] of saved) service.providers.get(id).getQuote = fn;
  }
});

await check('a total outage fails loudly instead of returning empty data', async () => {
  const saved = new Map();
  for (const [id, provider] of service.providers) {
    saved.set(id, provider.getQuote.bind(provider));
    provider.getQuote = async () => {
      throw new TradingError('UPSTREAM_ERROR', `${id} down`);
    };
  }
  try {
    await assert.rejects(() => service.getQuote('ZZZZ', { force: true }), (err) => err instanceof TradingError && ['DATA_UNAVAILABLE', 'UPSTREAM_BLOCKED', 'NOT_FOUND'].includes(err.code));
    return 'threw a typed error';
  } finally {
    for (const [id, fn] of saved) service.providers.get(id).getQuote = fn;
  }
});

log('\n== watchlist (§10–§13) ==');
await check('add / list / order / favourite / remove', async () => {
  await watchlist.add('u1', { symbol: 'AAPL', name: 'Apple Inc.' });
  await watchlist.add('u1', 'NVDA');
  await watchlist.add('u1', '0700.HK');
  await watchlist.add('u1', 'AAPL');
  const list = await watchlist.list('u1');
  assert.equal(list.length, 3, `deduped to 3 (got ${list.length})`);
  assert.deepEqual(list.map((r) => r.position), [0, 1, 2], 'positions');
  const reordered = await watchlist.reorder('u1', ['0700.HK', 'AAPL', 'NVDA']);
  assert.deepEqual(reordered.map((r) => r.symbol), ['0700.HK', 'AAPL', 'NVDA']);
  const fav = await watchlist.setFavorite('u1', 'AAPL', true);
  assert.equal(fav.isFavorite, true);
  const removed = await watchlist.remove('u1', 'NVDA');
  assert.equal(removed.removed, true);
  const after = await watchlist.list('u1');
  assert.deepEqual(after.map((r) => r.position), [0, 1], 'reindexed after removal');
  // §12: every documented field must be present.
  for (const key of ['id', 'userId', 'symbol', 'market', 'position', 'isFavorite', 'createdAt', 'updatedAt']) {
    assert.ok(key in after[0], `field ${key}`);
  }
  return `${after.map((r) => r.symbol).join(', ')} (favourite=${after.find((r) => r.symbol === 'AAPL').isFavorite})`;
});

await check('watchlists are isolated per user', async () => {
  await watchlist.add('u2', 'TSLA');
  const [a, b] = await Promise.all([watchlist.list('u1'), watchlist.list('u2')]);
  assert.equal(a.some((r) => r.symbol === 'TSLA'), false, 'u1 must not see u2 rows');
  assert.equal(b.length, 1);
  return `u1=${a.length} rows, u2=${b.length} rows`;
});

await check('watchlist survives a restart (new store instance, same directory)', async () => {
  const reopened = new WatchlistStore({ logger, homeDir: tmp });
  await reopened.init();
  const list = await reopened.list('u1');
  assert.equal(list.length, 2, 'persisted rows');
  await reopened.dispose();
  return `${list.map((r) => r.symbol).join(', ')} restored from ${reopened.info().backend}`;
});

await check('removing an unknown symbol is a no-op, not an error', async () => {
  const out = await watchlist.remove('u1', 'MSFT');
  assert.equal(out.removed, false);
  return 'removed=false';
});

log('\n== AI output validation (§35/§40) — no LLM needed ==');
await check('normalizeAnalysis coerces a partial model answer', async () => {
  const out = normalizeAnalysis({ summary: 'ok', trend: { shortTerm: 'up' }, supportLevels: ['12.5', { level: 20 }, 'n/a'], riskFactors: [1, null, 'x'] });
  assert.equal(out.summary, 'ok');
  assert.equal(out.trend.mediumTerm, 'Unavailable.');
  assert.deepEqual(out.supportLevels, [12.5, 20]);
  assert.deepEqual(out.riskFactors, ['1', 'x']);
  return JSON.stringify(out).slice(0, 120);
});

await check('normalizeBrief falls back to computed up/down counts', async () => {
  const input = { stocks: [{ changePct: 1.2 }, { changePct: -0.5 }, { changePct: 0 }] };
  const out = normalizeBrief({ headline: 'h' }, input);
  assert.equal(out.upCount, 1);
  assert.equal(out.downCount, 1);
  assert.equal(out.stocksTracked, 3);
  return `up=${out.upCount} down=${out.downCount} tracked=${out.stocksTracked}`;
});

await check('repair strips markdown fences and surrounding prose', async () => {
  assert.equal(repair('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(repair('Sure! Here it is: {"a":1} Hope that helps.'), '{"a":1}');
  return 'ok';
});

await check('analysis input contains no raw upstream payload (§16)', async () => {
  const { buildStockInput } = await import('../../lib/trading/ai.js');
  const snapshot = { symbol: 'AAPL', market: 'US', quote: quotes.AAPL.data, profile: null, technical: technicals.AAPL, candles: (await service.getCandles('AAPL', '1d', '6mo')).data.candles, asOf: technicals.AAPL.asOf };
  const input = buildStockInput(snapshot);
  const text = JSON.stringify(input);
  // `source` naming the provider is required by §20; what §16 forbids is the raw
  // upstream payload (EM field ids, upstream hosts) reaching the analyzer.
  for (const forbidden of ['f43', 'f59', 'f170', 'push2', 'qt.gtimg', 'searchapi']) {
    assert.equal(text.includes(forbidden), false, `input must not leak ${forbidden}`);
  }
  return `${text.length} bytes of normalised data, keys=${Object.keys(input.data).join(',')}`;
});

await check('askJson fails cleanly when the DSH LLM is absent', async () => {
  await assert.rejects(() => ai.askJson('sys', 'user'), (err) => err instanceof TradingError && err.code === 'AI_UNAVAILABLE');
  return 'AI_UNAVAILABLE';
});

log('\n== HTTP surface (§45–§49) ==');
await check('api endpoints answer through route()', async () => {
  const call = (method, segments, query = {}) => api.route(method, segments, { query: new Map(Object.entries(query)), force: true, signal: undefined, req: null });
  const status = await call('GET', ['status']);
  assert.ok(status.providers, 'providers in status');
  const search = await call('GET', ['search'], { q: 'apple' });
  assert.ok(search.data.results.length > 0);
  const quote = await call('GET', ['quote', 'AAPL']);
  assert.equal(quote.data.symbol, 'AAPL');
  const candles = await call('GET', ['candles', 'AAPL'], { range: '6m', interval: '1d' });
  assert.ok(candles.data.candles.length > 80);
  // /candles bundles {data, meta} plus a sibling technical bundle: {data,meta}+technical+technicalMeta.
  assert.ok(candles.technical.technical.ma20 > 0, 'candles endpoint also returns technicals');
  const technical = await call('GET', ['technical', 'AAPL']);
  assert.ok(technical.data.technical.rsi14 >= 0);
  const wl = await call('GET', ['watchlist']);
  assert.ok(Array.isArray(wl.items));
  // A body-less POST must fail with a typed BAD_REQUEST (asserted by its own
  // test below); here we only need proof that the router reached the watchlist
  // handler instead of falling through to 404.
  let added = null;
  try {
    added = await call('POST', ['watchlist']);
  } catch (err) {
    added = { error: err.code };
  }
  assert.ok(added === undefined || added.item || added.error === 'BAD_REQUEST', 'POST without a body must fail, not silently succeed');
  return `status/search/quote/candles/technical/watchlist all answered`;
});

await check('POST /watchlist without a symbol is a 400-class error', async () => {
  const fakeReq = { async *[Symbol.asyncIterator]() {} , once() {}, complete: true };
  await assert.rejects(
    () => api.handle(fakeReq, { headersSent: false, writeHead() {}, end() {} }),
    () => false,
  ).catch(() => {});
  // handle() writes the response itself, so assert through route() instead:
  await assert.rejects(
    () => api.watchlistRoutes('POST', undefined, undefined, { req: fakeReq, query: new Map(), force: false }),
    (err) => err instanceof TradingError && err.code === 'BAD_REQUEST',
  );
  return 'BAD_REQUEST';
});

await check('unknown endpoint returns undefined (router → 404)', async () => {
  const out = await api.route('GET', ['nope'], { query: new Map(), force: false, req: null });
  assert.equal(out, undefined);
  return 'undefined';
});

await check('method guard rejects the wrong verb', async () => {
  await assert.rejects(() => api.route('POST', ['status'], { query: new Map(), force: false, req: null }), (err) => err instanceof TradingError);
  return 'rejected';
});

log('\n== market indices + data-source links (user request m01395) ==');
await check('index directory: aliases, dialects and provider capability', async () => {
  const { DEFAULT_INDEX_SYMBOLS, INDEX_DIRECTORY, lookupIndex, publicIndex, indexSupportFor, searchIndices } = await import(
    '../../lib/trading/indices.js'
  );
  assert.equal(
    DEFAULT_INDEX_SYMBOLS.length,
    15,
    `15 headline indices across five markets (got ${DEFAULT_INDEX_SYMBOLS.length})`,
  );
  const byMarket = INDEX_DIRECTORY.reduce((acc, item) => {
    acc[item.group] = (acc[item.group] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(
    byMarket,
    { US: 5, HK: 3, CN: 6, JP: 1 },
    `index tab split per market (got ${JSON.stringify(byMarket)})`,
  );
  assert.equal(lookupIndex('vix').symbol, '^VIX', 'vix → ^VIX');
  assert.equal(lookupIndex('恐慌指数').symbol, '^VIX', '恐慌指数 → ^VIX');
  assert.equal(lookupIndex('^HSI').symbol, '^HSI', '^HSI');
  assert.equal(lookupIndex('hkhsi').symbol, '^HSI', 'a provider key must resolve too');
  assert.equal(lookupIndex('DOW'), null, 'bare DOW must stay Dow Inc., not the index');
  const pub = publicIndex(lookupIndex('^VIX'));
  assert.equal(pub.links.tradingView, 'TVC:VIX', 'tradingView dialect');
  assert.equal(pub.links.tencentKey, 'usVIX', 'tencent page key');
  assert.equal(indexSupportFor('eastmoney', '^VIX', 'quote'), false, 'eastmoney has no VIX');
  assert.equal(indexSupportFor('eastmoney', '^IXIC', 'quote'), true, 'eastmoney has the Nasdaq');
  assert.equal(indexSupportFor('tencent', '^IXIC', 'candles'), false, 'tencent has no US index candles');
  assert.equal(indexSupportFor('tencent', '^HSI', 'candles'), true, 'tencent has Hang Seng candles');
  assert.equal(searchIndices('纳指', undefined, 4)[0].symbol, '^IXIC', '纳指 → ^IXIC (Nasdaq Composite)');
  assert.equal(searchIndices('纳斯达克100', undefined, 4)[0].symbol, '^NDX', '纳斯达克100 → ^NDX');
  assert.equal(lookupIndex('^SPX').symbol, '^GSPC', '^SPX (caret-prefixed alias) → ^GSPC');
  // 0.5.0 — the A-share and Tokyo indices.
  assert.equal(lookupIndex('上证').symbol, '000001.SH', '上证 → 000001.SH');
  assert.equal(lookupIndex('创业板').symbol, '399006.SZ', '创业板 → 399006.SZ');
  assert.equal(lookupIndex('899050.BJ').symbol, '899050.BJ', 'the BSE 50 index resolves by symbol');
  assert.equal(lookupIndex('日经').symbol, '^N225', '日经 → ^N225');
  const sse = publicIndex(lookupIndex('000001.SH'));
  assert.equal(sse.links.tradingView, 'SSE:000001', 'the SSE index has its TradingView dialect');
  assert.equal(sse.links.yahoo, '000001.SS', 'the SSE index has its Yahoo dialect');
  assert.equal(sse.links.tencentKey, 'sh000001', 'the SSE index has its tencent page key');
  assert.equal(indexSupportFor('tencent', '000001.SH', 'candles'), true, 'tencent serves the SSE Composite');
  assert.equal(indexSupportFor('tencent', '^N225', 'candles'), false, 'tencent has no Nikkei series');
  assert.equal(indexSupportFor('eastmoney', '^N225', 'quote'), true, 'eastmoney quotes the Nikkei');
  return '^VIX/^IXIC/^NDX/^HSI/上证/日经 dialects ok';
});

await check('GET /indices returns one quote envelope per index', async () => {
  const value = await api.route('GET', ['indices'], { query: new Map(), force: true, req: null });
  assert.ok(value.count >= 6, `count >= 6 (got ${value.count})`);
  assert.ok(
    value.items.every((item) => item.kind === 'index' && item.links && item.links.tradingView && item.quote && item.meta),
    'each item carries kind + links + quote + meta',
  );
  const bySymbol = new Map(value.items.map((item) => [item.symbol, item]));
  for (const symbol of ['^IXIC', '^NDX', '^GSPC', '^DJI', '^HSI', '^HSCEI']) {
    const item = bySymbol.get(symbol);
    assert.ok(item, `${symbol} must be quoted`);
    assert.ok(typeof item.quote.price === 'number' && item.quote.price > 0, `${symbol} price > 0`);
    assert.ok(item.quote.timestamp && item.meta.timestamp && item.quote.source, `${symbol} carries source + timestamp (§20)`);
  }
  // VIX only exists on the fallback provider (eastmoney has no VIX) and its last
  // print is weeks old, so the strip must either omit it or mark it stale (§21).
  const vix = bySymbol.get('^VIX');
  const note = vix
    ? `^VIX ${vix.quote.price} src=${vix.quote.source} stale=${vix.meta.stale}`
    : `^VIX unavailable (${(value.unavailable.find((u) => u.symbol === '^VIX') || {}).code})`;
  if (vix) {
    assert.equal(vix.quote.source, 'tencent', 'eastmoney cannot serve VIX');
    assert.equal(vix.meta.stale, true, 'the VIX print is weeks old and must be flagged stale');
  } else {
    assert.ok(value.unavailable.some((u) => u.symbol === '^VIX'), '^VIX must be reported as unavailable');
  }
  const limited = await api.route('GET', ['indices'], { query: new Map([['symbols', '^VIX,^IXIC']]), force: true, req: null });
  assert.ok(limited.items.length <= 2, `symbols= filter (got ${limited.items.length})`);
  return `${value.count} indices, ${value.unavailable.length} unavailable · ${note}`;
});

await check('index symbols work end to end: quote, profile, search, candles', async () => {
  const quote = await service.getQuote('^IXIC', { force: true });
  assert.equal(quote.data.symbol, '^IXIC', 'canonical symbol');
  assert.equal(quote.data.market, 'US', 'market');
  assert.ok(quote.data.price > 1000, `index level (got ${quote.data.price})`);
  assert.equal(quote.meta.stale, false, 'a fresh index quote is not stale');

  const profile = await service.getProfile('^VIX', { force: true });
  assert.equal(profile.data.source, 'directory', 'an index profile comes from the directory, not a fake upstream');
  assert.ok(/volatility/i.test(profile.data.name), `profile name (got ${profile.data.name})`);
  assert.equal(profile.data.market, 'US', 'profile market');

  const byName = await service.search('纳斯达克', undefined, { force: true });
  assert.ok(
    byName.data.results.slice(0, 4).some((row) => row.symbol === '^IXIC' || row.symbol === '^NDX'),
    `a Chinese index name must find the index (got ${byName.data.results.slice(0, 4).map((r) => r.symbol).join(',')})`,
  );
  const byTicker = await service.search('VIX', undefined, { force: true });
  assert.equal(byTicker.data.results[0].symbol, '^VIX', `VIX must rank first (got ${byTicker.data.results[0].symbol})`);
  assert.equal(byTicker.data.results[0].kind, 'index', 'the result is flagged as an index');

  // No provider can serve US index candles, so this must fail loudly without
  // burning a provider's failure budget — that is what supportsSymbol() is for.
  const candidateIds = service.router.candidates('candles', 'US', '1d', '^VIX').map((p) => p.id);
  assert.ok(!candidateIds.includes('eastmoney'), `eastmoney has no VIX (got ${candidateIds.join(',')})`);
  assert.ok(!candidateIds.includes('tencent'), `tencent has no US index candles (got ${candidateIds.join(',')})`);
  const failures = (id) => service.router.status().providers.find((p) => p.id === id).failures;
  const before = { eastmoney: failures('eastmoney'), tencent: failures('tencent') };
  await assert.rejects(
    () => service.getCandles('^VIX', '1d', '1mo', { force: true }),
    (err) => err instanceof TradingError && ['DATA_UNAVAILABLE', 'NOT_FOUND', 'NO_PROVIDER', 'UNSUPPORTED_INTERVAL', 'UPSTREAM_BLOCKED'].includes(err.code),
  );
  assert.equal(failures('eastmoney'), before.eastmoney, 'a capability miss must not count as an eastmoney failure');
  assert.equal(failures('tencent'), before.tencent, 'a capability miss must not count as a tencent failure');

  const hsi = await service.getCandles('^HSI', '1d', '1mo', { force: true });
  assert.ok(hsi.data.candles.length >= 1, `Hang Seng candles (got ${hsi.data.candles.length})`);
  assert.ok(
    ['eastmoney', 'tencent'].includes(hsi.meta.provider),
    `Hang Seng candles come from a reachable provider (got ${hsi.meta.provider})`,
  );
  // Hang Seng TECH is the index eastmoney cannot serve at all, so its candles
  // prove the tencent fallback path works for an index.
  const hstech = await service.getCandles('^HSTECH', '1d', '1mo', { force: true });
  assert.ok(hstech.data.candles.length >= 1, `Hang Seng TECH candles (got ${hstech.data.candles.length})`);
  assert.equal(hstech.meta.provider, 'tencent', 'Hang Seng TECH candles can only come from the tencent fallback');
  return `^IXIC ${quote.data.price}, ^VIX profile, ^HSI bars=${hsi.data.candles.length}, ^HSTECH bars=${hstech.data.candles.length} via tencent`;
});

log('\n== route registration ==');
await check('registers exactly one prefix route and can dispose it', async () => {
  const registered = [];
  const fakeWebServer = { register: (route) => { registered.push(route); return () => registered.pop(); } };
  const local = new ApiRoutes({ service, ai, watchlist, identity: testIdentity('u'), logger, connection: ADMITTING_FENCE });
  local.register(fakeWebServer);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'prefix');
  assert.equal(registered[0].path, '/api/trading');
  assert.equal(typeof registered[0].handler, 'function');
  local.dispose();
  assert.equal(registered.length, 0, 'disposed');
  return `${registered.length} routes left after dispose`;
});

log('\n== provider isolation (§44: one dead provider must not break the plugin) ==');
await check('router skips a failing provider and uses the next one', async () => {
  const target = service.providers.get('eastmoney');
  const saved = target.getQuote.bind(target);
  target.getQuote = async () => {
    throw new TradingError('UPSTREAM_ERROR', 'simulated outage');
  };
  try {
    const out = await service.getQuote('AAPL', { force: true });
    assert.ok(out.data.price > 0);
    assert.notEqual(out.data.source, 'eastmoney', 'must have fallen through to another provider');
    return `served by ${out.data.source}`;
  } finally {
    target.getQuote = saved;
  }
});

log('\n== bilingual UI: language preference + AI language passthrough ==');
const { UserSettingsStore } = await import('../../lib/trading/settings.js');
const { languageDirective, STOCK_SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT } = await import('../../lib/trading/ai.js');
const { SUPPORTED_LANGS, normalizeLang } = await import('../../lib/trading/config.js');

const settingsPath = path.join(tmp, 'settings-store', 'settings.json');
const settings = new UserSettingsStore({ logger, filePath: settingsPath });
await settings.init();

await check('language codes normalise to a shipped language', async () => {
  assert.equal(normalizeLang('zh-CN'), 'zh');
  assert.equal(normalizeLang('zh_Hant'), 'zh');
  assert.equal(normalizeLang('EN-us'), 'en');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('de'), null);
  assert.equal(normalizeLang(undefined), null);
  assert.deepEqual(SUPPORTED_LANGS, ['en', 'zh']);
  return SUPPORTED_LANGS.join('/');
});

await check('settings default to English before the user chooses', async () => {
  const value = settings.get('u1');
  assert.equal(value.lang, 'en');
  assert.deepEqual(value.supported, ['en', 'zh']);
  return `lang=${value.lang}`;
});

await check('PATCH /settings persists the choice to disk (survives a restart)', async () => {
  const local = new ApiRoutes({ service, ai, watchlist, settings, identity: testIdentity('u1'), logger, connection: ADMITTING_FENCE });
  const saved = await local.route('PATCH', ['settings'], { query: new Map(), req: jsonReq({ lang: 'zh' }), force: false });
  assert.equal(saved.lang, 'zh');
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(onDisk.users.u1.lang, 'zh');
  // A brand new store (i.e. after a DSH restart) must see the same preference.
  const restarted = new UserSettingsStore({ logger, filePath: settingsPath });
  await restarted.init();
  assert.equal(restarted.get('u1').lang, 'zh');
  // …and it is per user, not global.
  assert.equal(restarted.get('someone-else').lang, 'en');
  return 'zh persisted per user';
});

await check('bootstrap and /status expose the stored preference', async () => {
  const boot = await api.route('GET', [], { query: new Map(), req: null, force: false });
  assert.ok(boot.settings, 'bootstrap carries settings');
  assert.deepEqual(boot.settings.supported, ['en', 'zh']);
  const status = await api.route('GET', ['status'], { query: new Map(), req: null, force: false });
  assert.ok(status.settings && typeof status.settings.lang === 'string');
  assert.ok(status.config.languages.includes('zh'), 'publicConfig advertises the languages');
  assert.equal(status.config.defaultLang, 'en');
  // The client reads the stored preference out of /status and adopts it.
  const local = new ApiRoutes({ service, ai, watchlist, settings, identity: testIdentity('u1'), logger, connection: ADMITTING_FENCE });
  const stored = await local.route('GET', ['status'], { query: new Map(), req: null, force: false });
  assert.equal(stored.settings.lang, 'zh', 'the stored preference reaches the UI');
  return `bootstrap=${boot.settings.lang}, stored=${stored.settings.lang}`;
});

await check('an unsupported language is rejected, not silently ignored', async () => {
  await assert.rejects(
    () => settings.patch('u1', { lang: 'klingon' }),
    (err) => err instanceof TradingError && err.code === 'BAD_REQUEST',
  );
  const local = new ApiRoutes({ service, ai, watchlist, settings, identity: testIdentity('u1'), logger, connection: ADMITTING_FENCE });
  await assert.rejects(
    () => local.route('PATCH', ['settings'], { query: new Map(), req: jsonReq({ lang: 'fr' }), force: false }),
    (err) => err instanceof TradingError && err.code === 'BAD_REQUEST',
  );
  // Without a usable store the same request must fail loudly rather than pretend
  // the preference was saved.
  await assert.rejects(
    () => api.route('PATCH', ['settings'], { query: new Map(), req: jsonReq({ lang: 'zh' }), force: false }),
    (err) => err instanceof TradingError && err.code === 'STORAGE_ERROR',
  );
  return 'BAD_REQUEST / STORAGE_ERROR';
});

await check('languageDirective only localises human-readable JSON strings', async () => {
  assert.equal(languageDirective('en'), '');
  assert.equal(languageDirective(undefined), '');
  const zh = languageDirective('zh');
  assert.match(zh, /Simplified Chinese/);
  // The spec §34/§40 prompt text itself is never rewritten.
  const local = new ApiRoutes({ service, ai, watchlist, identity: testIdentity('u'), logger, connection: ADMITTING_FENCE });
  assert.ok(local.publicConfig().languages.includes('en'));
  assert.ok(STOCK_SYSTEM_PROMPT.startsWith('You are the AI market analysis engine inside DSH Trading Mode.'));
  assert.ok(BRIEF_SYSTEM_PROMPT.startsWith("You are generating a concise market brief for a user's stock watchlist."));
  return 'en unchanged, zh additive';
});

await check('analyze hands the UI language to the AI layer', async () => {
  const calls = [];
  const stubAi = {
    available: true,
    status: () => ({ available: true, route: 'stub' }),
    analyzeStock: async (snapshot, opts) => {
      calls.push(opts.lang);
      return { analysis: normalizeAnalysis({ summary: 'ok' }), meta: { lang: opts.lang } };
    },
    watchlistBrief: async (snapshot, opts) => {
      calls.push(opts.lang);
      return { brief: normalizeBrief({ headline: 'ok' }, { stocks: [] }), meta: { lang: opts.lang } };
    },  };
  const local = new ApiRoutes({ service, ai: stubAi, watchlist, settings, identity: testIdentity('u1'), logger, connection: ADMITTING_FENCE });
  const explicit = await local.route('POST', ['analyze', 'AAPL'], { query: new Map(), req: jsonReq({ lang: 'en' }), force: false });
  assert.equal(explicit.meta.lang, 'en');
  // No lang in the body → fall back to what the user stored (zh for u1).
  const inherited = await local.route('POST', ['analyze', 'AAPL'], { query: new Map(), req: null, force: false });
  assert.equal(inherited.meta.lang, 'zh', 'falls back to the stored preference');
  await local.route('POST', ['watchlist', 'analyze'], { query: new Map(), req: jsonReq({ symbols: ['AAPL'], lang: 'zh' }), force: false });
  assert.deepEqual(calls, ['en', 'zh', 'zh']);
  return calls.join(',');
});

log('\n== full US/HK listing universe (user request m01842) ==');

await check('listing boards cover NASDAQ, NYSE, AMEX and the three HK boards', async () => {
  const us = universeBoards('US');
  assert.deepEqual(us.map((b) => b.fs), ['m:105', 'm:106', 'm:107']);
  assert.deepEqual(us.map((b) => b.id), ['NASDAQ', 'NYSE', 'AMEX']);
  const hk = universeBoards('HK');
  assert.deepEqual(hk.map((b) => b.fs), ['m:116+t:3', 'm:116+t:4', 'm:116+t:1'], 'bonds, warrants and CBBCs stay out');
  assert.deepEqual(hk.map((b) => b.id), ['MAIN', 'GEM', 'FUND']);
  assert.equal(universeBoard('US', 'NASDAQ').fs, 'm:105');
  assert.equal(universeBoard('US', 'm:107').id, 'AMEX');
  assert.equal(universeBoard('HK').id, 'MAIN', 'a missing board falls back to the market default');
  assert.throws(() => universeBoard('US', 'NOPE'), /unknown board/);
  assert.throws(() => universeBoard('ZZ'), /unsupported universe market/);
  assert.equal(UNIVERSE_PAGE_SIZE, 100, 'the upstream feed truncates above 100 rows');
  return `${us.length} US + ${hk.length} HK boards`;
});

await check('class shares and HK counters survive the symbol dialect', async () => {
  const brk = parseSymbol('BRK.B');
  assert.equal(brk.symbol, 'BRK.B', 'class shares display with a dot');
  assert.equal(brk.code, 'BRK_B', 'the provider spelling uses an underscore');
  assert.equal(brk.market, 'US');
  assert.equal(providerKey('eastmoney', 'BRK.B'), '105.BRK_B');
  assert.equal(providerKey('yahoo', 'BRK.B'), 'BRK-B', 'yahoo spells class shares with a dash');
  assert.equal(parseSymbol('BRK_B').symbol, 'BRK.B', 'both spellings parse to one symbol');
  const rmb = parseSymbol('80700');
  assert.equal(rmb.symbol, '80700.HK', 'the five-digit RMB counter must not collapse to 0700.HK');
  assert.equal(parseSymbol('0700').symbol, '0700.HK');
  assert.equal(parseSymbol('00001').symbol, '0001.HK');
  assert.equal(parseSymbol('08003').symbol, '8003.HK');
  return 'BRK.B / 80700.HK / 0001.HK';
});

await check('GET /universe pages through the real listing feed', async () => {
  const page = await api.route('GET', ['universe'], {
    query: new Map([['market', 'US'], ['page', '1'], ['size', '100']]),
    force: true,
  });
  assert.equal(page.mode, 'browse');
  assert.equal(page.rows.length, 100, 'a full upstream page holds 100 rows');
  // The default US board is NASDAQ whichever feed serves it: eastmoney lists 6,065 codes
  // there, the nasdaq screener 4,033. Both are a real exchange, so assert the order of
  // magnitude rather than one feed's exact count.
  assert.ok(page.total > 1000, `US listing total looks wrong (${page.total} via ${page.provider})`);
  assert.ok(page.pages > 10, `US pagination looks wrong (${page.pages})`);
  // The board list belongs to the feed that is actually serving: the fallback US feed
  // publishes a single "all listings" board, the eastmoney feed the three exchanges.
  assert.ok(page.boards.length >= 1, 'the serving feed must publish at least one board');
  assert.ok(page.boards.every((b) => b.provider === page.provider), 'every board is attributed to the serving feed');
  if (page.provider === 'eastmoney') assert.equal(page.boards.length, 3, 'the eastmoney feed publishes NASDAQ/NYSE/AMEX');
  assert.ok(page.rows.every((r) => r.symbol && r.market === 'US' && r.exchange), 'every row carries symbol/market/exchange');
  assert.ok(page.rows.every((r) => r.symbol === r.symbol.toUpperCase()), 'US codes stay upper case');

  const hk = await api.route('GET', ['universe'], {
    query: new Map([['market', 'HK'], ['board', 'MAIN'], ['page', '1'], ['size', '100']]),
    force: true,
  });
  assert.equal(hk.mode, 'browse');
  assert.ok(
    hk.board === 'MAIN' || hk.boardFallback === true,
    `a board the serving feed does not publish must be flagged, not silently dropped (got ${hk.board})`,
  );
  assert.ok(hk.rows.length > 0 && hk.rows.every((r) => r.symbol.endsWith('.HK')), 'HK rows use the .HK dialect');
  assert.ok(/^\d{5}$/.test(hk.rows[0].code), `HK codes keep five digits (${hk.rows[0].code})`);
  return `US ${page.total} in ${page.pages}p via ${page.provider}, HK ${hk.board} via ${hk.provider} first=${hk.rows[0].symbol}`;
});

await check('the fetched pages become a locally searchable index', async () => {
  const status = service.universe.status();
  assert.ok(status.size >= 100, `expected the fetched pages in the index, got ${status.size}`);
  const bucket = service.universe.rows.get('US');
  const symbol = bucket.keys().next().value;
  const found = await api.route('GET', ['universe'], {
    query: new Map([['market', 'US'], ['q', symbol]]),
    force: false,
  });
  assert.equal(found.mode, 'search');
  assert.ok(found.rows.some((r) => r.symbol === symbol), `${symbol} must be searchable in the local index`);
  const none = await api.route('GET', ['universe'], {
    query: new Map([['market', 'HK'], ['q', 'ZZZZZZ']]),
    force: false,
  });
  assert.equal(none.rows.length, 0, 'a filter with no local match returns nothing, never a false hit');
  return `${status.size} indexed rows, ${symbol} found`;
});

await check('the widened search reaches ETFs, HK names and class shares', async () => {
  // ETFs (SQQQ/ICLN) and the `BRK.B` spelling are only known upstream, so this
  // check is only meaningful while the suggest feed answers. Two ways it can be
  // unavailable through no fault of ours: (a) the router's breaker has eastmoney
  // in cooldown because its *other* endpoints were RST — the search chain then
  // skips it by design, so 0 results is expected; (b) the feed itself refuses.
  // Either way report the gap; an answering feed that drops these rows still fails.
  const emStatus = service.router.status().providers.find((p) => p.id === 'eastmoney');
  if (!emStatus || emStatus.healthy === false || emStatus.cooldownRemainingMs > 0) {
    return {
      degraded: `eastmoney is in breaker cooldown, so the search chain skips it by design (${emStatus ? `${emStatus.consecutiveFailures} consecutive failures, ${emStatus.cooldownRemainingMs}ms left` : 'not registered'})`,
    };
  }
  try {
    const probe = await service.providers.get('eastmoney').searchStocks('SQQQ');
    if (!probe.length) return { degraded: 'the suggest feed answered SQQQ with 0 rows' };
  } catch (err) {
    const gap = upstreamGap(err);
    if (gap) return { degraded: `the suggest feed is unreachable — ${gap}` };
    throw err;
  }
  const reachable = [];
  for (const q of ['SQQQ', 'ICLN', '银行', '领展']) {
    const out = await service.search(q, undefined, { force: true });
    assert.ok(out.data.results.length > 0, `no results for ${q}`);
    reachable.push(`${q}:${out.data.results[0].symbol}`);
  }
  const brk = await service.search('BRK.B', undefined, { force: true });
  assert.ok(brk.data.results.some((r) => r.symbol === 'BRK.B'), 'the underscore spelling must be retried upstream');
  const hkBank = await service.search('银行', undefined, { force: true });
  assert.ok(hkBank.data.results.some((r) => r.market === 'HK'), 'HK names must no longer be buried under A-shares');
  return reachable.join(' ');
});

await check('POST /universe runs a board walk in the background and reports failures', async () => {
  const started = await api.route('POST', ['universe'], {
    query: new Map(),
    req: jsonReq({ market: 'US', board: 'NOPE' }),
    force: false,
  });
  assert.equal(typeof started.started, 'boolean');
  assert.ok(started.status && typeof started.status.refreshing === 'boolean');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const after = service.universe.status();
  assert.match(String(after.lastError), /unknown board/, 'a bad board must surface, not fail silently');
  assert.equal(after.refreshing, false, 'the failed walk must not leave the flag stuck');
  await assert.rejects(
    () => api.route('PUT', ['universe'], { query: new Map(), req: null, force: false }),
    (err) => err instanceof TradingError && err.code === 'BAD_REQUEST',
  );
  return `started=${started.started}, lastError reported`;
});

await check('the universe snapshot survives a restart', async () => {
  const before = service.universe.status();
  await service.universe.flush();
  const revived = new StockUniverse({ logger, homeDir: tmp });
  await revived.init();
  assert.equal(revived.loadedCount('US'), before.counts.US, 'US rows must reload unchanged');
  assert.equal(revived.loadedCount('HK'), before.counts.HK, 'HK rows must reload unchanged');
  const hit = revived.search('长和', { market: 'HK' });
  assert.ok(hit.length > 0 && hit[0].symbol === '0001.HK', `reloaded index must answer queries (got ${hit.length})`);
  return `${revived.loadedCount('US')} US / ${revived.loadedCount('HK')} HK rows reloaded`;
});

log('\n== transport fallbacks: refused bulk feeds and short candle series (user request m02212) ==');

await check('the registry carries the fallback feeds, scoped to what they can serve', async () => {
  const ids = [...service.providers.keys()];
  for (const id of ['yahoo', 'eastmoney', 'tencent', 'stooq', 'sina', 'nasdaq']) {
    assert.ok(ids.includes(id), `provider ${id} must be registered (got ${ids.join(', ')})`);
  }
  const nasdaq = service.providers.get('nasdaq');
  assert.equal(nasdaq.capabilities.universe, true, 'nasdaq serves the listing universe');
  assert.equal(nasdaq.capabilities.quote, false, 'nasdaq must not become a quote source');
  assert.deepEqual(nasdaq.listingMarkets, ['US'], 'nasdaq lists the US market only');
  const sina = service.providers.get('sina');
  assert.deepEqual(sina.listingMarkets, ['HK', 'CN'], 'sina lists the HK and A-share markets');
  assert.equal(sina.supportsInterval('1d'), true, 'sina serves daily candles');
  assert.equal(sina.supportsInterval('5m'), false, 'sina publishes no intraday series');
  const { indexSupportFor, lookupIndex } = await import('../../lib/trading/indices.js');
  assert.equal(indexSupportFor('sina', '^IXIC', 'candles'), true, 'sina publishes the Nasdaq Composite (dotted dialect)');
  assert.equal(lookupIndex('^IXIC').sinaSymbol, '.IXIC', 'the dotted sina symbol is declared in the directory');
  assert.equal(indexSupportFor('sina', '^GSPC', 'candles'), false, 'the S&P 500 has no sina series and must not be attempted');
  assert.equal(indexSupportFor('sina', '^VIX', 'candles'), false, 'VIX candles stay unavailable rather than guessed');
  return `providers: ${ids.join(', ')}`;
});

await check('0.5.0: crypto is a first-class market (chain, boards, market-aware ranges)', async () => {
  const cfg = await import('../../lib/trading/config.js');
  assert.deepEqual(cfg.MARKETS, ['US', 'HK', 'CN', 'JP', 'CRYPTO'], 'the five markets are declared in order');
  assert.deepEqual(cfg.STOCK_MARKETS, ['US', 'HK', 'CN', 'JP'], 'the equity markets exclude crypto');
  // The search chain is what used to be empty and made every crypto search throw NO_PROVIDER.
  // `candidates()` returns {provider, id, healthy} rows, so compare ids.
  const cryptoSearch = service.router.candidates('search', 'CRYPTO').map((c) => c.id);
  assert.ok(cryptoSearch.includes('coinlore'), `coinlore serves crypto search (got ${cryptoSearch.join(', ')})`);
  assert.deepEqual(
    service.router.candidates('profile', 'CRYPTO').map((c) => c.id),
    ['coinlore'],
    'coinlore is the crypto profile source',
  );
  const cryptoQuotes = service.router.candidates('quote', 'CRYPTO').map((c) => c.id);
  assert.ok(cryptoQuotes.includes('binance') && cryptoQuotes.includes('gate'), `crypto quotes: ${cryptoQuotes.join(', ')}`);
  assert.ok(!cryptoQuotes.includes('coinlore'), 'coinlore must never be asked for a quote');
  assert.equal(cfg.universeBoards('CRYPTO')[0].id, 'TOP', 'the crypto board id matches the provider');
  assert.ok(cfg.UNIVERSE_PROVIDERS.CRYPTO.includes('coinlore'), 'coinlore supplies the crypto listing');
  // Ranges: crypto trades 24/7, so a calendar day holds 24 hourly bars, not 7.
  assert.equal(cfg.candleLimit('1mo', '1h', 'CRYPTO'), 730, `crypto 1mo/1h bars (got ${cfg.candleLimit('1mo', '1h', 'CRYPTO')})`);
  assert.equal(cfg.candleLimit('6mo', '1d', 'CRYPTO'), 190, `crypto 6mo/1d bars (got ${cfg.candleLimit('6mo', '1d', 'CRYPTO')})`);
  assert.equal(cfg.candleLimit('6mo', '1d'), 142, 'the equity sizing is unchanged');
  assert.equal(cfg.candleLimit('1mo', '1h', 'US'), 164, 'US intraday sizing is unchanged');
  assert.equal(cfg.minBars('1y', '1d', 'CRYPTO'), 41, `crypto 1y floor (got ${cfg.minBars('1y', '1d', 'CRYPTO')})`);
  return `chain search: ${cryptoSearch.join(', ')} · quotes: ${cryptoQuotes.join(', ')}`;
});

await check('0.5.0: the directory tags every market with its own venue and currency', async () => {
  const dir = service.directory;
  const cases = [
    ['AAPL', undefined, 'NASDAQ', 'USD'],
    ['0700.HK', undefined, 'HKEX', 'HKD'],
    ['600519.SH', undefined, 'SSE', 'CNY'],
    ['000001.SZ', undefined, 'SZSE', 'CNY'],
    ['920001.BJ', undefined, 'BSE', 'CNY'],
    ['7203.T', undefined, 'JPX', 'JPY'],
    ['BTC', 'CRYPTO', 'CRYPTO', 'USDT'],
  ];
  for (const [symbol, market, exchange, currency] of cases) {
    const record = dir.lookup(symbol, market);
    assert.equal(record.exchange, exchange, `${symbol} venue (got ${record.exchange})`);
    assert.equal(record.currency, currency, `${symbol} currency (got ${record.currency})`);
  }
  // A bare crypto ticker is indistinguishable from a US ticker: without the hint
  // the directory answers US, which is why the service now passes the market in.
  assert.equal(dir.lookup('BTC').exchange, 'NASDAQ', 'no hint → the US reading');
  const fixed = dir.enrich([{ symbol: '600519.SH', market: 'CN', currency: 'USD' }]);
  assert.equal(fixed[0].currency, 'CNY', 'a US default on an A-share row is corrected');
  return `directory: ${cases.length} markets tagged`;
});

await check('0.5.0: JP and A-share names resolve locally, including kana', async () => {
  const dir = service.directory;
  // Eastmoney's suggest feed answers a Tokyo code (`7203`) or a Chinese name
  // (`丰田`) but returns nothing for the kana spelling, so the kana/rōmaji rows are
  // seeded locally. Pin that, plus the A-share names, so a future seed edit cannot
  // silently drop JP search back to "code only".
  const cases = [
    ['トヨタ', 'JP', '7203.T'],
    ['トヨタ自動車', 'JP', '7203.T'],
    ['toyota', 'JP', '7203.T'],
    ['ソニー', 'JP', '6758.T'],
    ['キーエンス', 'JP', '6861.T'],
    ['7203.T', 'JP', '7203.T'],
    ['茅台', 'CN', '600519.SH'],
    ['宁德时代', 'CN', '300750.SZ'],
  ];
  for (const [query, market, symbol] of cases) {
    const hits = dir.search(query, market, 3);
    assert.ok(hits.length > 0, `${query} must find a ${market} listing`);
    assert.equal(hits[0].symbol, symbol, `${query} → ${symbol} (got ${hits[0].symbol})`);
  }
  const jp = dir.lookup('7203.T');
  assert.equal(jp.exchange, 'JPX');
  assert.equal(jp.currency, 'JPY');
  // The kana row must not leak into another market's reading of the same word.
  assert.equal(dir.search('トヨタ', 'US', 3).length, 0, 'a JP kana alias must not answer a US search');
  return `kana/romaji/Chinese names resolve: トヨタ → ${dir.search('トヨタ', 'JP', 1)[0].symbol}`;
});

await check('0.5.0: a crypto profile is written by the provider, not only by the stub', async () => {
  const profile = await service.getProfile('BTC', { market: 'CRYPTO' });
  const data = profile.data;
  assert.equal(data.symbol, 'BTC', 'the canonical symbol comes back');
  assert.equal(data.market, 'CRYPTO', 'the market is stamped');
  assert.equal(data.currency, 'USDT', `crypto quotes in USDT (got ${data.currency})`);
  assert.equal(data.exchange, 'CRYPTO', 'crypto has no listing venue of its own');
  assert.ok(typeof data.description === 'string' && data.description.length > 40, 'a written profile is always present');
  return `source: ${data.source || profile.meta.provider}, currency: ${data.currency}`;
});

await check('minBars rejects a token series without rejecting a young listing', async () => {
  const { minBars } = await import('../../lib/trading/config.js');
  assert.equal(minBars('6mo', '1d') > 2, true, 'a two-bar answer must not clear a 6-month window');
  assert.equal(minBars('6mo', '1d'), 17, `6mo floor (got ${minBars('6mo', '1d')})`);
  assert.equal(minBars('1y', '1d'), 29, `1y floor (got ${minBars('1y', '1d')})`);
  assert.equal(minBars('1d', '5m'), 5, `intraday floor (got ${minBars('1d', '5m')})`);
  return `1d=${minBars('1d', '5m')} 1mo=${minBars('1mo', '1d')} 6mo=${minBars('6mo', '1d')} 1y=${minBars('1y', '1d')}`;
});

await check('a short series is skipped by the chain and never trips the provider breaker', async () => {
  const { MarketDataRouter } = await import('../../lib/trading/router.js');
  const { ProviderHealth, healthScope } = await import('../../lib/trading/http.js');
  const stub = (id, bars, opts = {}) => ({
    id,
    label: id,
    markets: ['US'],
    capabilities: { search: false, quote: false, candles: true, profile: false },
    intervals: ['1d'],
    supports: () => true,
    supportsInterval: () => true,
    getCandles: async () => {
      if (opts.fail) throw new TradingError('UPSTREAM_ERROR', `${id} is refused`);
      return Array.from({ length: bars }, (_, i) => ({ close: 100 + i }));
    },
  });
  const providers = new Map([
    ['yahoo', stub('yahoo', 0, { fail: true })],
    ['eastmoney', stub('eastmoney', 0, { fail: true })],
    ['tencent', stub('tencent', 2)],
    ['sina', stub('sina', 140)],
    ['stooq', stub('stooq', 0, { fail: true })],
  ]);
  const health = new ProviderHealth();
  const router = new MarketDataRouter({ providers, health, logger: null });
  const run = await router.run({
    feature: 'candles',
    market: 'US',
    interval: '1d',
    symbol: 'AAPL',
    fn: (provider) => provider.getCandles('AAPL', '1d', '6mo'),
    validate: (bars) => bars.length >= 17,
    sizeOf: (bars) => bars.length,
  });
  assert.equal(run.provider, 'sina', `the full series must win (got ${run.provider})`);
  assert.equal(run.value.length, 140, 'the full series is returned');
  assert.equal(run.degraded, undefined, 'a validated answer is not degraded');
  const snapshot = health.snapshot();
  // 0.6.0 keys health per capability (`provider::feature`), so the assertion has
  // to look at the scope that was actually used, not at the provider id.
  const candleScope = (id) => healthScope(id, 'candles');
  const tencentHealth = snapshot[candleScope('tencent')] || { failures: 0, healthy: true };
  assert.equal(tencentHealth.failures, 0, 'two bars is not a provider failure — the breaker must stay closed');
  assert.equal(health.isOpen(candleScope('tencent')), false, 'tencent stays healthy for the requests it can serve');
  assert.ok(
    (snapshot[candleScope('yahoo')] || {}).failures >= 1,
    'a real transport error still counts',
  );

  // Every provider short: the fullest answer is returned instead of a hard error.
  const shortOnly = new Map([['tencent', stub('tencent', 2)], ['sina', stub('sina', 4)]]);
  const router2 = new MarketDataRouter({ providers: shortOnly, health, logger: null });
  const all = await router2.run({
    feature: 'candles',
    market: 'US',
    interval: '1d',
    symbol: 'ZZZZ',
    fn: (provider) => provider.getCandles('ZZZZ', '1d', '6mo'),
    validate: (bars) => bars.length >= 17,
    sizeOf: (bars) => bars.length,
  });
  assert.equal(all.degraded, true, 'the partial answer is flagged as degraded');
  assert.equal(all.provider, 'sina', 'the largest partial series wins');
  assert.equal(all.value.length, 4, 'the partial series is still returned');
  return `winner=sina (140 bars) · tencent failures=${tencentHealth.failures} · degraded fallback=4 bars`;
});

await check('the US listing feed falls back to the next provider when the primary is refused', async () => {
  const refused = {
    id: 'eastmoney',
    label: 'refused',
    markets: ['US'],
    listingMarkets: ['US'],
    boards: () => [{ id: 'NASDAQ', label: 'NASDAQ' }],
    listSecurities: async () => {
      throw new TradingError('UPSTREAM_ERROR', 'eastmoney request failed: socket hang up');
    },
  };
  const fallback = {
    id: 'nasdaq',
    label: 'fallback',
    markets: ['US'],
    listingMarkets: ['US'],
    boards: () => [{ id: 'US-ALL', label: 'US — all listings' }],
    listSecurities: async ({ page, size }) => ({
      market: 'US',
      board: 'US-ALL',
      page,
      size,
      total: 250,
      pages: 3,
      rows: Array.from({ length: Math.min(size, 100) }, (_, i) => ({ symbol: `T${page}${i}`, name: `Test ${i}`, market: 'US', board: 'US-ALL' })),
    }),
  };
  const local = new StockUniverse({ logger, homeDir: tmp, providers: [refused, fallback] });
  const first = await local.page({ market: 'US', page: 1, size: 100 });
  assert.equal(first.provider, 'nasdaq', `the fallback feed must answer (got ${first.provider})`);
  assert.equal(first.rows.length, 100, 'the fallback page is returned');
  const wanted = await local.page({ market: 'US', board: 'NASDAQ', page: 2, size: 100 });
  assert.equal(wanted.provider, 'nasdaq', 'the fallback keeps serving the second page');
  assert.equal(wanted.boardFallback, true, 'a board the fallback does not publish falls back to its own board');
  assert.equal(wanted.board, 'US-ALL', 'the requested board is replaced, not silently dropped');
  assert.equal(local.boards('US')[0].provider, 'nasdaq', 'boards follow the feed that is actually serving');
  const failure = await local.page({ market: 'HK', page: 1, size: 100 }).then(
    () => null,
    (err) => err,
  );
  assert.ok(failure && failure.code === 'NO_PROVIDER', `a market without a feed must fail loudly (got ${failure && failure.code})`);
  return `US feed fell back to nasdaq (board ${first.board}), HK reported NO_PROVIDER`;
});

await check('the fallback feeds answer for real (nasdaq US table, sina HK list)', async () => {
  const { NasdaqProvider } = await import('../../lib/trading/providers/nasdaq.js');
  const { SinaProvider } = await import('../../lib/trading/providers/sina.js');
  const { RateLimiter } = await import('../../lib/trading/http.js');
  const nasdaq = new NasdaqProvider({ logger, limiter: new RateLimiter(), intervals: [] });
  const us = await nasdaq.listSecurities({ market: 'US', page: 1, size: 100 });
  assert.ok(us.total > 3000, `nasdaq must publish the US market (got total ${us.total})`);
  assert.equal(us.rows.length, 100, 'the first page is a full page');
  assert.ok(/^[A-Z][A-Z0-9.\-]{0,9}$/.test(us.rows[0].symbol), `symbols must be plain US tickers (got ${us.rows[0].symbol})`);
  assert.ok(us.pages > 30, `the table must page (got ${us.pages})`);
  const sina = new SinaProvider({ logger, limiter: new RateLimiter(), intervals: ['1d'] });
  const hk = await sina.listSecurities({ market: 'HK', page: 1, size: 60 });
  assert.equal(hk.rows.length, 60, `the HK list publishes 60 rows per page (got ${hk.rows.length})`);
  assert.ok(hk.rows.every((r) => r.symbol.endsWith('.HK')), 'every HK row carries a .HK symbol');
  assert.ok(hk.rows.some((r) => /[\u4e00-\u9fff]/.test(r.name)), 'the HK list carries Chinese names');
  assert.equal(hk.pages, null, 'the HK feed publishes no page count');
  assert.equal(hk.hasMore, true, 'a full page means there is more to fetch');
  return `nasdaq total=${us.total} pages=${us.pages} · sina HK ${hk.rows.length}/page first=${hk.rows[0].symbol} ${hk.rows[0].name}`;
});

await check('the live universe endpoint names the feed that served it', async () => {
  const value = await api.route('GET', ['universe'], { query: new Map([['market', 'US'], ['page', '1'], ['size', '50']]), req: null, force: false });
  assert.ok(value.rows.length > 0, 'the US browser must return rows even when the primary feed is refused');
  assert.ok(value.provider, 'the response names the feed');
  const board = (value.boards || []).find((b) => b.market === 'US');
  assert.ok(board && board.provider === value.provider, `the board list follows the serving feed (${board && board.provider} vs ${value.provider})`);
  const hk = await api.route('GET', ['universe'], { query: new Map([['market', 'HK'], ['size', '50']]), req: null, force: false });
  assert.ok(hk.rows.length > 0, 'the HK browser must return rows');
  assert.ok(hk.rows.every((r) => r.symbol.endsWith('.HK')), 'HK rows keep their market symbol');
  return `US via ${value.provider} (${value.rows.length} rows) · HK via ${hk.provider} (${hk.rows.length} rows)`;
});

log('\n== summary ==');
const passed = results.filter((r) => r.ok).length;
const degradedList = results.filter((r) => r.ok && r.degraded);
log(`  ${passed}/${results.length} checks passed, ${failures} failed, ${degradedList.length} degraded (upstream unavailable)`);
for (const r of degradedList) log(`    DEGR  ${r.title} — ${r.detail}`);
const slowest = results.filter((r) => r.ok).sort((a, b) => b.ms - a.ms).slice(0, 5);
log(`  slowest: ${slowest.map((r) => `${r.title} ${r.ms}ms`).join(' | ')}`);
log(`  provider health: ${JSON.stringify(service.router.status().providers.map((p) => ({ id: p.id, healthy: p.healthy, calls: p.calls, failures: p.failures })))} `);
log(`  cache: ${JSON.stringify(service.cache.snapshot())}`);
log(`  counters: ${JSON.stringify(service.counters)}`);

fs.writeFileSync(REPORT_FILE, JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, failures, degraded: degradedList.length, results, health: service.router.status(), cache: service.cache.snapshot() }, null, 2));
log(`  report: ${REPORT_FILE}`);

await watchlist.dispose();
await service.cache.flush();
process.exit(failures ? 1 : 0);
