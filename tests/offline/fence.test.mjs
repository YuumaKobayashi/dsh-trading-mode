/**
 * Round-3 P0-b: the host request fence must FAIL CLOSED.
 *
 * Before 0.8.0 a missing `connection.requestRejection` (or a fence that threw)
 * let every route through: the panel silently became an unauthenticated local
 * HTTP API. This suite pins the opposite behaviour — a deployment the plugin
 * cannot fence serves nothing except a data-free health check — plus the single,
 * explicit loopback debugging exception, which stays off by default.
 *
 * No network, no filesystem, no DSH profile.
 *
 *   node tests/offline/fence.test.mjs
 */
import assert from 'node:assert/strict';

import { ApiRoutes } from '../../lib/trading/api.js';
import { API_POLICY, allowUnfencedLoopback, setAllowUnfencedLoopback } from '../../lib/trading/config.js';
import { createSuite, exitCodeFor } from './harness.mjs';

/* ------------------------------------------------------------------ fakes */

function fakeReq({ method = 'GET', url = '/api/trading/status', body, remoteAddress = '203.0.113.7' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    headers: {},
    complete: true,
    socket: { remoteAddress },
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
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

function fakeWatchlist() {
  const calls = [];
  return {
    calls,
    backend: 'memory',
    info: () => ({ backend: 'memory', size: 0, users: 0 }),
    async list(userId) {
      calls.push({ op: 'list', userId });
      return [];
    },
    async add(userId, record) {
      calls.push({ op: 'add', userId });
      return { item: record, created: true };
    },
    async remove(userId, symbol) {
      calls.push({ op: 'remove', userId, symbol });
      return { removed: true, symbol };
    },
    async setFavorite(userId, symbol, value) {
      calls.push({ op: 'setFavorite', userId, symbol, value });
      return { symbol, isFavorite: Boolean(value) };
    },
    async reorder(userId, order) {
      calls.push({ op: 'reorder', userId });
      return order;
    },
  };
}

function fakeService() {
  const calls = [];
  return {
    calls,
    counters: { briefs: 0, analyses: 0 },
    cache: { backendName: 'memory' },
    resolveSymbol(symbol, market) {
      return { symbol: String(symbol || '').toUpperCase(), market: market || 'US' };
    },
    async getQuote(symbol, opts = {}) {
      calls.push({ op: 'getQuote', symbol });
      return { data: { symbol, price: 1, timestamp: Date.now() }, meta: { stale: false, marketOpen: true, provider: 'fake', market: opts.market || 'US' } };
    },
    async getTechnicals(symbol) {
      calls.push({ op: 'getTechnicals', symbol });
      return { data: { symbol, asOf: Date.now(), rsi14: 50 }, meta: { stale: false } };
    },
    async getProfile(symbol) {
      calls.push({ op: 'getProfile', symbol });
      return { data: { symbol }, meta: { stale: false } };
    },
    async getCandles(symbol) {
      calls.push({ op: 'getCandles', symbol });
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
  return {
    status: () => ({ available: false, reason: 'not configured' }),
    async analyzeStock() {
      return { symbol: 'AAPL', markdown: 'x' };
    },
    async watchlistBrief() {
      return { markdown: 'x', stocks: 0 };
    },
  };
}

function build(connection, opts = {}) {
  const service = fakeService();
  const watchlist = fakeWatchlist();
  const api = new ApiRoutes({
    service,
    ai: fakeAi(),
    watchlist,
    settings: null,
    identity: opts.identity || (() => ({ id: 'local-1', source: 'test', persistent: true })),
    version: '0.8.0-test',
    connection,
    logger: opts.logger || null,
    config: { problems: [] },
  });
  return { api, service, watchlist };
}

const FENCED_ROUTES = [
  { method: 'GET', url: '/api/trading/status' },
  { method: 'GET', url: '/api/trading/watchlist' },
  { method: 'POST', url: '/api/trading/watchlist', body: { symbol: 'AAPL' } },
  { method: 'GET', url: '/api/trading/quote?symbol=AAPL' },
  { method: 'POST', url: '/api/trading/analyze', body: { symbol: 'AAPL' } },
  { method: 'GET', url: '/api/trading/bootstrap' },
  { method: 'GET', url: '/api/trading/settings' },
];

const suite = createSuite('fence: the host request fence fails closed (0.8.0 round-3 P0-b)');

await suite.check('with no connection service at all, every data route answers 503 HOST_SECURITY_UNAVAILABLE', async () => {
  const reasons = [];
  const { api, service, watchlist } = build(null, { logger: { error: (m) => reasons.push(m), warn: () => {}, info: () => {} } });
  for (const route of FENCED_ROUTES) {
    const result = await call(api, route);
    assert.equal(result.status, 503, `${route.method} ${route.url} → ${result.status} ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error.code, 'HOST_SECURITY_UNAVAILABLE');
    assert.match(result.payload.error.message, /host security fence is required/i);
  }
  assert.equal(api.fenceFailures, FENCED_ROUTES.length, 'every refusal is counted');
  assert.deepEqual(service.calls, [], 'nothing upstream may run behind an unfenced request');
  assert.deepEqual(watchlist.calls, [], 'and no user data may be read or written');
  return `${FENCED_ROUTES.length} routes refused, 0 upstream calls`;
});

await suite.check('a connection object without requestRejection is refused, not trusted', async () => {
  const { api } = build({ register() {}, admit() {} });
  const result = await call(api, { method: 'GET', url: '/api/trading/status' });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error.code, 'HOST_SECURITY_UNAVAILABLE');
  assert.match(result.payload.error.message, /requestRejection/);
  return '503 + explicit reason';
});

await suite.check('a fence that throws is a refusal, never a 500 and never an open door', async () => {
  const { api, service } = build({
    requestRejection() {
      throw new Error('boom');
    },
  });
  const result = await call(api, { method: 'GET', url: '/api/trading/quote?symbol=AAPL' });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error.code, 'HOST_SECURITY_UNAVAILABLE');
  assert.match(result.payload.error.message, /threw: boom/);
  assert.deepEqual(service.calls, []);
  assert.equal(api.failures, 0, 'a refused request is a fence failure, not an internal error');
  return 'thrown fence → 503, 0 internal failures';
});

await suite.check('the host decision is passed through unchanged (403 / 401) and stops all work', async () => {
  const forbidden = build({ requestRejection: () => 403 });
  const blocked = await call(forbidden.api, { method: 'GET', url: '/api/trading/quote?symbol=AAPL' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.payload.error.code, 'FORBIDDEN');
  assert.deepEqual(forbidden.service.calls, []);

  const anonymous = build({ requestRejection: () => 401 });
  const denied = await call(anonymous.api, { method: 'GET', url: '/api/trading/watchlist' });
  assert.equal(denied.status, 401);
  assert.equal(denied.payload.error.code, 'UNAUTHENTICATED');
  assert.deepEqual(anonymous.watchlist.calls, []);

  // The host service returns undefined (or null / false) to admit a request.
  for (const admitted of [undefined, null, false]) {
    const { api } = build({ requestRejection: () => admitted });
    const result = await call(api, { method: 'GET', url: '/api/trading/status' });
    assert.equal(result.status, 200, `admission value ${String(admitted)} must pass`);
  }
  return '403 / 401 / undefined-null-false';
});

await suite.check('GET /api/trading/health answers before the fence and carries no data', async () => {
  const reasons = [];
  const { api, service, watchlist } = build(null, { logger: { error: (m) => reasons.push(m), warn: () => {} } });
  const result = await call(api, { method: 'GET', url: '/api/trading/health' });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  const value = result.payload.value;
  assert.equal(value.plugin, 'dsh-trading-mode');
  assert.equal(value.version, '0.8.0-test');
  assert.equal(value.api, 'blocked', 'an unfenced deployment advertises that it is blocked');
  assert.equal(value.fence, 'unavailable');
  assert.equal(value.identity, 'test', 'only the identity *source* is published');
  assert.equal(api.fenceFailures, 0, 'health is not a fence failure');

  const text = JSON.stringify(result.payload);
  assert.ok(!text.includes('local-1'), 'health must not leak the identity value');
  assert.deepEqual(
    Object.keys(value).sort(),
    ['api', 'fence', 'identity', 'note', 'plugin', 'version'],
    'the health payload publishes exactly these fields and nothing more',
  );
  for (const forbidden of ['filePath', 'cachePath', 'userId', 'provider', 'counters', 'requests']) {
    assert.ok(!text.includes(forbidden), `health must not publish ${forbidden}`);
  }
  assert.deepEqual(service.calls, []);
  assert.deepEqual(watchlist.calls, []);
  assert.equal(reasons.length, 0, 'a working health check must not log an error');
  return '200 + version/fence/api only, 0 leaks';
});

await suite.check('health is GET-only and still consumes no inbound quota', async () => {
  const { api } = build(null);
  const post = await call(api, { method: 'POST', url: '/api/trading/health', body: {} });
  assert.equal(post.status, 400, 'POST /health is a method error, not a 503');
  assert.equal(post.payload.error.code, 'BAD_REQUEST');
  assert.equal(api.fenceFailures, 0);

  const fenced = build({ requestRejection: () => undefined });
  const ok = await call(fenced.api, { method: 'GET', url: '/api/trading/health' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.value.api, 'ready');
  assert.equal(ok.payload.value.fence, 'host');
  assert.ok(
    fenced.api.limitsView().requests.every((row) => row.used === 0),
    'the health probe must not spend the caller budget',
  );
  return 'POST → 400; GET → 200 + 0 quota';
});

await suite.check('the loopback exception stays off by default and only a loopback peer could ever use it', async () => {
  assert.equal(API_POLICY.allowUnfencedLoopback, false, 'the debugging exception must ship disabled');
  assert.equal(API_POLICY.requireHostFence, true);

  // Default (exception off): even a genuine loopback peer is refused.
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '203.0.113.7']) {
    const { api } = build(null);
    const result = await call(api, { method: 'GET', url: '/api/trading/status', remoteAddress });
    assert.equal(result.status, 503, `peer ${remoteAddress} must be refused while the exception is off`);
  }

  // The exception is a private branch: the class must expose exactly the
  // documented refusal reasons and no "trust the peer" shortcut of its own.
  const { api } = build(null);
  assert.equal(typeof api.unfenced, 'function');
  assert.equal(api.fenceWarned, false, 'nothing is announced until a request needs the exception');
  return 'exception off + 4 peers refused';
});

await suite.check('the operator opt-in is honoured for loopback only, announced loudly, and restorable', async () => {
  assert.equal(allowUnfencedLoopback(), false, 'no override is in force at import time');

  // A malformed value is reported, never interpreted.
  assert.throws(() => setAllowUnfencedLoopback('yes please'), /must be true or false/);

  try {
    assert.equal(setAllowUnfencedLoopback(true), true);
    assert.equal(allowUnfencedLoopback(), true);
    assert.equal(API_POLICY.allowUnfencedLoopback, false, 'the shipped default constant stays truthful');

    const logs = [];
    const loopback = build(null, {
      logger: { error: (m) => logs.push(String(m)), warn: () => {}, info: () => {}, debug: () => {} },
    });
    const served = await call(loopback.api, {
      method: 'GET',
      url: '/api/trading/status',
      remoteAddress: '127.0.0.1',
    });
    assert.equal(served.status, 200, JSON.stringify(served.payload));
    assert.ok(
      logs.some((line) => /SECURITY/.test(line) && /allowUnfencedLoopback is ON/.test(line)),
      'using the exception must be announced at error level',
    );

    const health = await call(loopback.api, { method: 'GET', url: '/api/trading/health' });
    assert.equal(health.payload.value.api, 'ready-on-loopback-only');
    assert.equal(health.payload.value.fence, 'loopback-exception');

    // A remote peer is still refused even with the exception on.
    const remote = await call(loopback.api, {
      method: 'GET',
      url: '/api/trading/status',
      remoteAddress: '203.0.113.7',
    });
    assert.equal(remote.status, 503);
    assert.equal(remote.payload.error.code, 'HOST_SECURITY_UNAVAILABLE');
  } finally {
    setAllowUnfencedLoopback(false);
  }
  assert.equal(allowUnfencedLoopback(), false, 'the override must be clearable');

  const cleared = build(null);
  const refused = await call(cleared.api, { method: 'GET', url: '/api/trading/status', remoteAddress: '127.0.0.1' });
  assert.equal(refused.status, 503, 'clearing the override restores fail-closed behaviour');
  return 'opt-in honoured for loopback, remote still 503, override clearable';
});

const result = suite.finish();
process.exit(exitCodeFor(result));
