/**
 * Sina Finance provider — candles and the HK/CN listing fallback (0.4.1, extended in 0.5.0).
 *
 * Gaps appeared once the eastmoney bulk feeds started being refused from
 * this network, and Sina closes them:
 *
 *  - **US daily candles.** Tencent's US kline endpoint ignores the bar count and
 *    answers a first+last row pair, so with eastmoney down a 6-month US request
 *    produced a two-point "chart". Sina publishes the *entire* US daily history
 *    as one JSONP payload (AAPL back to 1984-09-07, 940 KB) which the adapter
 *    trims to the requested range.
 *  - **HK listing.** The HK board list, 60 rows per page, paged with `page`.
 *  - **Mainland (0.5.0).** `CN_MarketData.getKLineData` answers daily history for
 *    Shanghai, Shenzhen *and* Beijing (measured: `sh600519` and `bj920001` both
 *    320 bars; Tencent answers one bar for Beijing issues), and the `getHQNodeData`
 *    node lists page the whole mainland market 100 rows at a time with a real row
 *    count available from `getHQNodeStockCount` (`sh_a` 2,319 · `kcb` 618 ·
 *    `sz_a` 2,904 · `cyb` 1,409 · `hs_bjs` 348).
 *
 * Deliberate limits (all measured, not assumed): the HK daily-kline twin answers
 * `{"__ERROR":3,"__ERRORMSG":"Service not valid"}` and the US minute series
 * answers `var x(null)`, so candles are US + CN (`1d` only); HK candles stay with
 * the quote-aligned Tencent feed. Names come from Sina, so every row still carries
 * a provider-attributed name — the adapter never invents one (§14/§16).
 */

import { PROVIDER_CONFIG, RANGE_CONFIG, rangeDays, universeBoard, universeBoards } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { indexSupportFor } from '../indices.js';
import { MarketDataProvider, makeCandles } from '../schema.js';
import { zonedWallClockToEpoch } from '../sessions.js';
import { parseSymbol, providerKey } from '../symbols.js';

const HK_BOARD = { id: 'HK-ALL', label: '港股 — 全部上市证券 HK — all listings', exchange: 'HKEX' };
const HK_LIST_PAGE_SIZE = PROVIDER_CONFIG.sina.hkListPageSize;
const CN_LIST_PAGE_SIZE = PROVIDER_CONFIG.sina.cnListPageSize || 100;

/** The payload is a JSONP assignment (`var x([…])`), preceded by a script tag. */
export function parseSinaJsonp(text) {
  const raw = String(text || '');
  const marker = raw.indexOf('var x(');
  const start = marker >= 0 ? raw.indexOf('(', marker) + 1 : raw.search(/[[{]/);
  if (start <= 0) return null;
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  if (end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class SinaProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'sina', label: PROVIDER_CONFIG.sina.label, ...opts });
    this.capabilities = { search: false, quote: false, candles: true, profile: false, universe: true };
    this.markets = PROVIDER_CONFIG.sina.markets || ['US', 'HK', 'CN'];
    /** It lists HK and the mainland; its US market access is the daily-kline feed. */
    this.listingMarkets = PROVIDER_CONFIG.sina.listingMarkets || ['HK', 'CN'];
    this.intervals = PROVIDER_CONFIG.sina.intervals;
  }

  /**
   * Candles: US stocks, the mainland (daily history incl. Beijing) and the US
   * indices Sina actually publishes (`.IXIC`, `.NDX`, `.DJI` — the S&P 500 and VIX
   * have no series there). HK candles stay with the Tencent feed, whose daily
   * kline is verified working.
   */
  supportsSymbol(symbol, feature) {
    let parsed;
    try {
      parsed = parseSymbol(symbol);
    } catch {
      return false;
    }
    if (parsed.kind === 'index') return indexSupportFor(this.id, parsed.symbol, feature);
    if (feature === 'candles') return parsed.market === 'US' || parsed.market === 'CN';
    return true;
  }

  boards(market) {
    if (market === 'HK') return [{ ...HK_BOARD }];
    // The mainland boards already carry their Sina node id (`sh_a`, `kcb`, …).
    if (market === 'CN') return universeBoards('CN');
    return [];
  }

  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol);
    if (interval !== '1d') {
      throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `sina does not serve ${interval} candles (daily history only)`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    if (parsed.market === 'CN') return this.cnCandles(parsed, range);
    if (parsed.market !== 'US') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `sina serves US and mainland CN daily history only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const cfg = PROVIDER_CONFIG.sina;
    // Indices use Sina's own dotted dialect (`.IXIC`), stocks their plain ticker.
    const key = parsed.index && parsed.index.sinaSymbol ? parsed.index.sinaSymbol : parsed.ticker;
    const url = `${cfg.base}${cfg.dailyPath}?symbol=${encodeURIComponent(key)}&___qn=3`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter, accept: 'text' });
    const payload = parseSinaJsonp(res.body);
    if (!Array.isArray(payload) || !payload.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned no daily history for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const timeZone = 'America/New_York';
    const rows = [];
    for (const item of payload) {
      const date = String((item && item.d) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const timestamp = zonedWallClockToEpoch(`${date} 12:00`, timeZone);
      if (!Number.isFinite(timestamp)) continue;
      rows.push({ timestamp, open: num(item.o), high: num(item.h), low: num(item.l), close: num(item.c), volume: num(item.v) });
    }
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned an unusable daily series for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const days = rangeDays(range, parsed.market);
    return candles.slice(-Math.max(1, days));
  }

  /**
   * Mainland daily history. Sina spells the key with the exchange prefix
   * (`sh600519`, `sz000001`, `bj920001`) — the same dialect the quotes use — and
   * answers plain JSON (not JSONP) with `day/open/high/low/close/volume` rows,
   * oldest first. Volume is already in shares, matching the eastmoney adapter.
   */
  async cnCandles(parsed, range) {
    const cfg = PROVIDER_CONFIG.sina;
    const count = Math.max(1, rangeDays(range, parsed.market));
    const key = parsed.index && parsed.index.sinaSymbol ? parsed.index.sinaSymbol : providerKey(this.id, parsed.symbol);
    const url = `${cfg.cnBase}${cfg.cnKlinePath}?symbol=${encodeURIComponent(key)}&scale=240&ma=no&datalen=${count}`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter, accept: 'text', headers: cfg.cnHeaders });
    let payload = res.json;
    if (!Array.isArray(payload)) {
      const text = String(res.body || '').trim();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
    }
    if (!Array.isArray(payload) || !payload.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned no mainland history for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const rows = [];
    for (const item of payload) {
      const day = String((item && item.day) || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const timestamp = zonedWallClockToEpoch(`${day} 15:00`, 'Asia/Shanghai');
      if (!Number.isFinite(timestamp)) continue;
      rows.push({ timestamp, open: num(item.open), high: num(item.high), low: num(item.low), close: num(item.close), volume: num(item.volume) });
    }
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned an unusable mainland series for ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    return candles.slice(-count);
  }

  /** Board list for the market this provider was asked about (HK or the mainland). */
  async listSecurities(opts = {}) {
    if (opts.market === 'CN') return this.cnList(opts);
    return this.hkList(opts);
  }

  /**
   * Mainland node list, 100 rows per page. The node id comes from the shared board
   * table (`sh_a`/`kcb`/`sz_a`/`cyb`/`hs_bjs`); the row count is a separate
   * endpoint that answers a quoted number, so pagination is exact when it does.
   */
  async cnList({ board, page = 1, size = CN_LIST_PAGE_SIZE } = {}) {
    const cfg = PROVIDER_CONFIG.sina;
    const def = universeBoard('CN', board);
    const node = def.sinaNode;
    if (!node) {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `sina has no mainland node for board ${def.id}`, { provider: this.id });
    }
    const pz = CN_LIST_PAGE_SIZE;
    const pn = Math.max(1, Math.trunc(Number(page)) || 1);
    let total = null;
    try {
      const counted = await httpGet(`${cfg.listBase}${cfg.cnCountPath}?node=${node}`, {
        provider: this.id,
        limiter: this.limiter,
        accept: 'text',
        headers: cfg.cnHeaders,
      });
      const value = Number(String(counted.body || '').replace(/[^\d]/g, ''));
      if (Number.isFinite(value) && value > 0) total = value;
    } catch {
      // The count endpoint is a convenience, not a requirement: without it the
      // walker simply stops on the first short page.
    }
    const res = await httpGet(`${cfg.listBase}${cfg.cnListPath}?page=${pn}&num=${pz}&sort=symbol&asc=1&node=${node}`, {
      provider: this.id,
      limiter: this.limiter,
      accept: 'text',
      headers: cfg.cnHeaders,
    });
    let payload = res.json;
    if (!Array.isArray(payload)) {
      const text = String(res.body || '').trim();
      if (!text || text === 'null') payload = [];
      else {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new TradingError(CODES.PARSE_ERROR, `sina mainland listing page ${pn} was not JSON`, { provider: this.id });
        }
      }
    }
    if (!Array.isArray(payload)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned no mainland listing for page ${pn}`, { provider: this.id });
    }
    const rows = [];
    for (const item of payload) {
      let parsed;
      try {
        // The feed's own spelling is a prefixed key (`sh600000`), which is not a
        // symbol this plugin accepts; the six-digit `code` is.
        parsed = parseSymbol(String((item && item.code) || '').trim());
      } catch {
        continue;
      }
      if (parsed.market !== 'CN') continue;
      const name = String((item && item.name) || '').trim() || parsed.symbol;
      rows.push({
        symbol: parsed.symbol,
        code: parsed.code,
        name,
        market: 'CN',
        exchange: def.exchange,
        board: def.id,
        kind: 'stock',
      });
    }
    const pages = total ? Math.ceil(total / pz) : null;
    return {
      market: 'CN',
      board: def.id,
      label: def.label,
      exchange: def.exchange,
      page: pn,
      size: pz,
      total,
      pages,
      hasMore: pages ? pn < pages : rows.length >= pz,
      fetchedAt: Date.now(),
      rows,
    };
  }

  /** HK board list: 60 rows per page, ascending by code; past the end answers `null`. */
  async hkList({ market, page = 1, size = HK_LIST_PAGE_SIZE } = {}) {
    if (market && market !== 'HK') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `sina lists the HK market and the mainland (got ${market})`);
    }
    const cfg = PROVIDER_CONFIG.sina;
    const pz = HK_LIST_PAGE_SIZE;
    const pn = Math.max(1, Math.trunc(Number(page)) || 1);
    const url = `${cfg.listBase}${cfg.hkListPath}?page=${pn}&num=${pz}&sort=symbol&asc=1&node=qbgg_hk`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter, accept: 'text' });
    let payload = res.body;
    if (typeof payload === 'string') {
      const text = payload.trim();
      if (!text || text === 'null') payload = [];
      else {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new TradingError(CODES.PARSE_ERROR, `sina HK listing page ${pn} was not JSON`, { provider: this.id });
        }
      }
    }
    if (!Array.isArray(payload)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `sina returned no HK listing for page ${pn}`, { provider: this.id });
    }
    const rows = [];
    for (const item of payload) {
      let parsed;
      try {
        parsed = parseSymbol(String((item && item.symbol) || '').trim());
      } catch {
        continue;
      }
      if (parsed.market !== 'HK') continue;
      const name = String((item && item.name) || '').trim() || parsed.symbol;
      const nameEn = String((item && item.engname) || '').trim();
      rows.push({
        symbol: parsed.symbol,
        code: parsed.code,
        name,
        market: 'HK',
        exchange: 'HKEX',
        board: HK_BOARD.id,
        kind: 'stock',
        ...(nameEn && nameEn !== name ? { nameEn } : {}),
      });
    }
    return {
      market: 'HK',
      board: HK_BOARD.id,
      label: HK_BOARD.label,
      exchange: 'HKEX',
      page: pn,
      size: pz,
      /** The feed publishes no row count; the walker stops on a short page. */
      total: null,
      pages: null,
      hasMore: rows.length >= pz,
      fetchedAt: Date.now(),
      rows,
    };
  }
}

export default SinaProvider;
