/**
 * HTTP surface + identity isolation (0.6.0, publication task A5/⑥).
 *
 * The plugin is a local-first tool, but "local" is not "unauthenticated": the
 * endpoint sits behind the DSH host fence, and *every* write must act as the
 * caller the host identified — never as a user id the client sent. This suite
 * drives `ApiRoutes.handle()` directly with fake requests and asserts that.
 *
 * No network, no filesystem.
 *
 *   node tests/offline/api.test.mjs
 */
import assert from 'node:assert/strict';

import { ApiRoutes, redactDiagnostic } from '../../lib/trading/api.js';
import { API_POLICY } from '../../lib/trading/config.js';
import { createSuite, exitCodeFor } from './harness.mjs';

/**
 * Home-directory fixtures are assembled at runtime instead of written literally, so the
 * repository hygiene gate (`repo.test.mjs`) keeps scanning this file for *real* leaked
 * author paths rather than flagging our own test data as one.
 */
const BACKSLASH = String.fromCharCode(92);
const winHome = (...parts) => ['C:', 'Users', ...parts].join(BACKSLASH);

/* ------------------------------------------------------------------ fakes */

function fakeReq({ method = 'GET', url = '/api/trading/status', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers,
    complete: true,
    once() {
      return this;
    },
    on() {
      return this;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(buffer) {
      if (buffer) this.body += Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
      this.ended = true;
    },
  };
  return res;
}

async function call(api, opts) {
  const res = fakeRes();
  await api.handle(fakeReq(opts), res);
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

/** A user-scoped in-memory watchlist, like the real one but without disk. */
function memoryWatchlist() {
  const users = new Map();
  const calls = [];
  const bucket = (userId) => {
    if (!users.has(userId)) users.set(userId, new Map());
    return users.get(userId);
  };
  return {
    calls,
    backend: 'memory',
    users,
    info() {
      return { backend: 'memory', size: [...users.values()].reduce((sum, m) => sum + m.size, 0), users: users.size };
    },
    async list(userId) {
      calls.push({ op: 'list', userId });
      return [...bucket(userId).values()];
    },
    async get(userId, symbol) {
      calls.push({ op: 'get', userId, symbol });
      return bucket(userId).get(symbol) || null;
    },
    async add(userId, record) {
      calls.push({ op: 'add', userId, symbol: record.symbol });
      const created = !bucket(userId).has(record.symbol);
      bucket(userId).set(record.symbol, record);
      return { item: record, created };
    },
    async remove(userId, symbol) {
      calls.push({ op: 'remove', userId, symbol });
      const removed = bucket(userId).delete(symbol);
      return { removed, symbol };
    },
    async setFavorite(userId, symbol, value) {
      calls.push({ op: 'setFavorite', userId, symbol, value });
      const item = bucket(userId).get(symbol);
      if (item) item.isFavorite = Boolean(value);
      return { symbol, isFavorite: Boolean(value), present: Boolean(item) };
    },
    async reorder(userId, order) {
      calls.push({ op: 'reorder', userId, order });
      return Array.isArray(order) ? order : [];
    },
  };
}

function fakeService() {
  return {
    counters: { briefs: 0 },
    cache: { backendName: 'memory' },
    resolveSymbol(symbol, market) {
      const text = String(symbol || '').trim().toUpperCase();
      assert.ok(text, 'the service must never be asked for an empty symbol');
      return { symbol: text, market: market || 'US' };
    },
    async getQuote(symbol, opts = {}) {
      return {
        data: { symbol, name: 'Apple Inc.', nameZh: '苹果', exchange: 'NASDAQ', currency: 'USD', price: 230.1, timestamp: Date.now() },
        meta: { stale: false, marketOpen: true, provider: 'fake', market: opts.market || 'US' },
      };
    },
    async getTechnicals(symbol) {
      return { data: { symbol, asOf: Date.now(), rsi14: 55.2 }, meta: { stale: false } };
    },
    async getProfile(symbol) {
      return { data: { symbol, description: 'fake' }, meta: { stale: false } };
    },
    async getCandles(symbol) {
      return { data: { candles: [] }, meta: { stale: false } };
    },
    async listIndices() {
      return { market: 'US', indices: [] };
    },
    async listCrypto() {
      return { market: 'CRYPTO', indices: [] };
    },
    status() {
      return { counters: { ...this.counters }, cache: { backend: 'memory' }, providers: [] };
    },
  };
}

function fakeAi() {
  const briefs = [];
  return {
    briefs,
    status() {
      return { available: true, route: 'deepseek-official/deepseek-flash', model: 'deepseek-flash' };
    },
    async analyzeStock(snapshot) {
      return { symbol: snapshot.symbol, markdown: '# analysis' };
    },
    async watchlistBrief(snapshot, opts) {
      briefs.push({ snapshot, opts });
      return { markdown: '# brief', stocks: snapshot.stocks.length, asOf: snapshot.asOf };
    },
  };
}

function fakeSettings() {
  const byUser = new Map();
  const calls = [];
  return {
    calls,
    async get(userId) {
      calls.push({ op: 'get', userId });
      return byUser.get(userId) || { userId, lang: 'en', updatedAt: null, storage: 'memory' };
    },
    async patch(userId, patch) {
      calls.push({ op: 'patch', userId, patch });
      const next = { ...(byUser.get(userId) || {}), ...patch, userId, updatedAt: Date.now(), storage: 'memory' };
      byUser.set(userId, next);
      return next;
    },
  };
}

function buildApi(opts = {}) {
  const watchlist = opts.watchlist || memoryWatchlist();
  const ai = opts.ai || fakeAi();
  const settings = opts.settings || fakeSettings();
  const service = opts.service || fakeService();
  let currentUser = opts.user || 'local-1';
  const api = new ApiRoutes({
    service,
    ai,
    watchlist,
    // 0.8.0: identity is an object ({id, source, persistent}); there is no
    // `userId` shortcut any more, because a missing identity must refuse
    // per-user data instead of silently sharing one bucket.
    identity: opts.identity === undefined ? () => ({ id: currentUser, source: 'test', persistent: true }) : opts.identity,
    // 0.8.0 default: an admitting host fence. A test that wants the fail-closed
    // path passes `connection: null` explicitly (see fence.test.mjs).
    connection: opts.connection === undefined ? { requestRejection: () => undefined } : opts.connection,
    settings,
    logger: opts.logger || null,
    config: { problems: [] },
  });
  return { api, watchlist, ai, settings, service, setUser: (id) => { currentUser = id; } };
}

const suite = createSuite('api: host fence and per-user isolation');

await suite.check('the host fence is honoured before anything else runs', async () => {
  const watchlist = memoryWatchlist();
  const forbidden = buildApi({ watchlist, connection: { requestRejection: () => 403 } });
  const blocked = await call(forbidden.api, { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error.code, 'FORBIDDEN');
  assert.deepEqual(watchlist.calls, [], 'a rejected request must not reach the store');

  const anonymous = buildApi({ watchlist, connection: { requestRejection: () => 401 } });
  const denied = await call(anonymous.api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(denied.status, 401);
  assert.equal(denied.payload.error.code, 'UNAUTHENTICATED');
  assert.deepEqual(watchlist.calls, []);

  const trusted = buildApi({ watchlist, connection: { requestRejection: () => undefined } });
  const allowed = await call(trusted.api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.payload.ok, true);
  assert.deepEqual(watchlist.calls, [{ op: 'list', userId: 'local-1' }]);
  return '403 / 401 / pass-through';
});

await suite.check('a host without a fence is refused with 503 and consumes no quota (0.8.0 fail closed)', async () => {
  const errors = [];
  const { api } = buildApi({ connection: null, logger: { error: (m) => errors.push(m), warn: () => {} } });
  const first = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  const second = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(first.status, 503, 'with no host fence the route must refuse, not open');
  assert.equal(first.payload.error.code, 'HOST_SECURITY_UNAVAILABLE');
  assert.equal(second.status, 503);
  assert.ok(errors.some((m) => /refusing GET/.test(m)), 'every refusal is announced at error level');
  assert.equal(api.fenceFailures, 2, 'the refusals are counted');
  // The fence runs before the inbound budget, so a refused caller cannot even
  // spend the shared quota bucket.
  const limits = api.limitsView();
  assert.ok(
    limits.requests.every((row) => row.used === 0),
    'a refused request never lands in the quota buckets',
  );
  return '503 twice + 2 fenceFailures + no quota spent';
});

await suite.check('every watchlist write acts as the caller, not as the body says', async () => {
  const { api, watchlist } = buildApi({ user: 'local-1' });
  const attempts = [
    { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL', userId: 'attacker', user: 'attacker' } },
    { method: 'PATCH', url: '/api/trading/watchlist/AAPL?userId=attacker', body: { isFavorite: true, userId: 'attacker' } },
    { method: 'DELETE', url: '/api/trading/watchlist/AAPL?user=attacker' },
    { method: 'POST', url: '/api/trading/watchlist/order', body: { symbols: ['AAPL'], userId: 'attacker' } },
  ];
  for (const attempt of attempts) {
    const result = await call(api, attempt);
    assert.equal(result.status, 200, `${attempt.method} ${attempt.url} → ${JSON.stringify(result.payload)}`);
  }
  const wrongUser = watchlist.calls.filter((entry) => entry.userId !== 'local-1');
  assert.deepEqual(wrongUser, [], 'no route may use an identity taken from the request');
  assert.ok(watchlist.calls.some((entry) => entry.op === 'add'));
  assert.ok(watchlist.calls.some((entry) => entry.op === 'setFavorite'));
  assert.ok(watchlist.calls.some((entry) => entry.op === 'remove'));
  assert.ok(watchlist.calls.some((entry) => entry.op === 'reorder'));
  return `${watchlist.calls.length} store calls, all as local-1`;
});

await suite.check('two identities sharing one store never see each other', async () => {
  const store = memoryWatchlist();
  const first = buildApi({ watchlist: store, user: 'local-1' });
  const second = buildApi({ watchlist: store, user: 'local-2' });

  await call(first.api, { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } });
  const other = await call(second.api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(other.status, 200);
  assert.deepEqual(other.payload.value.items, [], 'a new user starts empty');
  assert.equal(other.payload.value.userId, 'local-2');

  const mine = await call(first.api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.deepEqual(mine.payload.value.items.map((item) => item.symbol), ['AAPL']);

  const stolen = await call(second.api, { method: 'GET', url: '/api/trading/watchlist/AAPL' });
  assert.equal(stolen.status, 404, 'a symbol owned by another user is not found, not forbidden');
  assert.equal(stolen.payload.error.code, 'NOT_FOUND');

  const deletion = await call(second.api, { method: 'DELETE', url: '/api/trading/watchlist/AAPL' });
  assert.equal(deletion.payload.value.removed, false, 'the other user cannot delete it');
  const stillThere = await call(first.api, { method: 'GET', url: '/api/trading/watchlist/AAPL' });
  assert.equal(stillThere.status, 200);
  return 'isolation holds for read, write and delete';
});

await suite.check('the AI brief reads the caller\'s rows and rejects an empty list', async () => {
  const { api, ai, watchlist } = buildApi({ user: 'local-1' });
  const empty = await call(api, { method: 'POST', url: '/api/trading/watchlist/analyze', body: {} });
  assert.equal(empty.status, 400);
  assert.match(empty.payload.error.message, /the watchlist is empty; add a stock before requesting a brief/);
  assert.equal(ai.briefs.length, 0, 'no model call for an empty list');

  await call(api, { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } });
  const brief = await call(api, { method: 'POST', url: '/api/trading/watchlist/analyze', body: { lang: 'zh' } });
  assert.equal(brief.status, 200, JSON.stringify(brief.payload));
  assert.equal(brief.payload.value.stocks, 1);
  assert.equal(ai.briefs.length, 1);
  assert.equal(ai.briefs[0].opts.lang, 'zh');
  assert.equal(ai.briefs[0].snapshot.stocks[0].symbol, 'AAPL');
  assert.deepEqual(watchlist.calls.filter((c) => c.op === 'list').map((c) => c.userId), ['local-1', 'local-1']);
  return 'brief uses the caller rows';
});

await suite.check('preferences are stored per user as well', async () => {
  const store = fakeSettings();
  const { api, setUser } = buildApi({ settings: store, user: 'local-1' });
  const saved = await call(api, { method: 'PATCH', url: '/api/trading/settings', body: { lang: 'zh' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.value.lang, 'zh');
  assert.deepEqual(store.calls.at(-1), { op: 'patch', userId: 'local-1', patch: { lang: 'zh' } });

  const read = await call(api, { method: 'GET', url: '/api/trading/settings' });
  assert.equal(read.payload.value.lang, 'zh');
  assert.equal(read.payload.value.userId, 'local-1');

  setUser('local-2');
  const second = await call(api, { method: 'GET', url: '/api/trading/settings' });
  assert.equal(second.payload.value.userId, 'local-2');
  assert.equal(second.payload.value.lang, 'en', 'preferences do not leak across users');
  assert.ok(store.calls.every((c) => c.userId === 'local-1' || c.userId === 'local-2'));

  const bad = await call(api, { method: 'PATCH', url: '/api/trading/settings', body: { lang: 'klingon' } });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.error.message, /unsupported language "klingon"/);
  return 'per-user preferences';
});

await suite.check('the API publishes what is configurable, not how to configure it in code', async () => {
  const { api } = buildApi();
  const config = api.publicConfig();
  assert.deepEqual(config.markets, ['US', 'HK', 'CN', 'JP', 'CRYPTO']);
  assert.equal(config.networkMode, 'auto');
  assert.deepEqual(config.providerChainProblems, []);
  for (const market of config.markets) {
    assert.ok(Array.isArray(config.providerChains[market]) && config.providerChains[market].length, `${market} has no published chain`);
  }
  assert.equal(config.watchlistBackend, 'memory');
  assert.equal(config.cacheBackend, 'memory');
  // Task B3: the API must state the storage scope instead of leaving it implied.
  assert.equal(config.storage.scope, 'profile-local');
  assert.equal(config.storage.crossDevice, false);
  assert.match(config.storage.note, /local DSH profile/i);
  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.status, 200);
  assert.equal(status.payload.value.userId, 'local-1');
  assert.equal(status.payload.value.config.networkMode, 'auto');
  return `chains ${config.markets.map((m) => config.providerChains[m].length).join('/')}`;
});

await suite.check('bad requests are refused with a usable message', async () => {
  const { api } = buildApi();
  const noSymbol = await call(api, { method: 'POST', url: '/api/trading/watchlist', body: {} });
  assert.equal(noSymbol.status, 400);
  assert.match(noSymbol.payload.error.message, /POST \/watchlist requires a "symbol" field/);

  const badMethod = await call(api, { method: 'DELETE', url: '/api/trading/watchlist' });
  assert.equal(badMethod.status, 400);
  assert.match(badMethod.payload.error.message, /method not allowed here; use GET, POST/);

  const badJson = await call(api, { method: 'POST', url: '/api/trading/watchlist', body: '{not json' });
  assert.equal(badJson.status, 400);
  assert.match(badJson.payload.error.message, /request body is not valid JSON/);

  const tooBig = await call(api, { method: 'POST', url: '/api/trading/watchlist', body: JSON.stringify({ symbol: 'AAPL', pad: 'x'.repeat(70 * 1024) }) });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.payload.error.message, /request body is too large/);

  const nowhere = await call(api, { method: 'GET', url: '/api/trading/nope' });
  assert.equal(nowhere.status, 404);
  assert.equal(nowhere.payload.error.code, 'NOT_FOUND');
  assert.match(nowhere.payload.error.message, /no Trading Mode endpoint at GET \/api\/trading\/nope/);

  const badMarket = await call(api, { method: 'GET', url: '/api/trading/indices?market=MARS' });
  assert.equal(badMarket.status, 400);
  assert.match(badMarket.payload.error.message, /market MARS is not supported/);
  return 'symbol, method, JSON, size, 404, market';
});

await suite.check('the fence and the isolation rules survive a store that throws', async () => {
  const broken = memoryWatchlist();
  broken.list = async () => {
    throw new Error('disk is gone');
  };
  const { api } = buildApi({ watchlist: broken });
  const result = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(result.status, 500);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'INTERNAL');
  assert.equal(result.headers['cache-control'], 'no-store, no-cache, must-revalidate');
  return 'reported, not swallowed';
});

// --------------------------------------------------- 0.7.0 P0-4: inbound limits

await suite.check('a request burst is refused with 429 and a Retry-After header', async () => {
  const { api, watchlist } = buildApi();
  // Cheap GETs only: this must not consume the expensive buckets' quota.
  let refused = null;
  for (let i = 0; i < API_POLICY.perUser + 5; i += 1) {
    const result = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
    if (result.status === 429) {
      refused = result;
      break;
    }
    assert.equal(result.status, 200, `request ${i + 1} should be allowed`);
  }
  assert.ok(refused, `the general per-user budget (${API_POLICY.perUser}) was never enforced`);
  assert.equal(refused.payload.ok, false);
  assert.equal(refused.payload.error.code, 'RATE_LIMITED');
  assert.match(refused.payload.error.message, /too many/i);
  assert.ok(refused.payload.error.retryAfterMs > 0, 'the error must carry a retry hint');
  assert.equal(refused.headers['retry-after'], String(Math.ceil(refused.payload.error.retryAfterMs / 1000)));
  const reached = watchlist.calls.length;
  await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(watchlist.calls.length, reached, 'a refused request must not reach the service');
  return `refused after ${reached} requests, retry-after ${refused.headers['retry-after']}s`;
});

await suite.check('the expensive buckets are stricter than the general budget', async () => {
  const calls = [];
  const service = fakeService();
  const original = service.getQuote.bind(service);
  service.getQuote = async (symbol, opts) => {
    calls.push(symbol);
    return original(symbol, opts);
  };
  const ai = fakeAi();
  const { api } = buildApi({ service, ai });
  const limit = API_POLICY.expensive.analyze.perUser;
  let refused = null;
  for (let i = 0; i < limit + 2; i += 1) {
    const result = await call(api, { method: 'POST', url: '/api/trading/analyze/AAPL', body: { lang: 'en' } });
    if (result.status === 429) {
      refused = result;
      break;
    }
    assert.equal(result.status, 200, `analysis ${i + 1} should be allowed`);
  }
  assert.ok(refused, `the per-user analysis budget (${limit}) was never enforced`);
  assert.equal(refused.payload.error.code, 'RATE_LIMITED');
  assert.ok(limit < API_POLICY.perUser, 'the analysis budget must be stricter than the general one');
  // A different surface must still work: the quota is per bucket, not global.
  const quote = await call(api, { method: 'GET', url: '/api/trading/quote/AAPL' });
  assert.equal(quote.status, 200);
  return `analysis capped at ${limit}, quotes unaffected`;
});

await suite.check('concurrent expensive work is gated, not queued forever', async () => {
  const service = fakeService();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  service.getQuote = async (symbol) => {
    await gate;
    return { data: { symbol, price: 1, timestamp: Date.now() }, meta: { stale: false } };
  };
  const { api } = buildApi({ service });
  const inflight = [];
  for (let i = 0; i < API_POLICY.maxConcurrentAnalyses; i += 1) {
    inflight.push(call(api, { method: 'POST', url: `/api/trading/analyze/AAPL?x=${i}`, body: { lang: 'en' } }));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const blocked = await call(api, { method: 'POST', url: '/api/trading/analyze/MSFT', body: { lang: 'en' } });
  assert.equal(blocked.status, 429, 'the concurrency cap must answer 429 rather than pile up');
  assert.equal(blocked.payload.error.code, 'RATE_LIMITED');
  release();
  const settled = await Promise.all(inflight);
  for (const result of settled) assert.equal(result.status, 200, `an admitted analysis must still finish: ${JSON.stringify(result.payload)}`);
  const after = await call(api, { method: 'POST', url: '/api/trading/analyze/AAPL', body: { lang: 'en' } });
  assert.equal(after.status, 200, 'slots must be released when the work finishes');
  return `cap ${API_POLICY.maxConcurrentAnalyses} enforced, then released`;
});

await suite.check('/status publishes head-room and never leaks a URL, host or path', async () => {
  const service = fakeService();
  service.status = () => ({
    counters: { quotes: 1 },
    providers: [{ id: 'eastmoney', healthy: true, base: 'https://push2.eastmoney.com/api/qt/stock/get', lastError: null }],
    lastError:
      `eastmoney failed at https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519 (10.0.0.7:443) and the cache at ${winHome('someone', '.dsh', 'cache.json')} is stale`,
    index: '^VIX',
    symbol: '600519.SH',
    crypto: 'BTC-USD',
  });
  const { api } = buildApi({ service });
  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.status, 200);
  const value = status.payload.value;
  assert.ok(value.limits, 'the operator must be able to see remaining quota');
  assert.ok(Array.isArray(value.limits.requests), 'limits must list the counted buckets');
  const providers = value.providers || value.service?.providers;
  assert.ok(Array.isArray(providers) && providers.length, 'providers must still be reported');
  assert.equal(providers[0].id, 'eastmoney', 'the provider id is diagnostic, not secret');
  assert.equal(providers[0].healthy, true);
  const text = JSON.stringify(value);
  assert.ok(!text.includes('https://push2.eastmoney.com/api'), `a URL leaked: ${text}`);
  assert.ok(!text.includes('10.0.0.7'), 'an IP leaked');
  assert.ok(!text.includes(winHome('someone')), 'an absolute path leaked');
  assert.match(JSON.stringify(value.lastError ?? {}), /redacted|push2\.eastmoney\.com\/…|\[redacted-host\]/);
  // Symbols and provider ids must survive redaction.
  return 'limits reported, diagnostics redacted';
});

await suite.check('redactDiagnostic keeps identifiers while hiding infrastructure', () => {
  assert.equal(redactDiagnostic('https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&f=1'), 'https://push2.eastmoney.com/…');
  assert.equal(redactDiagnostic('failed at 10.0.0.7:443'), 'failed at [redacted-ip]:443');
  assert.equal(redactDiagnostic(`cache file ${winHome('me', '.dsh', 'cache.json')} unreadable`), 'cache file …/cache.json unreadable');
  assert.equal(redactDiagnostic('see /var/tmp/dsh/cache.json'), 'see …/cache.json');
  assert.equal(redactDiagnostic('600519.SH is unavailable'), '600519.SH is unavailable');
  assert.equal(redactDiagnostic('BTC-USD is unavailable'), 'BTC-USD is unavailable');
  assert.equal(redactDiagnostic(42), 42);
  return 'URL/IP/path redacted, symbols untouched';
});

process.exit(exitCodeFor(suite.finish()));
