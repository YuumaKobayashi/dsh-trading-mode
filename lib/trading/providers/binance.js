/**
 * Binance provider — the crypto primary (added in 0.5.0).
 *
 * Scope is deliberately narrow: 24 h tickers and klines for the USDT spot pairs
 * a user asks for. Binance publishes no coin names (`exchangeInfo` is 17.7 MB and
 * carries none), so the listing/name directory belongs to CoinLore — this module
 * never invents a name, a rank or a market capitalisation (§14/§16).
 *
 * Measured dialect facts this adapter encodes (2026-10-07, from this network):
 *
 *  - Only `data-api.binance.vision` answers; `api.binance.com` and its mirrors
 *    reset the connection, and every other reachable exchange feed is out of
 *    scope (see config.js). A failure here falls through to Gate.io.
 *  - The pair is upper-case concatenated (`BTCUSDT`); `BTC-USDT` answers
 *    `-1121 Invalid symbol`. The spelling comes from `providerKey('binance', …)`
 *    so it is never assembled by hand.
 *  - The weekly interval token is `1w` — `1wk` is an HTTP 400 — so the canonical
 *    interval is translated through `PROVIDER_CONFIG.binance.intervalMap`.
 *  - One klines call caps at 1,000 rows and *silently truncates* above that, so a
 *    long range is assembled from several calls walked backwards from the newest
 *    bar with `endTime`, then de-duplicated by open time.
 *  - `quoteVolume` is the USDT turnover and is what the panel displays as volume;
 *    `volume` is denominated in the base asset and is not comparable across pairs.
 *
 * An unknown pair is a semantic answer, not a transport failure: the upstream
 * `-1121` / empty-ticker cases are mapped to `NOT_FOUND` so the router can report
 * "no provider lists this symbol" instead of a feed outage (§74).
 */

import { CRYPTO_MARKET, MARKET_SESSIONS, PROVIDER_CONFIG, candleLimit, providerConfig } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { MarketDataProvider, makeCandles, makeQuote } from '../schema.js';
import { parseSymbol, providerKey } from '../symbols.js';

/** Crypto never closes; UTC is the zone its daily bars are cut in. */
const CRYPTO_ZONE = (MARKET_SESSIONS.CRYPTO && MARKET_SESSIONS.CRYPTO.timeZone) || 'UTC';
/** Binance error codes that mean "this pair does not exist". */
const MISSING_SYMBOL_CODES = new Set([-1121, -1100, -1102, -1104]);

/**
 * Binance signals a bad pair with `{code: -1121, msg: 'Invalid symbol.'}` inside a
 * 2xx response, and with the same JSON document on a 400 one. Both become NOT_FOUND.
 */
function binanceError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Number.isFinite(payload.code) || payload.code === 0) return null;
  return payload;
}

/**
 * The payload of a response, whether or not the status was an error.
 *
 * `httpGet` only decodes `json` for a successful status, so an upstream 400 arrives
 * with the document still sitting in `body` — measured: an unknown pair answers
 * `400 {"code":-1121,"msg":"Invalid symbol."}` with `json === null`. Parsing the
 * body here is what lets a missing pair be reported as NOT_FOUND instead of as an
 * opaque upstream failure.
 */
function responsePayload(res) {
  if (res.json !== null && res.json !== undefined) return res.json;
  if (typeof res.body !== 'string' || !res.body.trim()) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

function asTradingError(payload, provider, symbol) {
  const message = String((payload && payload.msg) || 'unknown upstream error');
  const missing = MISSING_SYMBOL_CODES.has(payload && payload.code);
  return new TradingError(
    missing ? CODES.NOT_FOUND : CODES.DATA_UNAVAILABLE,
    missing
      ? `binance does not list ${symbol} (${payload.code} ${message})`
      : `binance rejected the request for ${symbol} (${payload.code} ${message})`,
    { provider, symbol },
  );
}

export class BinanceProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'binance', label: PROVIDER_CONFIG.binance.label, ...opts });
    this.capabilities = { search: false, quote: true, candles: true, profile: false, universe: false };
    this.markets = ['CRYPTO'];
    this.intervals = PROVIDER_CONFIG.binance.intervals;
  }

  timeZoneOf() {
    return CRYPTO_ZONE;
  }

  /**
   * Crypto pairs only. A stock ticker is not this provider's business even when
   * the market filter already said CRYPTO (measured: `SOL`, `LINK` and `ADA` are
   * also US tickers, so the market hint is what disambiguates them).
   */
  supportsSymbol(symbol, feature) {
    let parsed;
    try {
      parsed = parseSymbol(symbol, 'CRYPTO');
    } catch {
      return false;
    }
    return parsed.market === 'CRYPTO';
  }

  /** `currency_pair`-free single-symbol 24 h ticker for the USDT spot pair. */
  async getQuote(symbol) {
    const parsed = parseSymbol(symbol, 'CRYPTO');
    if (parsed.market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `binance quotes crypto pairs only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = providerConfig('binance');
    const pair = providerKey('binance', parsed.symbol);
    const res = await httpGet(`${cfg.base}${cfg.tickerPath}?symbol=${encodeURIComponent(pair)}`, {
      provider: this.id,
      limiter: this.limiter,
      allowErrorStatus: true,
    });
    const failure = binanceError(responsePayload(res));
    if (failure) throw asTradingError(failure, this.id, parsed.symbol);
    const ticker = Array.isArray(res.json) ? res.json[0] : res.json;
    if (!ticker || typeof ticker !== 'object') {
      throw new TradingError(CODES.NOT_FOUND, `binance did not answer a ticker for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
        status: res.status,
      });
    }
    const price = num(ticker.lastPrice);
    if (price === null) {
      throw new TradingError(CODES.NOT_FOUND, `binance lists no USDT price for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    return makeQuote({
      symbol: parsed.symbol,
      market: 'CRYPTO',
      currency: cfg.quoteAsset,
      price,
      change: num(ticker.priceChange),
      changePct: num(ticker.priceChangePercent),
      open: num(ticker.openPrice),
      high: num(ticker.highPrice),
      low: num(ticker.lowPrice),
      previousClose: num(ticker.prevClosePrice),
      /** USDT turnover, so the figure is comparable across pairs. */
      volume: num(ticker.quoteVolume ?? ticker.volume),
      timestamp: num(ticker.closeTime) ?? Date.now(),
      source: this.id,
      exchange: 'CRYPTO',
    });
  }

  /** One klines page: `{rows, raw, count}` with `rows` oldest → newest. */
  async fetchKlines(pair, binanceInterval, { limit, endTime } = {}) {
    const cfg = providerConfig('binance');
    const capped = Math.min(Math.max(1, Math.trunc(limit) || cfg.klineLimit), cfg.klineLimit);
    const params = new URLSearchParams({ symbol: pair, interval: binanceInterval, limit: String(capped) });
    if (Number.isFinite(endTime) && endTime > 0) params.set('endTime', String(Math.floor(endTime)));
    const res = await httpGet(`${cfg.base}${cfg.klinesPath}?${params.toString()}`, {
      provider: this.id,
      limiter: this.limiter,
      allowErrorStatus: true,
    });
    const failure = binanceError(responsePayload(res));
    if (failure) throw asTradingError(failure, this.id, pair);
    if (!Array.isArray(res.json)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `binance returned no klines payload for ${pair}`, {
        provider: this.id,
        symbol: pair,
        status: res.status,
      });
    }
    // Measured: an unknown pair answers `[]` on klines rather than the `-1121`
    // ticker error, so an empty page for the *newest* request is a missing pair —
    // not a transport failure and not a listed pair with no history.
    if (!res.json.length && !Number.isFinite(endTime)) {
      throw new TradingError(CODES.NOT_FOUND, `binance does not list ${pair} (klines returned no bars)`, {
        provider: this.id,
        symbol: pair,
      });
    }
    const rows = [];
    for (const row of res.json) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const timestamp = num(row[0]);
      const close = num(row[4]);
      if (timestamp === null || close === null) continue;
      rows.push({
        timestamp,
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close,
        /** Base-asset volume: the crypto convention, and what a chart labels as volume. */
        volume: num(row[5]),
      });
    }
    return { rows, raw: res.json.length, count: rows.length };
  }

  /**
   * Klines for one range, assembled from at most `klineMaxPages` calls.
   *
   * Each further page moves `endTime` back to just before the oldest bar already
   * collected, so the pages tile the history without overlap; the result is
   * de-duplicated by open time (makeCandles) and trimmed to the newest bars the
   * range asks for.
   */
  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol, 'CRYPTO');
    if (parsed.market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `binance serves crypto pairs only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = providerConfig('binance');
    const binanceInterval = cfg.intervalMap[interval];
    if (!binanceInterval) {
      throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `binance does not serve ${interval} candles`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const pair = providerKey('binance', parsed.symbol);
    // The range decides how many bars we ask for (crypto ranges are calendar
    // days); the upstream cap and the page budget decide how many of them can be
    // fetched in one request.
    const want = candleLimit(range, interval, CRYPTO_MARKET);
    const target = Math.max(1, Math.min(want, cfg.klineLimit)) + cfg.klineMaxPages;
    const maxPages = Math.max(1, cfg.klineMaxPages);

    const collected = [];
    const seen = new Set();
    let endTime = null;
    let pages = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.fetchKlines(pair, binanceInterval, { limit: cfg.klineLimit, endTime });
      pages += 1;
      if (!batch.rows.length) break;
      for (const row of batch.rows) {
        if (seen.has(row.timestamp)) continue;
        seen.add(row.timestamp);
        collected.push(row);
      }
      if (collected.length >= target || batch.raw < cfg.klineLimit) break;
      const oldest = batch.rows[0].timestamp;
      if (!Number.isFinite(oldest) || oldest <= 0) break;
      endTime = oldest - 1;
    }

    const candles = makeCandles(collected);
    if (!candles.length) {
      // A listed pair with no bars in the window is a symbol answer, not an outage.
      throw new TradingError(CODES.NOT_FOUND, `binance returned no ${interval} candles for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    return candles.slice(-want);
  }

  /**
   * The USDT pairs Binance actually lists, for the listing browser.
   *
   * `exchangeInfo` is 17.7 MB and carries no names, so it is not used here: the
   * batch 24 h ticker endpoint answers the same question in one small request.
   * Rows carry no name — the directory/CoinLore supplies it — which is why this
   * provider is not a configured universe feed.
   */
  async listSecurities({ market, page = 1, size = 100 } = {}) {
    if (market && market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `binance lists the crypto market only (got ${market})`);
    }
    const cfg = providerConfig('binance');
    const res = await httpGet(`${cfg.base}${cfg.tickerPath}`, {
      provider: this.id,
      limiter: this.limiter,
      allowErrorStatus: true,
    });
    const payload = res.json;
    if (!Array.isArray(payload)) {
      const failure = binanceError(responsePayload(res));
      if (failure) throw asTradingError(failure, this.id, 'CRYPTO');
      throw new TradingError(CODES.DATA_UNAVAILABLE, 'binance returned no ticker table', { provider: this.id });
    }
    const rows = [];
    for (const ticker of payload) {
      const pair = String((ticker && ticker.symbol) || '').toUpperCase();
      if (!pair.endsWith(cfg.quoteAsset)) continue;
      const base = pair.slice(0, pair.length - cfg.quoteAsset.length);
      if (!base) continue;
      let parsed;
      try {
        parsed = parseSymbol(base, 'CRYPTO');
      } catch {
        continue;
      }
      if (parsed.market !== 'CRYPTO') continue;
      rows.push({
        symbol: parsed.symbol,
        code: parsed.code,
        name: parsed.symbol,
        nameZh: undefined,
        market: 'CRYPTO',
        exchange: 'CRYPTO',
        board: 'CRYPTO-ALL',
        kind: 'crypto',
      });
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const pz = Math.max(1, Math.trunc(Number(size)) || 100);
    const pn = Math.max(1, Math.trunc(Number(page)) || 1);
    const offset = (pn - 1) * pz;
    return {
      market: 'CRYPTO',
      board: 'CRYPTO-ALL',
      label: 'Crypto — all spot pairs',
      exchange: 'CRYPTO',
      page: pn,
      size: pz,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / pz)),
      hasMore: offset + pz < rows.length,
      fetchedAt: Date.now(),
      rows: rows.slice(offset, offset + pz),
    };
  }

  boards(market) {
    return market === 'CRYPTO' ? [{ id: 'CRYPTO-ALL', label: 'Crypto — all spot pairs', exchange: 'CRYPTO' }] : [];
  }
}

export default BinanceProvider;
