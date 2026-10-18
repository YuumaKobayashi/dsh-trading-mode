/**
 * Unified market-data schema (spec §14/§17/§18/§19) plus the normalisers that
 * turn provider-native payloads into it.
 *
 * Nothing above this layer may see a provider-specific field name: providers
 * return these shapes or throw.
 */

import { currencyOf, parseSymbol, stockSymbol } from './symbols.js';
import { gradeFreshness } from './sessions.js';
import { roundPrice } from './http.js';

/**
 * @typedef {Object} StockSymbol
 * @property {string} symbol          canonical, e.g. AAPL or 0700.HK
 * @property {string} exchangeSymbol  provider-exchange spelling
 * @property {string} name
 * @property {string} [nameZh]
 * @property {'US'|'HK'|'CN'|'JP'|'CRYPTO'} market
 * @property {string} exchange
 * @property {'USD'|'HKD'|'CNY'|'JPY'|'USDT'} currency
 */

/**
 * @typedef {Object} MarketQuote
 * @property {string} symbol
 * @property {'US'|'HK'|'CN'|'JP'|'CRYPTO'} market
 * @property {'USD'|'HKD'|'CNY'|'JPY'|'USDT'} currency
 * @property {number} price
 * @property {number|null} change
 * @property {number|null} changePct
 * @property {number|null} open
 * @property {number|null} high
 * @property {number|null} low
 * @property {number|null} previousClose
 * @property {number|null} volume
 * @property {number} timestamp        epoch ms of the upstream print
 * @property {string} source           provider id that produced the value
 * @property {number|null} delaySeconds
 * @property {boolean} stale
 */

/**
 * @typedef {Object} Candle
 * @property {number} timestamp epoch ms
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {Object} CompanyProfile
 * @property {string} symbol
 * @property {string} name
 * @property {string} [nameZh]
 * @property {string} market
 * @property {string} exchange
 * @property {string} currency
 * @property {string} [industry]
 * @property {string} [sector]
 * @property {string} [country]
 * @property {string} [website]
 * @property {string} [description]
 * @property {number|null} marketCap
 * @property {number|null} [peRatio]
 * @property {number|null} [sharesOutstanding]
 * @property {string} source
 * @property {number} timestamp
 */

const clampText = (v, max = 1_200) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;

/**
 * Build a MarketQuote, deriving change/changePct when the provider omits them.
 * @param {Partial<MarketQuote> & {symbol: string}} input
 * @returns {MarketQuote}
 */
export function makeQuote(input) {
  const parsed = parseSymbol(input.symbol, input.market);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const price = isNum(input.price) ? roundPrice(input.price) : null;
  if (price === null) {
    const err = new Error(`no price available for ${parsed.symbol}`);
    err.code = 'NO_PRICE';
    throw err;
  }
  let change = isNum(input.change) ? input.change : null;
  let changePct = isNum(input.changePct) ? input.changePct : null;
  const previousClose = isNum(input.previousClose) ? roundPrice(input.previousClose) : null;
  if (change === null && previousClose) change = roundPrice(price - previousClose);
  if (changePct === null && previousClose) changePct = Number((((price - previousClose) / previousClose) * 100).toFixed(2));
  const timestamp = isNum(input.timestamp) ? input.timestamp : Date.now();
  const freshness = gradeFreshness(timestamp, parsed.market);
  return {
    symbol: parsed.symbol,
    market: parsed.market,
    currency: input.currency || currencyOf(parsed.market),
    price,
    change: isNum(change) ? Number(change.toFixed(4)) : null,
    changePct: isNum(changePct) ? Number(changePct.toFixed(2)) : null,
    open: isNum(input.open) ? roundPrice(input.open) : null,
    high: isNum(input.high) ? roundPrice(input.high) : null,
    low: isNum(input.low) ? roundPrice(input.low) : null,
    previousClose,
    volume: isNum(input.volume) ? Math.round(input.volume) : null,
    timestamp,
    source: input.source || 'unknown',
    delaySeconds: isNum(input.delaySeconds) ? input.delaySeconds : input.delaySeconds === null ? null : null,
    stale: input.stale === true ? true : freshness.stale,
    freshness: input.freshness || freshness.note,
    ...(input.name ? { name: input.name } : {}),
    ...(input.nameZh ? { nameZh: input.nameZh } : {}),
    ...(input.exchange ? { exchange: input.exchange } : {}),
  };
}

/** @param {Partial<Candle>[]} rows */
export function makeCandles(rows) {
  const out = [];
  for (const r of rows || []) {
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!isNum(r.timestamp) || !isNum(r.close)) continue;
    out.push({
      timestamp: r.timestamp,
      open: isNum(r.open) ? r.open : r.close,
      high: isNum(r.high) ? r.high : r.close,
      low: isNum(r.low) ? r.low : r.close,
      close: r.close,
      volume: isNum(r.volume) ? r.volume : 0,
    });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  // De-duplicate identical timestamps, keeping the last observation.
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].timestamp === c.timestamp) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

/** @param {Partial<CompanyProfile> & {symbol: string}} input */
export function makeProfile(input) {
  const base = stockSymbol({ symbol: input.symbol, name: input.name, nameZh: input.nameZh, market: input.market, exchange: input.exchange, currency: input.currency });
  return {
    symbol: base.symbol,
    name: base.name,
    ...(input.nameZh || base.nameZh ? { nameZh: input.nameZh || base.nameZh } : {}),
    market: base.market,
    exchange: base.exchange,
    currency: base.currency,
    industry: clampText(input.industry, 120),
    sector: clampText(input.sector, 120),
    country: clampText(input.country, 60),
    website: clampText(input.website, 200),
    description: clampText(input.description, 1_200),
    marketCap: Number.isFinite(input.marketCap) ? input.marketCap : null,
    peRatio: Number.isFinite(input.peRatio) ? input.peRatio : null,
    sharesOutstanding: Number.isFinite(input.sharesOutstanding) ? input.sharesOutstanding : null,
    source: input.source || 'unknown',
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
  };
}

/** Validate that an object is a usable MarketQuote (used by provider tests). */
export function assertQuote(q) {
  const problems = [];
  if (!q || typeof q !== 'object') problems.push('not an object');
  else {
    if (typeof q.symbol !== 'string' || !q.symbol) problems.push('symbol');
    if (!['US', 'HK', 'CN', 'JP', 'CRYPTO'].includes(q.market)) problems.push('market');
    if (!['USD', 'HKD', 'CNY', 'JPY', 'USDT'].includes(q.currency)) problems.push('currency');
    if (!Number.isFinite(q.price)) problems.push('price');
    if (!Number.isFinite(q.timestamp)) problems.push('timestamp');
    if (typeof q.source !== 'string' || !q.source) problems.push('source');
    if (!(q.delaySeconds === null || Number.isFinite(q.delaySeconds))) problems.push('delaySeconds');
    if (typeof q.stale !== 'boolean') problems.push('stale');
  }
  if (problems.length) throw new Error(`invalid MarketQuote: ${problems.join(', ')}`);
  return true;
}

/**
 * Provider contract. Concrete providers extend this and set `capabilities`.
 * A provider that cannot serve a request must throw a TradingError — never
 * return empty data silently (§74).
 */
export class MarketDataProvider {
  /**
   * @param {{id: string, label?: string, logger?: any, limiter?: any}} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.label = opts.label || opts.id;
    this.logger = opts.logger || null;
    this.limiter = opts.limiter || null;
    this.capabilities = { search: false, quote: false, candles: false, profile: false };
    this.markets = [];
    /** Intervals the provider can actually serve; `null` = unconstrained. */
    this.intervals = opts.intervals || null;
  }

  supports(feature, market) {
    if (!this.capabilities[feature]) return false;
    if (market && this.markets.length && !this.markets.includes(market)) return false;
    return true;
  }

  /** Interval gate used by the router so a provider is never asked for what it cannot do. */
  supportsInterval(interval) {
    return !this.intervals || this.intervals.includes(interval);
  }

  /**
   * Symbol gate, for instrument classes a provider cannot serve even though it
   * handles the market/feature (market indices live outside the stock venue
   * tables). Returning false removes the provider from the candidate list instead
   * of letting it fail and pollute its health (§44).
   */
  supportsSymbol(symbol, feature) {
    return true;
  }

  /* eslint-disable no-unused-vars */
  async searchStocks(query, market) {
    throw notImplemented(this, 'searchStocks');
  }

  async getQuote(symbol) {
    throw notImplemented(this, 'getQuote');
  }

  async getCandles(symbol, interval, range) {
    throw notImplemented(this, 'getCandles');
  }

  async getCompanyProfile(symbol) {
    throw notImplemented(this, 'getCompanyProfile');
  }
  /* eslint-enable no-unused-vars */
}

function notImplemented(provider, method) {
  const err = new Error(`${provider.id}.${method} is not supported`);
  err.code = 'NOT_IMPLEMENTED';
  err.provider = provider.id;
  return err;
}
