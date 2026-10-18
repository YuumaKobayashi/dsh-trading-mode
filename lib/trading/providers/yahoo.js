/**
 * Yahoo Finance provider — the spec's primary market data source (§7/§51).
 *
 * Uses only documented, unauthenticated JSON endpoints. No scraping, no
 * websocket reverse engineering (搂16). The crumb/cookie handshake is the
 * officially required dance for the quote endpoints; it is refreshed lazily and
 * retried once when Yahoo answers 401/403.
 *
 * NOTE: from some networks (including the build machine) Yahoo answers 403 for
 * every request. The provider then reports a blocked upstream and the Market
 * Data Service falls through to the next provider in the chain, which is the
 * intended behaviour of the abstraction.
 */

import { PROVIDER_CONFIG, RANGE_CONFIG } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { MarketDataProvider, makeCandles, makeProfile, makeQuote } from '../schema.js';
import { currencyOf, parseSymbol } from '../symbols.js';

const RANGE_MAP = { '1d': '1d', '5d': '5d', '1mo': '1mo', '3mo': '3mo', '6mo': '6mo', '1y': '1y', '5y': '5y', max: 'max' };
const INTERVAL_MAP = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': '1d', '1wk': '1wk' };
const EXCHANGE_NAMES = {
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NYQ: 'NYSE',
  PCX: 'NYSE Arca',
  ASE: 'AMEX',
  HKG: 'HKEX',
};

export class YahooProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'yahoo', label: PROVIDER_CONFIG.yahoo.label, ...opts });
    this.capabilities = { search: true, quote: true, candles: true, profile: true };
    this.markets = ['US', 'HK'];
    this.intervals = PROVIDER_CONFIG.yahoo.intervals;
    this.session = null; // { cookie, crumb, at }
  }

  /** Acquire the cookie+crumb pair required by Yahoo's authenticated endpoints. */
  async ensureSession(force = false) {
    const now = Date.now();
    if (!force && this.session && now - this.session.at < 3_600_000) return this.session;
    const cfg = PROVIDER_CONFIG.yahoo;
    let cookie = '';
    try {
      const res = await httpGet(cfg.cookieUrl, { provider: this.id, retries: 0, accept: 'text', allowErrorStatus: true, limiter: this.limiter });
      const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('set-cookie') : '';
      cookie = (String(raw || '').match(/\b(A1|A3)=[^;]+/) || [''])[0];
    } catch {
      cookie = '';
    }
    const crumbRes = await httpGet(`${cfg.quoteBase}${cfg.crumbPath}`, {
      provider: this.id,
      retries: 0,
      accept: 'text',
      limiter: this.limiter,
      headers: cookie ? { Cookie: cookie } : {},
    }).catch(() => ({ body: '' }));
    const crumb = typeof crumbRes.body === 'string' && crumbRes.body.length < 32 ? crumbRes.body.trim() : '';
    this.session = { cookie, crumb, at: now };
    return this.session;
  }

  /** GET with the session attached, refreshing the crumb once on 401/403. */
  async authed(url, { useCrumb = true } = {}) {
    const session = await this.ensureSession();
    const headers = {};
    if (session.cookie) headers.Cookie = session.cookie;
    if (useCrumb && session.crumb) headers['X-Frag'] = '';
    const withCrumb = (base, crumb) => {
      if (!useCrumb || !crumb) return base;
      return `${base}${base.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}`;
    };
    try {
      return await httpGet(withCrumb(url, session.crumb), { provider: this.id, limiter: this.limiter, headers });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        const fresh = await this.ensureSession(true);
        return httpGet(withCrumb(url, fresh.crumb), { provider: this.id, limiter: this.limiter, headers });
      }
      throw err;
    }
  }

  async searchStocks(query, market) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const url = `${cfg.quoteBase}${cfg.searchPath}?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
    const quotes = (res.json && res.json.quotes) || [];
    const out = [];
    for (const q of quotes) {
      if (!q || typeof q.symbol !== 'string') continue;
      const quoteType = String(q.quoteType || '').toUpperCase();
      if (quoteType && !['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(quoteType)) continue;
      const isHK = /\.HK$/i.test(q.symbol);
      const mkt = isHK ? 'HK' : 'US';
      if (market && market !== mkt) continue;
      let parsed;
      try {
        parsed = parseSymbol(q.symbol, mkt);
      } catch {
        continue;
      }
      if (parsed.market !== mkt) continue;
      const name = q.longname || q.shortname || q.symbol;
      out.push({
        symbol: parsed.symbol,
        exchangeSymbol: parsed.symbol,
        name,
        market: mkt,
        exchange: EXCHANGE_NAMES[q.exchange] || q.exchDisp || (mkt === 'HK' ? 'HKEX' : 'NASDAQ'),
        currency: currencyOf(mkt),
        quoteType,
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  async getQuote(symbol) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    try {
      const res = await this.authed(`${cfg.quoteBase}${cfg.quotePath}?symbols=${encodeURIComponent(parsed.symbol)}&fields=regularMarketPrice`);
      const row = res.json && res.json.quoteResponse && res.json.quoteResponse.result && res.json.quoteResponse.result[0];
      if (!row || !num(row.regularMarketPrice)) throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
      return makeQuote({
        symbol: parsed.symbol,
        market: parsed.market,
        currency: row.currency || currencyOf(parsed.market),
        price: num(row.regularMarketPrice),
        change: num(row.regularMarketChange),
        changePct: num(row.regularMarketChangePercent),
        open: num(row.regularMarketOpen),
        high: num(row.regularMarketDayHigh),
        low: num(row.regularMarketDayLow),
        previousClose: num(row.regularMarketPreviousClose),
        volume: num(row.regularMarketVolume),
        timestamp: num(row.regularMarketTime) ? num(row.regularMarketTime) * 1000 : Date.now(),
        name: row.longName || row.shortName || undefined,
        exchange: EXCHANGE_NAMES[row.fullExchangeName] || row.fullExchangeName || undefined,
        source: this.id,
        delaySeconds: PROVIDER_CONFIG.yahoo.delaySeconds,
      });
    } catch (err) {
      if (err instanceof TradingError && err.code === CODES.UPSTREAM_BLOCKED) throw err;
      // Fallback: the chart endpoint is more permissive and carries a usable meta block.
      return this.quoteFromChart(parsed);
    }
  }

  async quoteFromChart(parsed) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const res = await httpGet(`${cfg.quoteBase}${cfg.chartPath}/${encodeURIComponent(parsed.symbol)}?range=1d&interval=1d`, {
      provider: this.id,
      limiter: this.limiter,
    });
    const meta = res.json && res.json.chart && res.json.chart.result && res.json.chart.result[0] && res.json.chart.result[0].meta;
    if (!meta || !num(meta.regularMarketPrice)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return makeQuote({
      symbol: parsed.symbol,
      market: parsed.market,
      currency: meta.currency || currencyOf(parsed.market),
      price: num(meta.regularMarketPrice),
      previousClose: num(meta.chartPreviousClose) ?? num(meta.previousClose),
      high: num(meta.regularMarketDayHigh),
      low: num(meta.regularMarketDayLow),
      volume: num(meta.regularMarketVolume),
      timestamp: num(meta.regularMarketTime) ? num(meta.regularMarketTime) * 1000 : Date.now(),
      name: meta.longName || meta.shortName || undefined,
      source: this.id,
      delaySeconds: PROVIDER_CONFIG.yahoo.delaySeconds,
    });
  }

  async getCandles(symbol, interval, range) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    const yInterval = INTERVAL_MAP[interval];
    const yRange = RANGE_MAP[range] || RANGE_MAP['6mo'];
    if (!yInterval) throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `yahoo does not support interval ${interval}`, { provider: this.id });
    const url = `${cfg.quoteBase}${cfg.chartPath}/${encodeURIComponent(parsed.symbol)}?range=${yRange}&interval=${yInterval}&includePrePost=false&events=div%2Csplit`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
    const result = res.json && res.json.chart && res.json.chart.result && res.json.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo returned no candles for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const q = result.indicators.quote[0];
    const rows = result.timestamp.map((ts, i) => ({
      timestamp: ts * 1000,
      open: num(q.open && q.open[i]),
      high: num(q.high && q.high[i]),
      low: num(q.low && q.low[i]),
      close: num(q.close && q.close[i]),
      volume: num(q.volume && q.volume[i]) || 0,
    }));
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo returned an empty candle series for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return candles.slice(-Math.min(candles.length, maxBars(range)));
  }

  async getCompanyProfile(symbol) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    const url = `${cfg.quoteBase}${cfg.profilePath}/${encodeURIComponent(parsed.symbol)}?modules=assetProfile%2Cprice%2CsummaryDetail`;
    const res = await this.authed(url);
    const row = res.json && res.json.quoteSummary && res.json.quoteSummary.result && res.json.quoteSummary.result[0];
    if (!row) throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no profile for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    const a = row.assetProfile || {};
    const p = row.price || {};
    const d = row.summaryDetail || {};
    return makeProfile({
      symbol: parsed.symbol,
      market: parsed.market,
      name: p.longName || p.shortName || parsed.symbol,
      exchange: p.exchangeName || (parsed.market === 'HK' ? 'HKEX' : 'NASDAQ'),
      currency: p.currency || currencyOf(parsed.market),
      industry: a.industry,
      sector: a.sector,
      country: a.country,
      website: a.website,
      description: a.longBusinessSummary,
      marketCap: num(p.marketCap) ?? num(d.marketCap),
      peRatio: num(d.trailingPE) ?? num(d.forwardPE),
      sharesOutstanding: num(d.sharesOutstanding),
      source: this.id,
      timestamp: Date.now(),
    });
  }
}

function maxBars(range) {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['6mo'];
  return Math.min(3_000, Math.max(30, cfg.days * (range === '1d' || range === '5d' ? 40 : 1)));
}
