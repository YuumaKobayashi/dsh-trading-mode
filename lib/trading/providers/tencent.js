/**
 * Tencent Finance provider (鑵捐璐㈢粡).
 *
 * Second spare provider in the chain, for the same reason as `eastmoney`: the
 * spec's Yahoo/Stooq pair is unreachable from this network. It sits behind the
 * identical `MarketDataProvider` interface, so no business code knows whether it
 * answered (搂8/搂16).
 *
 * Verified capabilities and limits:
 *  - quote:   `qt.gtimg.cn/q=usAAPL,hk00700,sh600519,jp7203` — several symbols per
 *             request. Mainland turnover arrives in lots (手) and is converted to
 *             shares here; Tokyo arrives in shares and is left alone.
 *  - candles: `web.ifzq.gtimg.cn/appstock/app/kline/kline?param=<key>,<day|week>,,,<n>`
 *             honours the bar count for US, HK, mainland China and the mainland
 *             indices. Tokyo is the exception: `jp<code>` answers a single bar for
 *             every period, so the router's minimum-bar check rejects it and
 *             Japanese daily history rests on Eastmoney alone.
 *             (`usfqkline`/`hkfqkline` return first+last row for US, so they are not used.)
 *  - **no intraday**: every minute endpoint answers `Can't load controller:
 *    UsMinuteKlineController` / `param error`, and `app/minute/query` only
 *    returns today's tick summary. `intervals: ['1d','1wk']` in PROVIDER_CONFIG
 *    keeps the router from ever asking.
 *  - responses are **GBK**, not UTF-8 — they must be decoded explicitly or every
 *    Chinese company name comes back as mojibake.
 */

import { MARKET_SESSIONS, PROVIDER_CONFIG, candleLimit } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { indexSupportFor } from '../indices.js';
import { MarketDataProvider, makeCandles, makeQuote } from '../schema.js';
import { currencyOf, parseSymbol, providerKey } from '../symbols.js';
import { zonedWallClockToEpoch } from '../sessions.js';

/** Tencent's field indices for the `v_<key>="..."` payload (1-based positions in the split array). */
const F = { name: 1, code: 2, price: 3, previousClose: 4, open: 5, volume: 6, time: 30, change: 31, changePct: 32, high: 33, low: 34, nameEn: 46, week52High: 48, week52Low: 49 };

/** Mainland quotes report turnover in lots (手); the plugin reports shares. */
const CN_LOT_SIZE = 100;

export class TencentProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'tencent', label: PROVIDER_CONFIG.tencent.label, ...opts });
    this.capabilities = { search: false, quote: true, candles: true, profile: false };
    this.markets = PROVIDER_CONFIG.tencent.markets || ['US', 'HK', 'CN', 'JP'];
    this.intervals = PROVIDER_CONFIG.tencent.intervals;
  }

  timeZoneOf(market) {
    return (MARKET_SESSIONS[market] && MARKET_SESSIONS[market].timeZone) || 'America/New_York';
  }

  /**
   * Index gate: Tencent quotes `usIXIC`/`usVIX`/`hkHSI`…, but its kline endpoint
   * answers 0 rows for every US index, so those chart requests are left to
   * Eastmoney instead of failing here.
   */
  supportsSymbol(symbol, feature) {
    return indexSupportFor(this.id, symbol, feature);
  }

  async getQuote(symbol) {
    const parsed = parseSymbol(symbol);
    const quote = await this.fetchQuoteRaw(parsed);
    const nameRaw = String(quote[F.name] || '');
    // Slot 46 carries the English name for US/HK/JP rows but a stray ratio on
    // mainland rows (`6.26` for Moutai), so it is only used when it reads as a name.
    const nameEn = usableName(quote[F.nameEn]);
    const isZh = /[\u4e00-\u9fff]/.test(nameRaw);
    const currency = quote.find((v) => /^(USD|HKD|CNY|JPY)$/.test(String(v)));
    const lots = num(quote[F.volume]);
    return makeQuote({
      symbol: parsed.symbol,
      market: parsed.market,
      currency: currency || currencyOf(parsed.market),
      price: num(quote[F.price]),
      change: num(quote[F.change]),
      changePct: num(quote[F.changePct]),
      open: num(quote[F.open]),
      high: num(quote[F.high]),
      low: num(quote[F.low]),
      previousClose: num(quote[F.previousClose]),
      volume: lots === null ? null : lots * this.lotFactor(parsed.market),
      timestamp: this.parseTime(quote[F.time], parsed.market),
      source: this.id,
      delaySeconds: PROVIDER_CONFIG.tencent.delaySeconds,
      ...(isZh ? { nameZh: nameRaw } : nameEn ? { name: nameEn } : {}),
      ...(isZh && nameEn ? { name: nameEn } : {}),
    });
  }

  /** Turnover-unit factor: mainland feeds count lots, everyone else counts shares. */
  lotFactor(market) {
    return market === 'CN' ? CN_LOT_SIZE : 1;
  }

  /** One request per symbol; the batch form is available but buys nothing for a single quote. */
  async fetchQuoteRaw(parsed) {
    const cfg = PROVIDER_CONFIG.tencent;
    const key = providerKey(this.id, parsed.symbol);
    const res = await httpGet(`${cfg.quoteBase}${cfg.quotePath}${key}`, { provider: this.id, limiter: this.limiter, accept: 'text', decode: 'gbk' });
    const body = String(res.body || '');
    const match = body.match(/v_([a-zA-Z0-9._]+)="([^"]*)"/);
    if (!match) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `tencent returned no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const fields = match[2].split('~');
    if (num(fields[F.price]) === null) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `tencent quote for ${parsed.symbol} has no price`, { provider: this.id, symbol: parsed.symbol });
    }
    return fields;
  }

  /**
   * `2026-10-02 16:00:01` (US) / `2026/10/02 16:08:10` (HK) / `20260930161458`
   * (mainland and Tokyo) — exchange wall clock in every case.
   */
  parseTime(text, market) {
    let raw = String(text || '').trim().replace(/\//g, '-');
    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (compact) raw = `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`;
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return Date.now();
    const value = zonedWallClockToEpoch(raw, this.timeZoneOf(market));
    return Number.isFinite(value) ? value : Date.now();
  }

  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol);
    if (!this.supportsInterval(interval)) {
      throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `tencent does not serve ${interval} candles (daily/weekly only)`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = PROVIDER_CONFIG.tencent;
    const key = providerKey(this.id, parsed.symbol);
    const period = interval === '1wk' ? 'week' : 'day';
    const count = candleLimit(range, interval, parsed.market);
    const url = `${cfg.klineBase}${cfg.klinePath}?param=${key},${period},,,${count}`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter, decode: 'gbk' });
    const series = res.json && res.json.data && res.json.data[key] && res.json.data[key][period];
    if (!Array.isArray(series) || !series.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `tencent returned no candles for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const timeZone = this.timeZoneOf(parsed.market);
    const lotFactor = this.lotFactor(parsed.market);
    const rows = [];
    for (const row of series) {
      if (!Array.isArray(row) || row.length < 6) continue;
      // [date, open, close, high, low, volume, ...]
      const timestamp = zonedWallClockToEpoch(`${row[0]} 12:00`, timeZone);
      if (!Number.isFinite(timestamp)) continue;
      rows.push({ timestamp, open: Number(row[1]), close: Number(row[2]), high: Number(row[3]), low: Number(row[4]), volume: Number(row[5]) * lotFactor });
    }
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `tencent returned an unusable candle series for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return candles.slice(-count);
  }
}

/**
 * Slot 46 only holds an English company name on the venues that publish one; on
 * mainland rows the same slot carries a ratio (`600519` → `6.26`). Requiring two
 * letters rejects the numbers without rejecting names such as `3M Company`.
 */
function usableName(value) {
  const text = String(value || '').trim();
  if (!/[A-Za-z]{2}/.test(text)) return '';
  if (/^[\d.,%+\-\s]+$/.test(text)) return '';
  return text;
}
