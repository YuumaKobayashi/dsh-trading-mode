/**
 * Round-3 P1⑦: no deployment may silently share one storage bucket.
 *
 * `resolveUserId()` used to fall back to the literal `'local'`, so every browser
 * that reached an unfenced panel read and wrote the *same* watchlist. 0.8.0
 * replaces that with an explicit identity: the host anonymous user id, or an
 * operator-declared single-user bucket, or nothing — and "nothing" refuses
 * per-user data with 503 NO_IDENTITY while market data keeps working.
 *
 * No network, no filesystem, no DSH profile.
 *
 *   node tests/offline/identity.test.mjs
 */
import assert from 'node:assert/strict';

import { ApiRoutes } from '../../lib/trading/api.js';
import { DEFAULT_LANG } from '../../lib/trading/config.js';
import { createSuite, exitCodeFor } from './harness.mjs';

/* ------------------------------------------------------------------ fakes */

function fakeReq({ method = 'GET', url = '/api/trading/status', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers: {},
    complete: true,
    socket: { remoteAddress: '127.0.0.1' },
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
  return {
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
}

async function call(api, opts) {
  const res = fakeRes();
  await api.handle(fakeReq(opts), res);
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null };
}

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
    info: () => ({ backend: 'memory', size: [...users.values()].reduce((sum, m) => sum + m.size, 0), users: users.size }),
    async list(userId) {
      calls.push({ op: 'list', userId });
      return [...bucket(userId).values()];
    },
    async add(userId, record) {
      calls.push({ op: 'add', userId, symbol: record.symbol });
      const created = !bucket(userId).has(record.symbol);
      bucket(userId).set(record.symbol, record);
      return { item: record, created };
    },
    async remove(userId, symbol) {
      calls.push({ op: 'remove', userId, symbol });
      return { removed: bucket(userId).delete(symbol), symbol };
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
      return { symbol: String(symbol || '').trim().toUpperCase(), market: market || 'US' };
    },
    async getQuote(symbol) {
      return {
        data: { symbol, name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', price: 230.1, timestamp: Date.now() },
        meta: { stale: false, marketOpen: true, provider: 'fake', market: 'US' },
      };
    },
    async getTechnicals(symbol) {
      return { data: { symbol, asOf: Date.now(), rsi14: 55 }, meta: { stale: false } };
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

/** An admitting host fence, so the fence cannot be what refuses these calls. */
const ADMITTING_FENCE = { requestRejection: () => undefined };

function build(opts = {}) {
  const watchlist = opts.watchlist || memoryWatchlist();
  const settings = opts.settings || fakeSettings();
  const service = opts.service || fakeService();
  const errors = [];
  const warns = [];
  const api = new ApiRoutes({
    service,
    ai: {
      status: () => ({ available: false, reason: 'not configured' }),
      async analyzeStock() {
        return { markdown: 'x' };
      },
      async watchlistBrief() {
        return { markdown: 'x', stocks: 0 };
      },
    },
    watchlist,
    settings,
    identity: opts.identity === undefined ? () => ({ id: null, source: 'none', persistent: false }) : opts.identity,
    version: '0.8.0-test',
    connection: opts.connection === undefined ? ADMITTING_FENCE : opts.connection,
    logger: opts.logger || { error: (m) => errors.push(m), warn: (m) => warns.push(m), info: () => {}, debug: () => {} },
    config: { problems: [] },
  });
  return { api, watchlist, settings, service, errors, warns };
}

const suite = createSuite('identity: per-user data needs a real identity (0.8.0 round-3 P1⑦)');

await suite.check('with no host identity, market data still works but no per-user route does', async () => {
  const { api, watchlist, settings } = build();

  // Reads that do not touch a user bucket are unaffected.
  const quote = await call(api, { method: 'GET', url: '/api/trading/quote/AAPL' });
  assert.equal(quote.status, 200, JSON.stringify(quote.payload));
  const indices = await call(api, { method: 'GET', url: '/api/trading/indices' });
  assert.equal(indices.status, 200);

  const perUser = [
    { method: 'GET', url: '/api/trading/watchlist' },
    { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } },
    { method: 'PATCH', url: '/api/trading/watchlist/AAPL', body: { isFavorite: true } },
    { method: 'DELETE', url: '/api/trading/watchlist/AAPL' },
    { method: 'POST', url: '/api/trading/watchlist/order', body: { symbols: ['AAPL'] } },
    { method: 'POST', url: '/api/trading/watchlist/analyze', body: {} },
    { method: 'PATCH', url: '/api/trading/settings', body: { lang: 'zh' } },
  ];
  for (const route of perUser) {
    const result = await call(api, route);
    assert.equal(result.status, 503, `${route.method} ${route.url} → ${result.status} ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.error.code, 'NO_IDENTITY');
    assert.match(result.payload.error.message, /no trustworthy per-user identity/i);
  }
  assert.deepEqual(watchlist.calls, [], 'nothing may be read or written without an identity');
  assert.deepEqual(settings.calls, [], 'and no preference may be stored in a shared bucket');
  return `${perUser.length} per-user routes refused, store untouched`;
});

await suite.check('a refused per-user write costs no expensive quota', async () => {
  const { api } = build();
  const brief = await call(api, { method: 'POST', url: '/api/trading/watchlist/analyze', body: {} });
  assert.equal(brief.status, 503);
  const analysis = await call(api, { method: 'POST', url: '/api/trading/analyze/AAPL', body: {} });
  // `analyze` itself is not per-user storage; it must still be refused for the
  // *identity* reason only when it needs stored rows — here it must not crash.
  assert.ok([200, 503].includes(analysis.status), `analysis answered ${analysis.status}`);
  const briefBucket = api.limitsView().buckets.find((row) => row.bucket === 'brief');
  assert.ok(briefBucket.limits.every((row) => row.used === 0), 'the brief bucket must be untouched when the identity is missing');
  return 'brief bucket unused, no crash';
});

await suite.check('/status and /bootstrap report the identity honestly, and never when it is absent', async () => {
  const { api } = build();
  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.status, 200);
  assert.equal(status.payload.value.userId, null, 'no fabricated identity may be published');
  assert.equal(status.payload.value.identity.source, 'none');
  assert.equal(status.payload.value.identity.storesPerUserData, false);
  assert.equal(status.payload.value.settings.storage, 'no-identity');
  assert.equal(status.payload.value.settings.lang, DEFAULT_LANG);
  assert.equal(status.payload.value.settings.userId, null);
  assert.ok(status.payload.value.settings.supported.includes(DEFAULT_LANG));
  assert.ok(!JSON.stringify(status.payload).includes('"local"'), 'the old shared `local` bucket must not appear');

  const bootstrap = await call(api, { method: 'GET', url: '/api/trading/bootstrap' });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.payload.value.items, []);
  assert.equal(bootstrap.payload.value.identity.storesPerUserData, false);
  return 'status + bootstrap: null user, source none, no `local`';
});

await suite.check('a declared single-user bucket makes per-user storage work again', async () => {
  const declared = () => ({ id: 'desktop-single-user', source: 'configured-local-bucket', persistent: true });
  const { api, watchlist } = build({ identity: declared });
  const added = await call(api, { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } });
  assert.equal(added.status, 200, JSON.stringify(added.payload));
  const listed = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.value.userId, 'desktop-single-user');
  assert.equal(listed.payload.value.count, 1);
  assert.ok(watchlist.calls.every((entry) => entry.userId === 'desktop-single-user'));
  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.payload.value.identity.source, 'configured-local-bucket');
  assert.equal(status.payload.value.identity.storesPerUserData, true);
  return 'add + list under the declared bucket';
});

await suite.check('a host identity is used verbatim, and only its source is published', async () => {
  const hostId = 'anon-9f2b7c41-dead-beef'; // synthetic fixture id, not a credential
  const { api, watchlist } = build({ identity: () => ({ id: hostId, source: 'host-anonymous-id', persistent: true }) });
  const added = await call(api, { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'MSFT' } });
  assert.equal(added.status, 200);
  assert.ok(watchlist.calls.some((entry) => entry.userId === hostId), 'the host id is the storage key');

  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.payload.value.identity.source, 'host-anonymous-id');
  assert.equal(status.payload.value.identity.id, hostId, 'the operator may see their own id locally');

  const health = await call(api, { method: 'GET', url: '/api/trading/health' });
  assert.equal(health.status, 200);
  assert.equal(health.payload.value.identity, 'host-anonymous-id');
  assert.ok(!JSON.stringify(health.payload).includes(hostId), 'health must publish the source, not the value');
  return 'id used for storage, only source published by /health';
});

await suite.check('a broken identity resolver is treated as "no identity", never as a shared bucket', async () => {
  const { api, watchlist, warns } = build({
    identity: () => {
      throw new Error('anonymous id store unreadable');
    },
  });
  const listed = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(listed.status, 503);
  assert.equal(listed.payload.error.code, 'NO_IDENTITY');
  assert.deepEqual(watchlist.calls, []);
  assert.ok(
    warns.some((m) => /identity resolver failed/.test(m)),
    'the failure must be reported, not swallowed',
  );
  const status = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(status.status, 200, 'a broken resolver must not take the whole panel down');
  assert.equal(status.payload.value.identity.source, 'none');
  return 'resolver throw → 503 + warning + status still answers';
});

await suite.check('an empty or malformed identity object counts as no identity', async () => {
  for (const value of [null, undefined, {}, { id: '' }, { id: 42 }, { source: 'x' }]) {
    const { api } = build({ identity: () => value });
    const result = await call(api, { method: 'GET', url: '/api/trading/watchlist' });
    assert.equal(result.status, 503, `${JSON.stringify(value)} must not grant storage`);
    assert.equal(result.payload.error.code, 'NO_IDENTITY');
  }
  return '6 malformed identities refused';
});

const result = suite.finish();
process.exit(exitCodeFor(result));
