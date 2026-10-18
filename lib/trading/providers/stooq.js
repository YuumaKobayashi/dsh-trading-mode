/**
 * Stooq provider — the spec's historical fallback (§51).
 *
 * Stooq publishes end-of-day CSV only, so it can serve `getCandles` for daily
 * and weekly intervals and nothing else. A quote is deliberately *not* derived
 * from it: an EOD close presented as a quote would violate 搂34 (never present
 * non-live data as live) for the sake of a fake success.
 */

import { PROVIDER_CONFIG } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet } from '../http.js';
import { indexSupportFor } from '../indices.js';
import { MarketDataProvider, makeCandles } from '../schema.js';
import { parseSymbol, stooqKey } from '../symbols.js';
import { zonedWallClockToEpoch } from '../sessions.js';

export class StooqProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'stooq', label: PROVIDER_CONFIG.stooq.label, ...opts });
    this.capabilities = { search: false, quote: false, candles: true, profile: false };
    this.markets = ['US', 'HK'];
    this.intervals = PROVIDER_CONFIG.stooq.intervals;
  }

  /** No verified index mapping on Stooq (spec §5.3 scopes it to stock history). */
  supportsSymbol(symbol, feature) {
    return indexSupportFor(this.id, symbol, feature);
  }

  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol);
    if (interval !== '1d' && interval !== '1wk') {
      throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `stooq only serves daily and weekly history (asked for ${interval})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = PROVIDER_CONFIG.stooq;
    const params = new URLSearchParams({ s: stooqKey(parsed.symbol), i: interval === '1wk' ? 'w' : 'd' });
    const res = await httpGet(`${cfg.base}?${params.toString()}`, { provider: this.id, limiter: this.limiter, accept: 'text' });
    const text = String(res.body || '').trim();
    if (!text || /^<|access denied|exceeded/i.test(text)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `stooq returned no usable history for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines[0].toLowerCase();
    const body = /date/.test(header) ? lines.slice(1) : lines;
    const rows = [];
    for (const line of body) {
      const cells = line.split(',');
      if (cells.length < 5) continue;
      const timestamp = zonedWallClockToEpoch(cells[0], parsed.market === 'HK' ? 'Asia/Hong_Kong' : 'America/New_York');
      const open = Number(cells[1]);
      const high = Number(cells[2]);
      const low = Number(cells[3]);
      const close = Number(cells[4]);
      const volume = Number(cells[5]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
      rows.push({ timestamp, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    }
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `stooq has no candles for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return sliceByRange(candles, interval, range);
  }
}

/** Keep the tail that matches the requested range. */
export function sliceByRange(candles, interval, range) {
  const perDay = interval === '1wk' ? 1 / 5 : 1;
  const days = { '1d': 1, '5d': 5, '1mo': 22, '3mo': 66, '6mo': 132, '1y': 252, '5y': 1260, max: 10_000 }[range] ?? 132;
  const want = Math.max(5, Math.round(days * perDay));
  return candles.slice(-want);
}
