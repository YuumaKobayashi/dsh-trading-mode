/**
 * MarketDataService — the single seam between the plugin's business logic and
 * the outside world (spec §4/§10/§13/§43/§44).
 *
 * Responsibilities:
 *  - validate + normalise every request (symbols, intervals, ranges);
 *  - serve through the cache with the right TTL (§41/§42);
 *  - delegate upstream work to the router, never to a provider directly (§16);
 *  - decorate every payload with source / timestamp / delaySeconds / stale (§20);
 *  - turn any unrecoverable condition into a TradingError, never into empty data
 *    (§43 "Data unavailable", §77.27 no silent failure).
 */

import { CACHE_KEYS, CRYPTO_SPOTLIGHT, DISCLAIMER, INTERVALS, MARKETS, RANGES, RANGE_CONFIG, STOCK_MARKETS, marketConfig, minBars } from './config.js';
import { CODES, TradingError, badRequest, toTradingError } from './errors.js';
import { MarketDataCache } from './cache.js';
import { ProviderHealth, healthScope } from './http.js';
import { computeTechnicals } from './indicators.js';
import { DEFAULT_INDEX_SYMBOLS, lookupIndex, publicIndex, searchIndices } from './indices.js';
import { buildProviders } from './providers/index.js';
import { MarketDataRouter } from './router.js';
import { makeProfile } from './schema.js';
import { gradeFreshness, marketStatus } from './sessions.js';
import { currencyOf, parseSymbol } from './symbols.js';
import { SymbolDirectory, splitNames } from './directory.js';

/** Accepted range spellings → canonical range (§49 uses `6m`, §27 labels `6M`). */
const RANGE_ALIASES = { '1d': '1d', '5d': '5d', '1m': '1mo', '1mo': '1mo', '3m': '3mo', '3mo': '3mo', '6m': '6mo', '6mo': '6mo', '1y': '1y', '5y': '5y', max: 'max' };
/** Accepted interval spellings → canonical interval. */
const INTERVAL_ALIASES = { '5m': '5m', '5min': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '60m': '1h', '1d': '1d', day: '1d', daily: '1d', '1wk': '1wk', '1w': '1wk', week: '1wk', weekly: '1wk' };

export class MarketDataService {
  /**
   * @param {{logger?: any, cachePersist?: any}} [opts]
   */
  constructor(opts = {}) {
    this.logger = opts.logger || null;
    this.health = new ProviderHealth();
    this.providers = buildProviders({ logger: this.logger });
    this.router = new MarketDataRouter({ providers: this.providers, health: this.health, logger: this.logger });
    this.cache = new MarketDataCache({ persist: opts.cachePersist || null, logger: this.logger });
    this.directory = new SymbolDirectory({ logger: this.logger });
    /**
     * Full listing universe (0.4.0, multi-feed since 0.4.1). Optional: without it
     * the panel still works, it just cannot browse every listing. The feeds are
     * chosen by capability, not by name, so a future licensed feed only has to
     * expose `listSecurities` + `boards` to join the chain.
     */
    this.universe = opts.universe || null;
    if (this.universe && typeof this.universe.setProviders === 'function') {
      const listing = Array.from(this.providers.values()).filter((p) => typeof p.listSecurities === 'function');
      this.universe.setProviders(listing);
    } else if (this.universe && typeof this.universe.setProvider === 'function') {
      const provider = Array.from(this.providers.values()).find(
        (p) => typeof p.listSecurities === 'function' && p.markets.includes('US'),
      );
      this.universe.setProvider(provider || null);
    }
    /** Counters for the status endpoint. */
    this.counters = { quotes: 0, candleRequests: 0, analyses: 0, briefs: 0, searches: 0, degraded: 0 };
  }

  async init() {
    await this.cache.hydrate();
    return this;
  }

  // ------------------------------------------------------------------ universe

  /**
   * Browse or locally search the full US/HK listing table (0.4.0).
   *
   * `q` switches the call into local-search mode over everything fetched so far;
   * otherwise it is a plain page of the provider's bulk listing feed.
   */
  async universePage(opts = {}) {
    if (!this.universe) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, 'the full listing universe is not available in this session');
    }
    const market = opts.market && MARKETS.includes(opts.market) ? opts.market : 'US';
    const query = typeof opts.q === 'string' ? opts.q.trim() : '';
    const size = Math.max(1, Math.min(200, Math.trunc(Number(opts.size)) || 50));
    if (query) {
      const rows = this.universe.search(query, { market, limit: size });
      return {
        mode: 'search',
        market,
        query,
        rows,
        total: rows.length,
        page: 1,
        size,
        pages: null,
        boards: this.universe.boards(market),
        status: this.universe.status(),
      };
    }
    const result = await this.universe.page({
      market,
      board: opts.board,
      page: opts.page,
      size,
      force: Boolean(opts.force),
    });
    return { mode: 'browse', ...result, query: null, boards: this.universe.boards(market), status: this.universe.status() };
  }

  /** Kick off the background walk of a whole market (or one board). */
  async universeRefresh({ market, board, signal } = {}) {
    if (!this.universe) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, 'the full listing universe is not available in this session');
    }
    if (!this.universe.providers || !this.universe.providers.length) {
      throw new TradingError(CODES.NO_PROVIDER, 'no provider can list the security universe');
    }
    return this.universe.refresh({ market, board, signal });
  }

  /** Stop the walk in flight (0.7.0). Absorbed rows are kept. */
  universeCancel(reason = 'cancelled by the user') {
    if (!this.universe || typeof this.universe.cancel !== 'function') {
      throw new TradingError(CODES.DATA_UNAVAILABLE, 'the full listing universe is not available in this session');
    }
    return this.universe.cancel(reason);
  }

  universeStatus() {
    return this.universe ? this.universe.status() : null;
  }

  // ---------------------------------------------------------------- validation

  /** @returns {{symbol: string, market: string}} */
  resolveSymbol(input, hint) {
    if (typeof input !== 'string' || !input.trim()) throw badRequest('a symbol is required');
    let parsed;
    try {
      parsed = parseSymbol(input, hint);
    } catch (err) {
      throw new TradingError(CODES.INVALID_SYMBOL, err && err.message ? err.message : `invalid symbol: ${input}`);
    }
    if (!MARKETS.includes(parsed.market)) {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `market ${parsed.market} is not supported`);
    }
    return { symbol: parsed.symbol, market: parsed.market };
  }

  resolveRange(input, interval) {
    if (input === undefined || input === null || input === '') {
      return interval ? defaultRangeFor(interval) : '6mo';
    }
    const key = String(input).trim().toLowerCase();
    const range = RANGE_ALIASES[key];
    if (!range) throw badRequest(`unsupported range "${input}" (expected one of ${RANGES.join(', ')})`);
    return range;
  }

  resolveInterval(input, range) {
    if (input === undefined || input === null || input === '') return RANGE_CONFIG[range].defaultInterval;
    const key = String(input).trim().toLowerCase();
    const interval = INTERVAL_ALIASES[key];
    if (!interval) throw badRequest(`unsupported interval "${input}" (expected one of ${INTERVALS.join(', ')})`);
    return interval;
  }

  // ------------------------------------------------------------------- reading

  /**
   * Realtime-ish quote (§18/§20).
   * @param {string} symbol
   * @param {{force?: boolean, market?: string}} [opts] `market` is a parse hint:
   *   a bare crypto base (`BTC`) needs it, because `SOL`/`ADA` are also US tickers.
   */
  async getQuote(symbol, opts = {}) {
    const { symbol: canonical, market } = this.resolveSymbol(symbol, opts.market);
    const result = await this.cache.through(
      CACHE_KEYS.quote(canonical),
      { kind: 'quote', market, force: opts.force, allowStale: true },
      async () => {
        const run = await this.router.run({
          feature: 'quote',
          market,
          symbol: canonical,
          fn: (provider) => provider.getQuote(canonical),
        });
        const enriched = this.enrich(mergeNames(run.value, this.directory.lookup(canonical, market)));
        enriched.provider = run.provider;
        return enriched;
      },
    );
    this.counters.quotes += 1;
    if (result.stale) this.counters.degraded += 1;
    return this.envelope(result.value, result);
  }

  /** Candles for one interval/range pair (§19, §28). */
  async getCandles(symbol, intervalInput, rangeInput, opts = {}) {
    const { symbol: canonical, market } = this.resolveSymbol(symbol, opts.market);
    const range = this.resolveRange(rangeInput, intervalInput);
    const interval = this.resolveInterval(intervalInput, range);
    const result = await this.cache.through(
      CACHE_KEYS.candles(canonical, interval, range),
      { kind: 'candles', market, force: opts.force, allowStale: true },
      async () => {
        const floor = minBars(range, interval, market);
        const run = await this.router.run({
          feature: 'candles',
          market,
          interval,
          symbol: canonical,
          fn: (provider) => provider.getCandles(canonical, interval, range),
          // A provider that answers with a token handful of bars is not serving
          // this range (measured: tencent gives two US daily rows for a 6-month
          // request) — treat it as a failed attempt and let the chain continue.
          validate: (bars) => Array.isArray(bars) && bars.length >= floor,
          sizeOf: (bars) => (Array.isArray(bars) ? bars.length : 0),
        });
        if (run.degraded) this.counters.degraded += 1;
        return {
          symbol: canonical,
          market,
          interval,
          range,
          candles: run.value,
          source: run.provider,
          provider: run.provider,
          ...(run.degraded ? { degraded: true, minBars: floor } : {}),
        };
      },
    );
    this.counters.candleRequests += 1;
    return this.envelope(result.value, result);
  }

  /** Company profile / basic information (§5). */
  async getProfile(symbol, opts = {}) {
    const { symbol: canonical, market } = this.resolveSymbol(symbol, opts.market);
    // An index has no company profile. Answering it from the curated directory
    // keeps the detail view complete without inventing an upstream call (and
    // without a failed request that would trip a provider's breaker).
    const index = lookupIndex(canonical);
    if (index) {
      const profile = makeProfile({
        symbol: index.symbol,
        market: index.market,
        name: index.name,
        nameZh: index.nameZh,
        exchange: index.exchange,
        currency: index.currency,
        description: `${index.name} (${index.symbol}) is a market index; values are index points, not a tradable security.`,
        source: 'directory',
        timestamp: Date.now(),
      });
      return this.envelope(profile, { cached: false, provider: 'directory' });
    }
    // A crypto pair has no issuer to describe, but coinlore does publish a written
    // profile (name, rank, market capitalisation), so ask the providers first and
    // keep the directory stub as the safety net for the pairs it does not cover.
    if (market === 'CRYPTO') {
      const parsed = parseSymbol(canonical, 'CRYPTO');
      const quote = parsed.quote || 'USDT';
      const result = await this.cache.through(
        CACHE_KEYS.profile(canonical),
        { kind: 'profile', market, force: opts.force, allowStale: true },
        async () => {
          try {
            const run = await this.router.run({
              feature: 'profile',
              market,
              symbol: canonical,
              fn: (provider) => provider.getCompanyProfile(canonical),
            });
            if (run && run.value) {
              const merged = mergeNames(run.value, this.directory.lookup(canonical, 'CRYPTO'));
              merged.market = 'CRYPTO';
              merged.exchange = merged.exchange || 'CRYPTO';
              if (!merged.currency || merged.currency === 'USD') merged.currency = quote;
              if (!merged.description) merged.description = cryptoProfileNote(canonical, merged.currency);
              merged.source = merged.source || 'providers';
              return merged;
            }
          } catch (err) {
            this.logger.debug?.(`crypto profile for ${canonical} fell back to the directory: ${err.message}`);
          }
          return cryptoStubProfile(canonical, quote, this.directory.lookup(canonical, 'CRYPTO'));
        },
      );
      return this.envelope(result.value, result);
    }
    const result = await this.cache.through(
      CACHE_KEYS.profile(canonical),
      { kind: 'profile', market, force: opts.force, allowStale: true },
      async () => {
        const run = await this.router.run({
          feature: 'profile',
          market,
          symbol: canonical,
          fn: (provider) => provider.getCompanyProfile(canonical),
        });
        return mergeNames(run.value, this.directory.lookup(canonical, market));
      },
    );
    return this.envelope(result.value, result);
  }

  /**
   * Technical indicators (§29/§31).
   *
   * Always computed from a year of daily bars, regardless of the chart range the
   * user is looking at, so MA200 and the 52-week range are actually available.
   */
  async getTechnicals(symbol, opts = {}) {
    const { symbol: canonical, market } = this.resolveSymbol(symbol, opts.market);
    const base = await this.getCandles(canonical, '1d', '1y', opts);
    const technical = computeTechnicals(base.data.candles, { symbol: canonical, interval: '1d', range: '1y' });
    return {
      data: technical,
      meta: {
        ...base.meta,
        interval: '1d',
        range: '1y',
        /** 0.7.0: how much history the indicators rest on, so the UI can warn. */
        quality: technical.quality,
      },
    };
  }

  /** Symbol search (§22/§23). Providers first; the local directory always contributes. */
  async search(query, market, opts = {}) {
    const q = String(query || '').trim();
    if (!q) throw badRequest('a search query is required');
    if (market && !MARKETS.includes(market)) throw new TradingError(CODES.UNSUPPORTED_MARKET, `market ${market} is not supported`);
    const cacheKey = CACHE_KEYS.search(market || 'ALL', q);
    const result = await this.cache.through(
      cacheKey,
      { kind: 'search', market: market || undefined, force: opts.force, allowStale: true, ttlMs: undefined },
      async () => {
        const remote = await this.searchRemote(q, market);
        const local = this.directory.search(q, market, 8);
        // Anything the bulk universe already knows about: this is what finally
        // makes an arbitrary US/HK listing findable (0.4.0).
        const universeHits = this.universe ? this.universe.search(q, { market, limit: 12 }) : [];
        // Indices come first so they win the stable-sort tie-break in the ranker;
        // a search for `VIX` or `纳斯达克` must find the index itself, not only
        // the leveraged products that track it.
        const indices = searchIndices(q, market || undefined, 4);
        const merged = [];
        const seen = new Set();
        for (const record of [...indices, ...remote, ...universeHits, ...local]) {
          if (!record || seen.has(record.symbol)) continue;
          seen.add(record.symbol);
          merged.push(record);
        }
        // Rank before truncating: the upstream suggest endpoint answers a
        // Chinese query with every product whose name contains it (a search for
        // 阿里 must not put 阿里健康 above 9988.HK, and NVIDIA must not put a
        // leveraged HK ETF first).
        const enriched = this.directory.enrich(merged);
        const ranked = rankSearchResults(q, enriched, this.directory).slice(0, 12);
        const source = [remote.length ? 'providers' : null, universeHits.length ? 'universe' : null, 'directory'].filter(Boolean).join('+');
        return { query: q, market: market || null, results: ranked, source };
      },
    );
    this.counters.searches += 1;
    // A search is never "stale" in the freshness sense: say when it was answered.
    return this.envelope(result.value, result, { freshnessKind: 'search' });
  }

  /**
   * Ask every search-capable provider in chain order and keep the first answer.
   * A provider that cannot search simply does not participate (§77.24: the
   * absence is handled by the abstraction, not by an `if (yahoo)` in the caller).
   *
   * The crypto chain is an additional pass rather than a competitor: a bare
   * `BTC` or `SOL` is a plausible stock ticker too, so the stock markets still
   * answer first, but a search that never lists the coin is a dead end. The pass
   * is answerable from the providers' coin caches, so it is cheap.
   */
  async searchRemote(query, market) {
    const stockMarkets = market ? (market === 'CRYPTO' ? [] : [market]) : STOCK_MARKETS;
    const out = [];
    const seen = new Set();
    const push = (rows) => {
      for (const row of rows || []) {
        if (!row || !row.symbol || seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        out.push(row);
      }
    };
    for (const mkt of stockMarkets) {
      const rows = await this.searchChain(query, mkt, market);
      push(rows);
      // One answering market is enough for an unscoped search; an explicitly
      // requested market never falls through to another one.
      if (rows.length) break;
    }
    if (!market || market === 'CRYPTO') {
      push(await this.searchChain(query, 'CRYPTO', market || undefined));
    }
    return out;
  }

  /** First healthy provider in one market's chain that answers the query. */
  async searchChain(query, market, filter) {
    const candidates = this.router.candidates('search', market);
    for (const candidate of candidates.filter((c) => c.healthy)) {
      try {
        const rows = await candidate.provider.searchStocks(query, filter || undefined);
        this.health.record(healthScope(candidate.id, 'search'), true);
        if (rows && rows.length) return rows;
      } catch (err) {
        this.health.record(healthScope(candidate.id, 'search'), false, { message: err && err.message });
        this.logger?.debug?.(`search via ${candidate.id} failed: ${err && err.message}`);
      }
    }
    return [];
  }

  /**
   * Market Overview strip (0.3.0): the canonical index list, each with its own
   * quote envelope. One unreachable index never fails the whole strip (§44).
   *
   * @param {{force?: boolean, symbols?: string[]}} [opts]
   */
  async listIndices(opts = {}) {
    const market = opts.market && STOCK_MARKETS.includes(opts.market) ? opts.market : null;
    const perMarket = market
      ? DEFAULT_INDEX_SYMBOLS.filter((s) => {
        const entry = lookupIndex(s);
        return entry && entry.market === market;
      })
      : DEFAULT_INDEX_SYMBOLS;
    const requested = Array.isArray(opts.symbols) && opts.symbols.length ? opts.symbols : perMarket;
    const items = [];
    const unavailable = [];
    const queue = requested.slice();
    const worker = async () => {
      for (;;) {
        const requestedSymbol = queue.shift();
        if (requestedSymbol === undefined) return;
        const known = lookupIndex(requestedSymbol);
        if (!known) {
          unavailable.push({ symbol: String(requestedSymbol), code: CODES.INVALID_SYMBOL, error: 'unknown index' });
          continue;
        }
        try {
          const envelope = await this.getQuote(known.symbol, { force: opts.force });
          items.push({ ...publicIndex(known), quote: envelope.data, meta: envelope.meta });
        } catch (err) {
          const trading = toTradingError(err, `no quote for ${known.symbol}`);
          unavailable.push({ symbol: known.symbol, code: trading.code, error: trading.message });
        }
      }
    };
    // Four at a time: a ten-index strip stays inside the providers' rate budget.
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, queue.length)) }, worker));
    items.sort((a, b) => a.order - b.order);
    return {
      items,
      count: items.length,
      unavailable,
      generatedAt: Date.now(),
      markets: market ? [market] : STOCK_MARKETS.slice(),
      disclaimer: DISCLAIMER,
    };
  }

  /**
   * Crypto spotlight (0.5.0): the largest coins on their USDT pairs, so the crypto
   * market has the same "biggest names at a glance" strip the stock markets get
   * from `listIndices`. Coins are not indices — they are quoted securities — so
   * they go through the ordinary quote path of the CRYPTO chain.
   *
   * @param {{force?: boolean, symbols?: string[]}} [opts]
   */
  async listCrypto(opts = {}) {
    const requested = Array.isArray(opts.symbols) && opts.symbols.length ? opts.symbols : CRYPTO_SPOTLIGHT;
    const items = [];
    const unavailable = [];
    const queue = requested.slice();
    const worker = async () => {
      for (;;) {
        const requestedSymbol = queue.shift();
        if (requestedSymbol === undefined) return;
        const known = this.directory.lookup(requestedSymbol, 'CRYPTO');
        try {
          const envelope = await this.getQuote(requestedSymbol, { force: opts.force, market: 'CRYPTO' });
          items.push({
            symbol: requestedSymbol,
            name: (known && known.name) || requestedSymbol,
            nameZh: (known && known.nameZh) || '',
            quote: envelope.data,
            meta: envelope.meta,
          });
        } catch (err) {
          const trading = toTradingError(err, `no quote for ${requestedSymbol}`);
          unavailable.push({ symbol: requestedSymbol, code: trading.code, error: trading.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, queue.length)) }, worker));
    items.sort((a, b) => requested.indexOf(a.symbol) - requested.indexOf(b.symbol));
    return {
      items,
      count: items.length,
      unavailable,
      generatedAt: Date.now(),
      markets: ['CRYPTO'],
      disclaimer: DISCLAIMER,
    };
  }

  // --------------------------------------------------------------- envelopes

  /**
   * Attach the §20 provenance block and the §21 freshness vocabulary.
   * `stale` is true only when we served a cache entry past its TTL or the data
   * itself is old for the market's session.
   */
  envelope(value, hit, opts = {}) {
    const symbol = value && value.symbol ? value.symbol : null;
    const market = (value && value.market) || (symbol ? parseSymbol(symbol).market : null);
    const timestamp = firstNumber([value && value.timestamp, value && value.asOf, value && Array.isArray(value.candles) && value.candles.length ? value.candles[value.candles.length - 1].timestamp : null]);
    const freshness = opts.freshnessKind === 'search' || !market || !timestamp ? null : gradeFreshness(timestamp, market);
    const cacheStale = hit && hit.stale === true;
    const stale = cacheStale || Boolean(freshness && freshness.stale) || (value && value.stale === true);
    const ttlKind = opts.freshnessKind || (value && value.candles ? 'candles' : 'quote');
    const ageMs = hit && hit.storedAt ? Date.now() - hit.storedAt : null;
    return {
      data: value,
      meta: {
        symbol,
        market,
        source: (value && value.source) || (hit && hit.provider) || 'cache',
        provider: (hit && hit.provider) || (value && value.provider) || (value && value.source) || null,
        timestamp: timestamp || null,
        fetchedAt: Date.now(),
        cached: Boolean(hit && hit.cached),
        cacheAgeMs: ageMs,
        stale,
        staleReason: stale ? (cacheStale ? 'served from cache past its TTL' : (freshness && freshness.note) || 'data is older than the current session') : null,
        delaySeconds: value && 'delaySeconds' in value ? value.delaySeconds : null,
        freshness: freshness ? freshness.note : null,
        marketOpen: market ? marketStatus(market).open : null,
        cacheKind: ttlKind,
        disclaimer: DISCLAIMER,
      },
    };
  }

  /** Fill in names/exchange/currency the provider did not send. */
  enrich(record) {
    if (!record || !record.symbol) return record;
    const known = this.directory.lookup(record.symbol, record.market);
    if (!known) return record;
    const out = { ...record, ...splitNames(record, known) };
    if (!out.exchange && known.exchange) out.exchange = known.exchange;
    // Providers routinely omit the currency (or send a US default) on A-share,
    // Tokyo and crypto rows: use the market's own currency when that happens.
    const marketCurrency = currencyOf(known.market);
    if (!out.currency || (out.currency === 'USD' && marketCurrency !== 'USD')) out.currency = known.currency || marketCurrency;
    this.directory.put(out);
    return out;
  }

  // ------------------------------------------------------------------- status

  status() {
    const routerStatus = this.router.status();
    return {
      ...routerStatus,
      markets: Object.fromEntries(MARKETS.map((m) => [m, { ...marketConfig(m), session: marketStatus(m) }])),
      cache: this.cache.snapshot(),
      directorySize: this.directory.size,
      indices: { count: DEFAULT_INDEX_SYMBOLS.length, symbols: [...DEFAULT_INDEX_SYMBOLS] },
      cryptoSpotlight: [...CRYPTO_SPOTLIGHT],
      universe: this.universe ? this.universe.status() : null,
      counters: { ...this.counters },
      supported: { intervals: [...INTERVALS], ranges: [...RANGES] },
      disclaimer: DISCLAIMER,
    };
  }
}

/** Prefer the provider's own names, fall back to the directory. */
function mergeNames(record, known) {
  if (!record || !known) return record;
  const out = { ...record, ...splitNames(record, known), exchange: record.exchange || known.exchange };
  const marketCurrency = currencyOf(known.market);
  if (!out.currency || (out.currency === 'USD' && marketCurrency !== 'USD')) out.currency = known.currency || marketCurrency;
  return out;
}

/** The written note every crypto profile carries (spec §18: no issuer, 24/7). */
function cryptoProfileNote(canonical, quote) {
  return `${canonical} is a crypto asset quoted against ${quote} on the spot market. Prices are set by continuous 24/7 trading and are not tied to any company or listing venue; there is no issuer, no earnings and no trading session.`;
}

/** Directory-only crypto profile, used when no provider can describe the pair. */
function cryptoStubProfile(canonical, quote, known) {
  return makeProfile({
    symbol: canonical,
    market: 'CRYPTO',
    name: (known && known.name) || canonical,
    nameZh: (known && known.nameZh) || undefined,
    exchange: 'CRYPTO',
    currency: quote,
    description: cryptoProfileNote(canonical, quote),
    source: 'directory',
    timestamp: Date.now(),
  });
}

/**
 * Relevance ordering for search results.
 *
 * The upstream suggest endpoint is a substring matcher, so it happily returns
 * 阿里健康 for 阿里 and a 2x-leveraged HK ETF for NVIDIA. Tiering by *identity*
 * (exact ticker or known alias) before *text containment*, and demoting
 * derivative products, gives the §22 acceptance queries the right first hit.
 *
 * @param {string} query
 * @param {any[]} records
 * @param {SymbolDirectory} directory
 */
export function rankSearchResults(query, records, directory) {
  const needle = String(query || '').trim();
  const lower = needle.toLowerCase();
  const upper = needle.toUpperCase();
  const latinQuery = /^[A-Za-z][A-Za-z0-9.\- ]*$/.test(needle);

  const score = (record) => {
    const symbol = String(record.symbol || '').toUpperCase();
    const bare = symbol.replace(/\.HK$/, '');
    const known = directory ? directory.lookup(record.symbol, record.market) : null;
    // Index records carry their own aliases (they are not in the stock directory).
    const aliases = ((known && known.aliases) || record.aliases || []).map((a) => String(a).toLowerCase());
    const names = [record.name, record.nameZh, known?.name, known?.nameZh].filter(Boolean).map((n) => String(n).toLowerCase());
    let s = 0;

    // 1. Identity — a guaranteed win.
    if (symbol === upper || bare === upper) s += 1000;
    else if (aliases.includes(lower)) s += 900;
    else if (symbol.startsWith(upper) || bare.startsWith(upper)) s += 300;
    else if (aliases.some((a) => a.startsWith(lower))) s += 200;
    else if (names.some((n) => n === lower)) s += 260;
    else if (names.some((n) => n.startsWith(lower))) s += 120;
    else if (names.some((n) => n.includes(lower))) s += 60;

    // 2. Curated symbols are more likely to be what a beginner meant.
    if (known && known.name && known.name !== known.symbol) s += 80;

    // 3. Derivative products and bonds are legitimate but rarely the intent.
    const text = `${record.name || ''} ${record.nameZh || ''}`;
    if (/做多|做空|两倍|三倍|五倍|杠杆|反向|牛证|熊证|认购|认沽|ETF|ETN/i.test(text)) s -= 260;
    if (/notes|note due|优先股|preferred|warrant|债券/i.test(text)) s -= 260;
    if (record.quoteType && /ETF|ETN|MUTUALFUND/i.test(String(record.quoteType))) s -= 120;

    // 4. A latin query is far more likely to mean the US listing.
    if (latinQuery && record.market === 'US') s += 40;
    if (!latinQuery && record.market === 'HK') s += 30;
    // 5. A latin query may equally be a coin: `SOL` is both a crypto asset and a
    //    plausible ticker, and the coin is what a "SOL" search almost always
    //    means. The record still carries its own market, so opening it keeps the
    //    CRYPTO hint (see `parseSymbol`'s note on bare bases).
    if (latinQuery && record.market === 'CRYPTO') s += 60;
    return s;
  };

  return [...records]
    .map((record, index) => ({ record, index, s: score(record) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((entry) => entry.record);
}

function firstNumber(values) {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** A sensible range when the caller gave an interval but no range. */
function defaultRangeFor(interval) {
  return { '5m': '1d', '15m': '5d', '30m': '5d', '1h': '1mo', '1d': '6mo', '1wk': '5y' }[interval] || '6mo';
}
