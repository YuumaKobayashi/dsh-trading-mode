/**
 * Gate.io provider — the crypto fallback (added in 0.5.0).
 *
 * Gate.io is the second reachable crypto venue from this network (Binance is the
 * primary; every other exchange feed timeouts or is DNS-poisoned — see config.js).
 * It serves the same two capabilities as Binance and nothing else: no coin names
 * as far as this plugin is concerned (its `currency_pairs` directory is a listing
 * source, not a profile source), no search, no written profiles.
 *
 * Measured dialect facts this adapter encodes (2026-10-07):
 *
 *  - The pair is `BASE_QUOTE` with an underscore (`BTC_USDT`), built by
 *    `providerKey('gate', …)`, never by hand.
 *  - `/api/v4/spot/tickers` answers an *array* even for a single pair, and the
 *    `currency_pair` query filter selects it.
 *  - `/api/v4/spot/candlesticks` rows are **newest → oldest** and are positional,
 *    not named:
 *    `[timestampSeconds, quoteVolume, close, high, low, open, baseVolume, windowClosed]`.
 *    The adapter reorders them into `{timestamp, open, high, low, close, volume}`
 *    and `makeCandles` sorts them ascending.
 *  - The weekly token is `7d`, mapped from the canonical `1wk`.
 *  - One candlesticks call caps at 1,000 rows, so a range needing more than that
 *    is served as the newest 1,000 bars rather than paginated (documented limit).
 *
 * Gate reports the current pair as `last`, the 24 h move as `change_percentage`
 * and the turnover in **quote** currency as `quote_volume` — the same basis the
 * Binance adapter displays. An empty array is a semantic answer (`NOT_FOUND`), so
 * the router can distinguish "unknown pair" from "feed down".
 */

import { CRYPTO_MARKET, MARKET_SESSIONS, PROVIDER_CONFIG, candleLimit, providerConfig } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { MarketDataProvider, makeCandles, makeQuote } from '../schema.js';
import { parseSymbol, providerKey } from '../symbols.js';

const CRYPTO_ZONE = (MARKET_SESSIONS.CRYPTO && MARKET_SESSIONS.CRYPTO.timeZone) || 'UTC';
/**
 * Gate's own error codes worth translating into this plugin's taxonomy.
 * Measured for an unknown coin: `400 {"label":"INVALID_CURRENCY","message":"Invalid currency NOTACOIN"}`,
 * and a malformed pair answers `INVALID_CURRENCY_PAIR`.
 */
const MISSING_PAIR_LABELS = /invalid_currency|invalid currency|not found|unknown currency pair/i;

/** A Gate error body is a flat object with `label` + `message`. */
function gateError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const label = payload.label || payload.error;
  const message = payload.message || payload.detail;
  if (!label && !message) return null;
  return { label: String(label || ''), message: String(message || '') };
}

/**
 * The payload of a response, whether or not the status was an error.
 *
 * `httpGet` only decodes `json` for a successful status, so a Gate rejection arrives
 * with the document still in `body`. Reading it is what distinguishes "this pair
 * does not exist" from "the feed failed".
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

function asTradingError(failure, provider, symbol) {
  const text = `${failure.label} ${failure.message}`.trim();
  const missing = MISSING_PAIR_LABELS.test(text);
  return new TradingError(
    missing ? CODES.NOT_FOUND : CODES.DATA_UNAVAILABLE,
    missing ? `gate does not list ${symbol} (${text})` : `gate rejected the request for ${symbol} (${text})`,
    { provider, symbol },
  );
}

export class GateProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'gate', label: PROVIDER_CONFIG.gate.label, ...opts });
    this.capabilities = { search: false, quote: true, candles: true, profile: false, universe: false };
    this.markets = ['CRYPTO'];
    this.intervals = PROVIDER_CONFIG.gate.intervals;
  }

  timeZoneOf() {
    return CRYPTO_ZONE;
  }

  supportsSymbol(symbol, feature) {
    let parsed;
    try {
      parsed = parseSymbol(symbol, 'CRYPTO');
    } catch {
      return false;
    }
    return parsed.market === 'CRYPTO';
  }

  /** 24 h ticker for one pair; Gate answers an array, so the first row is the pair. */
  async getQuote(symbol) {
    const parsed = parseSymbol(symbol, 'CRYPTO');
    if (parsed.market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `gate quotes crypto pairs only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = providerConfig('gate');
    const pair = providerKey('gate', parsed.symbol);
    const res = await httpGet(`${cfg.base}${cfg.tickersPath}?currency_pair=${encodeURIComponent(pair)}`, {
      provider: this.id,
      limiter: this.limiter,
      allowErrorStatus: true,
    });
    const failure = gateError(responsePayload(res));
    if (failure) throw asTradingError(failure, this.id, parsed.symbol);
    const list = Array.isArray(res.json) ? res.json : [];
    // The filter is advisory: match defensively in case a mirror ignores it.
    const ticker =
      list.find((row) => String((row && row.currency_pair) || '').toUpperCase() === pair.toUpperCase()) || list[0];
    if (!ticker || typeof ticker !== 'object') {
      throw new TradingError(CODES.NOT_FOUND, `gate did not answer a ticker for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
        status: res.status,
      });
    }
    const price = num(ticker.last);
    if (price === null) {
      throw new TradingError(CODES.NOT_FOUND, `gate lists no USDT price for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const open24h = num(ticker.open_24h);
    const change24h = num(ticker.change_24h);
    const changePct = num(ticker.change_percentage);
    // Gate's ticker publishes no opening print for the rolling window (measured:
    // the payload is currency_pair, last, lowest_ask/highest_bid, change_percentage,
    // base_volume, quote_volume, high_24h, low_24h — and nothing else), so `open`
    // stays absent rather than being guessed. The absolute change is exact when
    // the feed sends it and derived from the percentage otherwise.
    const change = change24h ?? (changePct !== null ? (price * changePct) / 100 : null);
    return makeQuote({
      symbol: parsed.symbol,
      market: 'CRYPTO',
      currency: cfg.quoteAsset,
      price,
      change,
      changePct,
      open: open24h,
      high: num(ticker.high_24h),
      low: num(ticker.low_24h),
      /** The rolling window's opening print, when the feed publishes it. */
      previousClose: open24h,
      volume: num(ticker.quote_volume ?? ticker.base_volume),
      timestamp: Date.now(),
      source: this.id,
      exchange: 'CRYPTO',
    });
  }

  /** One candlesticks page, reordered from Gate's positional newest-first rows. */
  async fetchCandles(pair, gateInterval, limit) {
    const cfg = providerConfig('gate');
    const capped = Math.min(Math.max(1, Math.trunc(limit) || cfg.maxCandles), cfg.maxCandles);
    const params = new URLSearchParams({ currency_pair: pair, interval: gateInterval, limit: String(capped) });
    const res = await httpGet(`${cfg.base}${cfg.candlesticksPath}?${params.toString()}`, {
      provider: this.id,
      limiter: this.limiter,
      allowErrorStatus: true,
    });
    const failure = gateError(responsePayload(res));
    if (failure) throw asTradingError(failure, this.id, pair);
    if (!Array.isArray(res.json)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `gate returned no candlestick payload for ${pair}`, {
        provider: this.id,
        symbol: pair,
        status: res.status,
      });
    }
    const rows = [];
    for (const row of res.json) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const seconds = num(row[0]);
      const close = num(row[2]);
      if (seconds === null || close === null) continue;
      rows.push({
        /** Gate stamps candles in seconds; the schema carries epoch milliseconds. */
        timestamp: seconds * 1000,
        open: num(row[5]),
        high: num(row[3]),
        low: num(row[4]),
        close,
        volume: num(row[6]),
      });
    }
    return rows;
  }

  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol, 'CRYPTO');
    if (parsed.market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `gate serves crypto pairs only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = providerConfig('gate');
    const gateInterval = cfg.intervalMap[interval];
    if (!gateInterval) {
      throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `gate does not serve ${interval} candles`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const pair = providerKey('gate', parsed.symbol);
    const want = candleLimit(range, interval, CRYPTO_MARKET);
    const raw = await this.fetchCandles(pair, gateInterval, Math.min(want, cfg.maxCandles));
    const candles = makeCandles(raw);
    if (!candles.length) {
      throw new TradingError(CODES.NOT_FOUND, `gate returned no ${interval} candles for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    return candles.slice(-want);
  }
}

export default GateProvider;
