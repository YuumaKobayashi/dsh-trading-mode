/**
 * HTTP surface (spec §45–§49).
 *
 * The plugin owns one prefix route, `/api/trading`, on the host webserver. The
 * client talks to it with ordinary same-origin `fetch` — there is no
 * front-to-upstream connection and no third-party URL in the browser (§50).
 *
 * Two deliberate choices:
 *
 *  - **Prefix, not exact routes.** The spec's URLs carry variable segments
 *    (`/api/trading/quote/AAPL`, `/api/trading/watchlist/AAPL`, DELETE and PATCH
 *    methods). dsh-host-webserver resolves prefixes by longest match, so
 *    `/api/trading` wins over the generic `/api` route and everything under it
 *    arrives here.
 *  - **Reuse the host's own request fence.** We call the same
 *    `connection.requestRejection(req)` the API gateway uses, so this endpoint
 *    is reachable only from a trusted Host/Origin with a real browser session
 *    (403 / 401 otherwise) instead of inventing a second auth scheme.
 *
 * Every response is `{ ok: true, value }` or `{ ok: false, error }`, and every
 * failure is reported — never an empty success (§77.27).
 */

import { CODES, TradingError, toTradingError } from './errors.js';
import { ConcurrencyGate, QuotaLimiter } from './limits.js';
import {
  API_POLICY,
  IDENTITY_POLICY,
  RECOMMENDED_STARTERS,
  CRYPTO_SPOTLIGHT,
  DISCLAIMER,
  MARKET_LABELS,
  MARKETS,
  STOCK_MARKETS,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  UNIVERSE_POLICY,
  allowUnfencedLoopback,
  marketConfig,
  networkMode,
  normalizeLang,
  providerChainProblems,
} from './config.js';

const PREFIX = '/api/trading';
const MAX_BODY_BYTES = 64 * 1024;

/** Error code → HTTP status. */
const STATUS_BY_CODE = {
  [CODES.BAD_REQUEST]: 400,
  [CODES.INVALID_SYMBOL]: 400,
  [CODES.UNSUPPORTED_MARKET]: 400,
  [CODES.UNSUPPORTED_INTERVAL]: 400,
  [CODES.NOT_FOUND]: 404,
  [CODES.NO_PROVIDER]: 503,
  [CODES.DATA_UNAVAILABLE]: 503,
  [CODES.UPSTREAM_BLOCKED]: 503,
  [CODES.UPSTREAM_RATE_LIMIT]: 429,
  [CODES.RATE_LIMITED]: 429,
  [CODES.HOST_SECURITY_UNAVAILABLE]: 503,
  [CODES.NO_IDENTITY]: 503,
  [CODES.UPSTREAM_TIMEOUT]: 504,
  [CODES.UPSTREAM_ERROR]: 502,
  [CODES.PARSE_ERROR]: 502,
  [CODES.AI_UNAVAILABLE]: 503,
  [CODES.AI_INVALID_OUTPUT]: 502,
  [CODES.STORAGE_ERROR]: 500,
  [CODES.INTERNAL]: 500,
};

export class ApiRoutes {
  /**
   * @param {{service: any, ai: any, watchlist: any, userId: () => (string|null), identity?: any, version?: string, logger?: any, connection?: any, config?: any, settings?: any}} opts
   */
  constructor(opts) {
    this.service = opts.service;
    this.ai = opts.ai;
    this.watchlist = opts.watchlist;
    this.logger = opts.logger || null;
    this.connection = opts.connection || null;
    this.config = opts.config || {};
    /** Plugin version, reported by the fence-independent `/health` route. */
    this.version = typeof opts.version === 'string' ? opts.version : null;
    /**
     * Identity resolver (0.8.0). A function returning
     * `{ id: string|null, source: string, persistent: boolean }`. There is no
     * silent fallback to a shared bucket any more (round-3 P1⑦).
     */
    this.identity = typeof opts.identity === 'function' ? opts.identity : () => opts.identity || null;
    /** Optional per-user preferences store (display language). */
    this.settings = opts.settings || this.config.settingsStore || null;
    /** @type {Array<() => void>} */
    this.disposers = [];
    this.requests = 0;
    this.failures = 0;
    this.rejections = 0;
    /** Inbound request limits (0.7.0): the panel must not fan out unbounded. */
    this.quota = new QuotaLimiter({ windowMs: API_POLICY.windowMs });
    this.gate = new ConcurrencyGate();
    /** Warn once, loudly, if the host gives us no fence to reuse. */
    this.fenceWarned = false;
    /** Requests refused because the host fence was unavailable (round-3 P0-b). */
    this.fenceFailures = 0;
  }

  /** The identity in force: `{ id, source, persistent }`, never a fabricated id. */
  identityView() {
    let value = null;
    try {
      value = this.identity();
    } catch (err) {
      this.logger?.warn?.(`trading-mode: identity resolver failed: ${err && err.message}`);
    }
    const id = value && typeof value.id === 'string' && value.id ? value.id : null;
    return {
      id,
      source: (value && value.source) || 'none',
      persistent: Boolean(value && value.persistent),
      /** Per-user data is only stored when a trustworthy identity exists. */
      storesPerUserData: Boolean(id),
    };
  }

  /** True when per-user storage is available; otherwise the route must refuse. */
  hasIdentity() {
    return Boolean(this.identityView().id);
  }

  /** 503 unless a trustworthy per-user identity exists (round-3 P1⑦). */
  requireIdentity(action) {
    if (this.hasIdentity()) return this.identityView().id;
    throw new TradingError(
      CODES.NO_IDENTITY,
      `Trading Mode cannot ${action}: this deployment has no trustworthy per-user identity (the host did not provide an anonymous user id and no \`identity.localBucket\` is configured), so per-user data is refused rather than shared between every browser`,
    );
  }

  /** All routes: per user and globally, per rolling window. */
  generalLimits() {
    return [
      { scope: 'user', key: this.safeUserId(), limit: API_POLICY.perUser },
      { scope: 'global', key: '*', limit: API_POLICY.global },
    ];
  }

  /** Concurrent expensive operations (analysis / brief / universe walk). */
  concurrencyLimits() {
    return [
      { scope: 'user', key: this.safeUserId(), limit: API_POLICY.maxConcurrentAnalyses },
      { scope: 'global', key: '*', limit: API_POLICY.maxConcurrentAnalysesGlobal },
    ];
  }

  /** Quota for one expensive bucket, per user and globally. */
  expensiveLimits(bucket) {
    const cfg = (API_POLICY.expensive && API_POLICY.expensive[bucket]) || {};
    return [
      { scope: 'user', key: this.safeUserId(), limit: cfg.perUser ?? API_POLICY.perUser },
      { scope: 'global', key: '*', limit: cfg.global ?? API_POLICY.global },
    ];
  }

  /**
   * Metering key for the quota buckets. This is a rate-limiting decision, never a
   * storage decision: when the identity is unknown every caller shares the single
   * `shared` bucket (0.8.0), while stored per-user data is refused outright.
   */
  safeUserId() {
    return this.identityView().id || 'shared';
  }

  /** Remaining head-room, for `/status`. */
  limitsView() {
    return {
      windowMs: this.quota.windowMs,
      requests: this.quota.peek('request', this.generalLimits()),
      buckets: Object.keys(API_POLICY.expensive || {}).map((bucket) => ({
        bucket,
        limits: this.quota.peek(bucket, this.expensiveLimits(bucket)),
      })),
      inFlight: this.gate.snapshot().rows.map((row) => ({ scope: row.key.split('|')[1], active: row.active })),
      rejections: this.rejections,
    };
  }

  /**
   * Run an expensive operation under its quota and concurrency gate. Both are
   * checked before any upstream request is made, and the concurrency slot is
   * released even when the operation throws.
   */
  async expensive(bucket, fn) {
    const quota = this.quota.take(bucket, this.expensiveLimits(bucket));
    if (!quota.ok) {
      this.rejections += 1;
      const seconds = Math.max(1, Math.ceil(quota.retryAfterMs / 1000));
      throw new TradingError(
        CODES.RATE_LIMITED,
        `too many ${bucket} requests (limit ${quota.limit} per ${Math.round(this.quota.windowMs / 1000)}s for ${quota.scope}); retry in about ${seconds}s`,
        { retryAfterMs: quota.retryAfterMs, retryable: true },
      );
    }
    const entered = this.gate.enter('expensive', this.concurrencyLimits());
    if (!entered.ok) {
      this.rejections += 1;
      throw new TradingError(
        CODES.RATE_LIMITED,
        `another analysis is already running (limit ${entered.limit} at a time for ${entered.scope}); try again shortly`,
        { retryAfterMs: 1_500, retryable: true },
      );
    }
    try {
      return await fn();
    } finally {
      this.gate.release(entered.tokens);
    }
  }

  /** @param {any} webServer the `webServer` service */
  register(webServer) {
    if (!webServer || typeof webServer.register !== 'function') {
      throw new TradingError(CODES.INTERNAL, 'the DSH webServer service is unavailable, so the Trading API cannot be served');
    }
    const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => this.handle(req, res) });
    this.disposers.push(typeof dispose === 'function' ? dispose : () => {});
    this.logger?.info?.(`trading-mode: API mounted at ${PREFIX}`);
    return this;
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        this.logger?.warn?.(`trading-mode: route dispose failed: ${err && err.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ dispatch

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async handle(req, res) {
    this.requests += 1;
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
      const segments = path ? path.split('/').map(decodeURIComponent) : [];
      const method = (req.method || 'GET').toUpperCase();
      const query = url.searchParams;

      // Minimal health check (round-3 P0-b): answered before the fence, never
      // touching upstream data, the store, the user's identity value or the
      // filesystem — so an operator can still tell *why* the panel is refused.
      if (segments.length === 1 && segments[0] === 'health') return this.health(res, method);

      const rejection = this.fence(req);
      if (rejection === 503) {
        this.fenceFailures += 1;
        const error = new TradingError(CODES.HOST_SECURITY_UNAVAILABLE, this.fenceReason);
        return respond(res, 503, { ok: false, error: error.toJSON() });
      }
      if (rejection === 403) return respond(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'this request did not pass the DSH host/origin check' } });
      if (rejection === 401) return respond(res, 401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'no authenticated DSH browser session for this request' } });

      // Every route counts against the inbound budget, before any upstream call.
      const budget = this.quota.take('request', this.generalLimits());
      if (!budget.ok) {
        this.rejections += 1;
        const seconds = Math.max(1, Math.ceil(budget.retryAfterMs / 1000));
        const error = new TradingError(
          CODES.RATE_LIMITED,
          `too many Trading Mode requests (limit ${budget.limit} per ${Math.round(this.quota.windowMs / 1000)}s for ${budget.scope}); retry in about ${seconds}s`,
          { retryAfterMs: budget.retryAfterMs, retryable: true },
        );
        return respond(res, 429, { ok: false, error: error.toJSON() }, { 'retry-after': String(seconds) });
      }

      const force = isTruthy(query.get('force'));
      const signal = abortSignalFor(req);

      const result = await this.route(method, segments, { query, force, signal, req });
      if (result === undefined) {
        return respond(res, 404, {
          ok: false,
          error: { code: CODES.NOT_FOUND, message: `no Trading Mode endpoint at ${method} ${PREFIX}${path ? `/${path}` : ''}` },
        });
      }
      return respond(res, 200, { ok: true, value: result });
    } catch (err) {
      this.failures += 1;
      const error = toTradingError(err);
      const status = STATUS_BY_CODE[error.code] || 500;
      if (status >= 500) this.logger?.warn?.(`trading-mode: ${req.method} ${req.url} → ${error.code}: ${error.message}`);
      else this.logger?.debug?.(`trading-mode: ${req.method} ${req.url} → ${error.code}: ${error.message}`);
      const headers = error.retryAfterMs ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) } : undefined;
      return respond(res, status, { ok: false, error: error.toJSON() }, headers);
    }
  }

  /**
   * The host's own request fence, plus the round-3 fail-closed policy (P0-b).
   *
   * Returns `null` when the request may proceed (the host fence admitted it, or
   * the operator explicitly enabled the loopback-only debugging exception and
   * this peer really is loopback), otherwise `403`, `401`, or `503` when there is
   * no usable host fence at all. A missing or broken fence is a refusal, never an
   * open door.
   */
  fence(req) {
    this.fenceReason = null;
    const host = this.connection;
    if (!host || typeof host.requestRejection !== 'function') {
      return this.unfenced(req, 'the host did not expose `connection.requestRejection`, so same-origin callers cannot be told apart from any other client');
    }
    try {
      const rejection = host.requestRejection(req);
      if (rejection === undefined || rejection === null || rejection === false) return null;
      return rejection === 401 ? 401 : 403;
    } catch (err) {
      return this.unfenced(req, `the host request fence threw: ${err && err.message}`);
    }
  }

  /**
   * Decide what to do when the host fence is unusable. The only way through is
   * `security.allowUnfencedLoopback: true` **and** a loopback peer; that is a
   * debugging exception an operator has to ask for, it is announced at error
   * level, and it never applies to a remote peer.
   */
  unfenced(req, why) {
    if (allowUnfencedLoopback() && isLoopbackPeer(req)) {
      if (!this.fenceWarned) {
        this.fenceWarned = true;
        this.logger?.error?.(
          `trading-mode: SECURITY — security.allowUnfencedLoopback is ON and this peer is loopback, so requests are served WITHOUT the host request fence (${why}). This is a debugging exception, not a supported mode; untrusted callers must never be able to reach this port.`,
        );
      }
      return null;
    }
    this.fenceReason = `Trading Mode refuses this request: ${why}. The host security fence is required (503 HOST_SECURITY_UNAVAILABLE), so nothing is served to a caller that cannot be told apart from a remote one.`;
    this.logger?.error?.(`trading-mode: refusing ${req.method} ${req.url} — ${why}`);
    return 503;
  }

  /**
   * The fence-independent health check. Answers even when the fence is missing,
   * and deliberately carries no user data, no configuration, no paths, no
   * counters and performs no upstream request.
   */
  health(res, method) {
    if (method !== 'GET') return this.methodNotAllowed(['GET']);
    const fenced = Boolean(this.connection && typeof this.connection.requestRejection === 'function');
    return respond(res, 200, {
      ok: true,
      value: {
        plugin: 'dsh-trading-mode',
        version: this.version,
        api: fenced ? 'ready' : allowUnfencedLoopback() ? 'ready-on-loopback-only' : 'blocked',
        fence: fenced ? 'host' : allowUnfencedLoopback() ? 'loopback-exception' : 'unavailable',
        identity: this.identityView().source,
        note: fenced
          ? 'requests are refused by the host request fence before any Trading Mode work starts'
          : 'the host request fence is unavailable; every route except this one answers 503 HOST_SECURITY_UNAVAILABLE',
      },
    });
  }

  /** @returns {Promise<any>|undefined} */
  async route(method, segments, ctx) {
    const [head, second, third] = segments;

    if (!head) {
      if (method !== 'GET') return this.methodNotAllowed(['GET']);
      return this.bootstrap();
    }

    switch (head) {
      case 'status': {
        rejectMethod(method, ['GET']);
        // `/status` is the support surface: it must be pasteable into an issue, so
        // upstream URLs, query strings, absolute hosts and local paths are
        // redacted while ids, health and counters stay readable (0.7.0).
        return sanitizeStatus({
          ...this.service.status(),
          ai: this.ai.status(),
          watchlist: this.watchlist.info(),
          userId: this.identityView().id,
          identity: this.identityView(),
          fenceFailures: this.fenceFailures,
          settings: await this.settingsSnapshot(),
          config: this.publicConfig(),
          limits: this.limitsView(),
        });
      }

      case 'bootstrap':
        rejectMethod(method, ['GET']);
        return this.bootstrap();

      // UI preferences (display language). GET is read-only; PATCH/PUT/POST
      // change the stored value so the choice survives a restart.
      case 'settings': {
        if (method === 'GET') {
          // Without an identity there is no per-user row to read, and the shipped
          // default is the honest answer (round-3 P1⑦).
          if (!this.hasIdentity()) {
            return { userId: null, lang: DEFAULT_LANG, supported: SUPPORTED_LANGS.slice(), defaultLang: DEFAULT_LANG, persisted: false, reason: 'no per-user identity on this deployment' };
          }
          return this.settingsSnapshot();
        }
        if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
          const body = (await readJsonBody(ctx.req)) || {};
          const store = this.settings;
          if (!store || typeof store.patch !== 'function') {
            throw new TradingError(CODES.STORAGE_ERROR, 'the settings store is unavailable');
          }
          const userId = this.requireIdentity('store a preference');
          const saved = await store.patch(userId, { lang: langFrom(body) });
          return { ...saved, supported: SUPPORTED_LANGS.slice(), defaultLang: DEFAULT_LANG };
        }
        return this.methodNotAllowed(['GET', 'PATCH', 'PUT', 'POST']);
      }

      case 'indices':
      case 'index': {
        rejectMethod(method, ['GET']);
        const market = normaliseMarket(ctx.query.get('market'));
        const requested = String(ctx.query.get('symbols') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        // `market=CRYPTO` asks for the coin spotlight: coins are quoted
        // securities, not indices, and they go through the crypto chain.
        if (market === 'CRYPTO') return this.service.listCrypto({ force: ctx.force, symbols: requested });
        return this.service.listIndices({ force: ctx.force, symbols: requested, market });
      }

      // Crypto spotlight (0.5.0), the coin counterpart of `/indices`: the top
      // coins on their USDT pairs, so the crypto market has a strip of its own.
      case 'crypto':
      case 'coins': {
        rejectMethod(method, ['GET']);
        const requested = String(ctx.query.get('symbols') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return this.service.listCrypto({ force: ctx.force, symbols: requested });
      }

      // Complete US/HK listing table (0.4.0): browse it page by page, search it
      // locally, or start the background walk. Without this, "Add Stock" could
      // only reach the few hundred names the search endpoint happens to rank.
      case 'universe':
      case 'listings': {
        if (method === 'GET') {
          return this.service.universePage({
            market: normaliseMarket(ctx.query.get('market')) || 'US',
            board: ctx.query.get('board') || undefined,
            page: ctx.query.get('page') || undefined,
            size: ctx.query.get('size') || undefined,
            q: ctx.query.get('q') || undefined,
            force: ctx.force,
          });
        }
        if (method === 'POST') {
          const body = (await readJsonBody(ctx.req)) || {};
          // A full walk fans out over every board of every market: it is quota'd,
          // single-flight, budgeted and cancellable (0.7.0).
          return this.expensive('universeRefresh', async () => {
            const kickoff = await this.service.universeRefresh({
              market: normaliseMarket(body.market || ctx.query.get('market')) || undefined,
              board: body.board || ctx.query.get('board') || undefined,
              signal: ctx.signal,
            });
            // Flat answer: { started, running, already?, status }.
            return { ...kickoff, budgetMs: UNIVERSE_POLICY.budgetMs, status: this.service.universeStatus() };
          });
        }
        if (method === 'DELETE') {
          const result = this.service.universeCancel('cancelled by the user');
          return { ...result, status: this.service.universeStatus() };
        }
        return this.methodNotAllowed(['GET', 'POST', 'DELETE']);
      }

      case 'search': {
        rejectMethod(method, ['GET']);
        const q = ctx.query.get('q') ?? ctx.query.get('query') ?? '';
        const market = normaliseMarket(ctx.query.get('market'));
        return this.service.search(q, market, { force: ctx.force });
      }

      case 'quote': {
        rejectMethod(method, ['GET']);
        return this.service.getQuote(requireSegment(second, 'symbol'), {
          force: ctx.force,
          market: normaliseMarket(ctx.query.get('market')),
        });
      }

      case 'candles':
      case 'chart': {
        rejectMethod(method, ['GET']);
        const hint = normaliseMarket(ctx.query.get('market'));
        const value = await this.service.getCandles(
          requireSegment(second, 'symbol'),
          ctx.query.get('interval') ?? undefined,
          ctx.query.get('range') ?? undefined,
          { force: ctx.force, market: hint },
        );
        // The chart needs both the bars and the §31 technical block in one round
        // trip; technicals are always computed from 1d/1y bars.
        const technical = await this.service.getTechnicals(requireSegment(second, 'symbol'), { force: ctx.force, market: hint });
        return { ...value, technical: technical.data, technicalMeta: technical.meta };
      }

      case 'profile': {
        rejectMethod(method, ['GET']);
        return this.service.getProfile(requireSegment(second, 'symbol'), {
          force: ctx.force,
          market: normaliseMarket(ctx.query.get('market')),
        });
      }

      case 'technical':
      case 'indicators': {
        rejectMethod(method, ['GET']);
        return this.service.getTechnicals(requireSegment(second, 'symbol'), {
          force: ctx.force,
          market: normaliseMarket(ctx.query.get('market')),
        });
      }

      case 'analyze': {
        rejectMethod(method, ['POST']);
        const body = (await readJsonBody(ctx.req)) || {};
        return this.expensive('analyze', async () => {
          const snapshot = await this.snapshotFor(requireSegment(second, 'symbol'), {
            force: ctx.force,
            market: normaliseMarket(body.market || ctx.query.get('market')),
          });
          const result = await this.ai.analyzeStock(snapshot, {
            signal: ctx.signal,
            lang: langFrom(body) ?? (await this.storedLang()),
            question: typeof body.question === 'string' ? body.question : undefined,
          });
          this.service.counters.analyses += 1;
          return { symbol: snapshot.symbol, ...result };
        });
      }

      case 'watchlist':
        return this.watchlistRoutes(method, second, third, ctx);

      default:
        return undefined;
    }
  }

  async watchlistRoutes(method, second, third, ctx) {
    // Every watchlist route is per-user storage, so a trustworthy identity is a
    // precondition, not a default (round-3 P1⑦).
    const userId = this.requireIdentity('read or change the watchlist');

    if (!second) {
      if (method === 'GET') {
        const rows = await this.watchlist.list(userId);
        if (!isTruthy(ctx.query.get('quotes'))) return { userId, items: rows, count: rows.length };
        const items = await this.attachQuotes(rows, { force: ctx.force });
        return { userId, items, count: items.length };
      }
      if (method === 'POST') {
        const body = await readJsonBody(ctx.req);
        const symbol = body.symbol ?? body.query ?? body.code;
        if (!symbol) throw new TradingError(CODES.BAD_REQUEST, 'POST /watchlist requires a "symbol" field');
        const { symbol: canonical, market } = this.service.resolveSymbol(symbol, body.market);
        let record = { symbol: canonical, market };
        try {
          const quote = await this.service.getQuote(canonical, { force: ctx.force });
          record = { ...record, name: quote.data.name ?? null, nameZh: quote.data.nameZh ?? null, exchange: quote.data.exchange ?? null, currency: quote.data.currency ?? null };
        } catch (err) {
          // The symbol is validated by the service; a temporarily unreachable
          // provider must not block adding it to the list.
          this.logger?.debug?.(`watchlist: quote lookup for ${canonical} failed while adding: ${err && err.message}`);
        }
        const { item, created } = await this.watchlist.add(userId, { ...record, ...pick(body, ['name', 'nameZh', 'exchange', 'currency']) });
        return { created, item };
      }
      return this.methodNotAllowed(['GET', 'POST']);
    }

    if (second === 'order') {
      rejectMethod(method, ['PATCH', 'PUT', 'POST']);
      const body = await readJsonBody(ctx.req);
      const order = body.symbols ?? body.order ?? body.items;
      const items = await this.watchlist.reorder(userId, order);
      return { items, count: items.length };
    }

    if (second === 'analyze') {
      rejectMethod(method, ['POST']);
      const body = (await readJsonBody(ctx.req)) || {};
      // The brief is written in the language the user is reading the panel in.
      const lang = langFrom(body) ?? (await this.storedLang());
      return this.expensive('brief', async () => {
        const rows = await this.watchlist.list(userId);
        // Rows (not bare symbols) so each entry keeps its market hint.
        const requested = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : rows;
        if (!requested.length) throw new TradingError(CODES.BAD_REQUEST, 'the watchlist is empty; add a stock before requesting a brief');
        const stocks = await this.collectForBrief(requested.slice(0, 20), { force: ctx.force });
        const snapshot = { stocks, asOf: Date.now() };
        const result = await this.ai.watchlistBrief(snapshot, { signal: ctx.signal, lang });
        this.service.counters.briefs += 1;
        return result;
      });
    }

    const symbol = second;
    if (method === 'DELETE') {
      const result = await this.watchlist.remove(userId, symbol);
      return result;
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = (await readJsonBody(ctx.req)) || {};
      if (body.isFavorite === undefined && body.favorite === undefined) {
        throw new TradingError(CODES.BAD_REQUEST, 'PATCH /watchlist/:symbol expects {"isFavorite":true|false}');
      }
      const item = await this.watchlist.setFavorite(userId, symbol, body.isFavorite ?? body.favorite);
      return { item };
    }
    if (method === 'GET') {
      const item = await this.watchlist.get(userId, symbol);
      if (!item) throw new TradingError(CODES.NOT_FOUND, `${symbol} is not in the watchlist`);
      return { item };
    }
    return this.methodNotAllowed(['GET', 'DELETE', 'PATCH']);
  }

  // ------------------------------------------------------------------ helpers

  /** One round trip for the first paint: watchlist + quotes + seed pool + status. */
  async bootstrap() {
    const identity = this.identityView();
    // Without an identity there is no per-user watchlist to read. The panel gets
    // an empty list plus the reason instead of someone else's rows (round-3 P1⑦).
    const userId = identity.id;
    const rows = userId ? await this.watchlist.list(userId) : [];
    const items = await this.attachQuotes(rows);
    const settings = userId
      ? await this.settingsSnapshot(userId)
      : { userId: null, lang: DEFAULT_LANG, supported: SUPPORTED_LANGS.slice(), defaultLang: DEFAULT_LANG, persisted: false };
    return {
      userId,
      identity,
      items,
      count: items.length,
      recommendations: RECOMMENDED_STARTERS,
      backend: this.watchlist.info(),
      status: this.service.status(),
      ai: this.ai.status(),
      settings,
      markets: MARKETS.slice(),
      marketLabels: { ...MARKET_LABELS },
      stockMarkets: STOCK_MARKETS.slice(),
      cryptoSpotlight: CRYPTO_SPOTLIGHT.slice(),
      disclaimer: DISCLAIMER,
    };
  }

  /**
   * Preferences for the current user. Always answers with a usable object even
   * when no settings store is wired (the panel then just follows the DSH
   * interface language).
   */
  async settingsSnapshot(userId = this.identityView().id) {
    const store = this.settings;
    if (!userId) {
      // No identity: never read a shared bucket. Report the shipped default.
      return {
        userId: null,
        lang: DEFAULT_LANG,
        supported: SUPPORTED_LANGS.slice(),
        defaultLang: DEFAULT_LANG,
        updatedAt: null,
        storage: 'no-identity',
      };
    }
    if (!store || typeof store.get !== 'function') {
      return {
        userId,
        lang: DEFAULT_LANG,
        supported: SUPPORTED_LANGS.slice(),
        defaultLang: DEFAULT_LANG,
        updatedAt: null,
        storage: 'unavailable',
      };
    }
    try {
      const value = await store.get(userId);
      return {
        ...value,
        supported: SUPPORTED_LANGS.slice(),
        defaultLang: DEFAULT_LANG,
      };
    } catch (err) {
      // Preferences are cosmetic: a broken store must not break the panel (§44).
      this.logger?.warn?.(`trading-mode: settings read failed: ${(err && err.message) || err}`);
      return {
        userId,
        lang: DEFAULT_LANG,
        supported: SUPPORTED_LANGS.slice(),
        defaultLang: DEFAULT_LANG,
        updatedAt: null,
        storage: 'error',
      };
    }
  }

  /** Language last stored for this user (AI fallback when the client omits it). */
  async storedLang() {
    const snapshot = await this.settingsSnapshot();
    return normalizeLang(snapshot && snapshot.lang) || DEFAULT_LANG;
  }

  /** Attach a quote envelope to each watchlist row, isolating per-symbol failures. */
  async attachQuotes(rows, opts = {}) {
    return Promise.all(
      rows.map(async (row) => {
        try {
          // The stored row carries its own market: a coin symbol like `BTC` is
          // otherwise read back as a US ticker (§ parseSymbol).
          const quote = await this.service.getQuote(row.symbol, { force: opts.force, market: row.market });
          return { ...row, quote: quote.data, quoteMeta: quote.meta };
        } catch (err) {
          const error = toTradingError(err);
          return { ...row, quote: null, quoteMeta: null, error: error.toJSON() };
        }
      }),
    );
  }

  /** Quotes + technicals + profile for one symbol, for the AI layer. */
  async snapshotFor(symbol, opts = {}) {
    const { symbol: canonical, market } = this.service.resolveSymbol(symbol, opts.market);
    const [quote, profile, technical, candles] = await Promise.all([
      this.service.getQuote(canonical, opts).catch(swallow),
      this.service.getProfile(canonical, opts).catch(swallow),
      this.service.getTechnicals(canonical, opts).catch(swallow),
      this.service.getCandles(canonical, '1d', '6mo', opts).catch(swallow),
    ]);
    if (!quote) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `no market data is available for ${canonical}, so it cannot be analysed`);
    }
    const asOf = technical?.data?.asOf ?? quote.data.timestamp ?? Date.now();
    const stale = Boolean(quote.meta?.stale) || Boolean(technical?.meta?.stale);
    const dataAgeMs = recencyAge(asOf);
    return {
      symbol: canonical,
      market,
      quote: quote.data,
      quoteMeta: quote.meta,
      profile: profile ? profile.data : null,
      technical: technical ? technical.data : null,
      technicalMeta: technical ? technical.meta : null,
      candles: candles ? candles.data.candles : [],
      asOf,
      stale,
      /** 0.7.0: the AI layer must know how old the data it reasons about is. */
      dataAgeMs,
      staleReason: stale ? staleReasonFor({ quote, technical }) : null,
      marketOpen: quote.meta?.marketOpen ?? null,
    };
  }

  async collectForBrief(symbols, opts = {}) {
    return Promise.all(
      // Entries may be plain symbols or watchlist rows ({symbol, market}): the
      // stored market is what keeps a coin from being read back as a ticker.
      symbols.map(async (entry) => {
        const symbol = typeof entry === 'string' ? entry : entry && entry.symbol;
        const hint = typeof entry === 'string' ? undefined : entry && entry.market;
        try {
          const { symbol: canonical, market } = this.service.resolveSymbol(symbol, hint || opts.market);
          const [quote, technical] = await Promise.all([
            this.service.getQuote(canonical, opts).catch(swallow),
            this.service.getTechnicals(canonical, opts).catch(swallow),
          ]);
          return {
            symbol: canonical,
            market,
            quote: quote ? quote.data : null,
            technical: technical ? technical.data : null,
            stale: Boolean(quote?.meta?.stale) || Boolean(technical?.meta?.stale),
            error: quote && technical ? null : 'partial data',
          };
        } catch (err) {
          return { symbol, market: null, quote: null, technical: null, stale: true, error: toTradingError(err).message };
        }
      }),
    );
  }

  publicConfig() {
    const chain = (market) => {
      const cfg = marketConfig(market);
      return (cfg && cfg.chain ? cfg.chain : []).join(' → ');
    };
    return {
      markets: MARKETS.slice(),
      marketLabels: { ...MARKET_LABELS },
      stockMarkets: STOCK_MARKETS.slice(),
      cryptoSpotlight: CRYPTO_SPOTLIGHT.slice(),
      primaryProvider: Object.fromEntries(MARKETS.map((m) => [m, chain(m)])),
      // The active chains (defaults or the user's `providers` override) and the
      // transport mode, so "which source will this use" is answerable from the
      // API instead of from the source (0.6.0, tasks B1/B2).
      providerChains: Object.fromEntries(MARKETS.map((m) => [m, marketConfig(m).chain.slice()])),
      providerChainProblems: providerChainProblems(),
      networkMode: networkMode(),
      historicalFallback: Object.fromEntries(MARKETS.map((m) => [m, (marketConfig(m) || {}).historicalFallback || null])),
      aiModel: this.ai.status().route,
      cacheBackend: this.service.cache.backendName,
      watchlistBackend: this.watchlist.backend,
      // Task B3: state where the user's own data lives, and what is *not* promised.
      // Both stores are profile-local JSON (or the host storage domain when it is
      // present), keyed by DSH user id; neither is synchronised between machines.
      storage: {
        watchlist: this.watchlist.backend,
        settings: this.settings && typeof this.settings.get === 'function' ? 'host' : 'file',
        scope: 'profile-local',
        crossDevice: false,
        note: 'Watchlist and preferences live in the local DSH profile on this machine, keyed by DSH user id; cross-device sync is not provided by this plugin.',
      },
      languages: SUPPORTED_LANGS.slice(),
      defaultLang: DEFAULT_LANG,
    };
  }

  methodNotAllowed(allowed) {
    throw new TradingError(CODES.BAD_REQUEST, `method not allowed here; use ${allowed.join(', ')}`);
  }
}

// ------------------------------------------------------------------ utilities

function respond(res, status, payload, headers) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* the socket is already gone */
    }
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
    ...(headers || {}),
  });
  res.end(body);
}

/** Age of the freshest number in a snapshot, in ms (null when unusable). */
function recencyAge(asOf) {
  const ts = Number(asOf);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  // Provider timestamps arrive in seconds or milliseconds; normalise first.
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return Math.max(0, Date.now() - ms);
}

function staleReasonFor({ quote, technical }) {
  const reasons = [];
  if (quote && quote.meta && quote.meta.stale) reasons.push(`quote served from cache (${quote.meta.staleReason || 'upstream unavailable'})`);
  if (technical && technical.meta && technical.meta.stale) reasons.push('candles served from cache');
  return reasons.length ? reasons.join('; ') : null;
}

/**
 * Fields whose *values* may name an upstream host, URL or local path. Only these
 * are scrubbed, so identifiers such as `eastmoney`, `BTC-USD` or `600519.SH`
 * survive untouched.
 */
const DIAGNOSTIC_KEYS = new Set([
  'lastError',
  'error',
  'errors',
  'message',
  'reason',
  'detail',
  'base',
  'endpoint',
  'endpoints',
  'url',
  'urls',
  'host',
  'hosts',
  'path',
  'filePath',
  'nextUrl',
]);

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|co|jp|hk|us|de|uk|tv|info|biz)\b/gi;
const ABSOLUTE_PATH_WIN = /\b[A-Za-z]:\\[^\s"'<>]*/g;
const ABSOLUTE_PATH_NIX = /(?:^|\s)\/(?:home|Users|mnt|opt|srv|var)\/[^\s"'<>]*/g;

/** Strip upstream URLs, hosts, IPs and absolute paths out of one diagnostic string. */
export function redactDiagnostic(value) {
  if (typeof value !== 'string' || !value) return value;
  // The origin is kept (it names which upstream failed) but the path, query and
  // credentials go. Origins are parked behind digit-only placeholders first so
  // the bare-host rule below cannot eat them; the final pass restores them.
  const origins = [];
  const parked = value.replace(URL_IN_TEXT, (match) => {
    try {
      origins.push(new URL(match).origin);
      return `\u0000${origins.length - 1}\u0000`;
    } catch {
      return '[redacted-url]';
    }
  });
  return parked
    .replace(IPV4, '[redacted-ip]')
    .replace(BARE_HOST, '[redacted-host]')
    .replace(ABSOLUTE_PATH_WIN, (match) => `…/${match.split(/[\\/]/).pop()}`)
    .replace(ABSOLUTE_PATH_NIX, (match) => {
      const tail = match.trim().split(/[\\/]/).pop();
      return `${match.match(/^\s*/)[0]}…/${tail}`;
    })
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `${origins[Number(index)]}/…`);
}

/** Deep-copy a payload, scrubbing the diagnostic fields listed above. */
export function sanitizeStatus(value, key = null) {
  if (Array.isArray(value)) return value.map((item) => sanitizeStatus(item, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = sanitizeStatus(child, childKey);
    return out;
  }
  if (typeof value === 'string' && key && DIAGNOSTIC_KEYS.has(key)) return redactDiagnostic(value);
  return value;
}

function rejectMethod(method, allowed) {
  if (!allowed.includes(method)) {
    throw new TradingError(CODES.BAD_REQUEST, `${method} is not supported here; use ${allowed.join(', ')}`);
  }
}

function requireSegment(segment, name) {
  if (!segment) throw new TradingError(CODES.BAD_REQUEST, `this endpoint requires a ${name} in the path`);
  return segment;
}

function normaliseMarket(value) {
  if (!value) return undefined;
  const market = String(value).trim().toUpperCase();
  if (MARKETS.includes(market)) return market;
  throw new TradingError(CODES.UNSUPPORTED_MARKET, `market ${value} is not supported (${MARKETS.join(', ')})`);
}

/**
 * Pull a language request out of a JSON body.
 * `undefined` means "not specified" (keep whatever the user already stored);
 * an explicitly unsupported value is a client bug and is rejected.
 */
function langFrom(source) {
  if (!source || typeof source !== 'object') return undefined;
  const raw = source.lang !== undefined ? source.lang : source.locale !== undefined ? source.locale : undefined;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const lang = normalizeLang(raw);
  if (!lang) {
    throw new TradingError(
      CODES.BAD_REQUEST,
      `unsupported language ${JSON.stringify(raw)}; supported languages are ${SUPPORTED_LANGS.join(', ')}`,
    );
  }
  return lang;
}

async function readJsonBody(req) {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new TradingError(CODES.BAD_REQUEST, 'request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new TradingError(CODES.BAD_REQUEST, `request body is not valid JSON: ${err && err.message}`);
  }
}

/** Abort the work when the browser goes away (§44: no orphaned LLM calls). */
function abortSignalFor(req) {
  const controller = new AbortController();
  req?.once?.('close', () => {
    if (!req.complete) controller.abort();
  });
  return controller.signal;
}

function isTruthy(value) {
  if (value === null || value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * True only for a peer that is on this machine's loopback interface. Used by the
 * one explicit debugging exception (`security.allowUnfencedLoopback`), never to
 * open the API to the network.
 */
function isLoopbackPeer(req) {
  const address = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    /^127\./.test(address)
  );
}

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  return out;
}

/** Absent optional data disappears instead of failing the whole snapshot. */
async function swallow(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export { PREFIX as TRADING_API_PREFIX, STATUS_BY_CODE };