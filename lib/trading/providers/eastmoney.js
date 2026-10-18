/**
 * Eastmoney provider (东方财富).
 *
 * Why it exists: the spec names Yahoo as primary and Stooq as the historical
 * fallback (搂5), and this provider does not replace either of them. On the
 * machine this plugin was built on, both Yahoo and Stooq answer 403 for every
 * request (IP-level block), which would leave Trading Mode with no live data at
 * all. Adding Eastmoney — and Tencent as a second spare — behind the *same*
 * `MarketDataProvider` interface is exactly the extension point 搂7 describes,
 * and keeps 搂77.24's rule intact: nothing outside the provider layer knows that
 * Yahoo is unreachable.
 *
 * Endpoints used (public JSON, no scraping, 搂8):
 *  - push2.eastmoney.com/api/qt/stock/get        realtime quote
 *  - push2.eastmoney.com/api/qt/ulist.np/get     venue resolution for US tickers
 *  - push2his.eastmoney.com/api/qt/stock/kline/get  candles
 *  - searchapi.eastmoney.com/api/suggest/get     symbol search
 *
 * Quirks that are load-bearing (all verified against the live API):
 *  - prices are scaled integers: value / 10^f59 (f59 = 3 for US and HK).
 *  - ratios are basis points: changePct = f170 / 100.
 *  - `lmt` alone is IGNORED and the API answers `{"rc":102,"data":null}`; a
 *    `beg`/`end` window is mandatory, so every request computes `beg` from the
 *    requested range and slices the tail afterwards.
 *  - `fqt=1` (forward-adjusted) yields NEGATIVE prices for very old bars, so a
 *    window that comes back with a non-positive close is retried with `fqt=0`.
 *  - candle timestamps are Beijing wall-clock; daily bars carry a date only.
 */

import {
  MARKET_SESSIONS,
  PROVIDER_CONFIG,
  RANGE_CONFIG,
  SEARCH_RESULT_LIMIT,
  SEARCH_SECURITY_TYPES,
  UNIVERSE_PAGE_SIZE,
  candleLimit,
  universeBoard,
} from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { indexSupportFor } from '../indices.js';
import { MarketDataProvider, makeCandles, makeProfile, makeQuote } from '../schema.js';
import { currencyOf, eastmoneyCandidates, exchangeOf, parseSymbol, venueName } from '../symbols.js';
import { zonedParts, zonedWallClockToEpoch } from '../sessions.js';

const KLT = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': 101, '1wk': 102 };
/** Search result classes that name a tradable listing in a market we serve. */
const SEARCH_CLASSES = new Set(['UsStock', 'HK', 'AStock', 'JPX']);
/** Eastmoney market number → canonical market, for the suggest feed. */
const SEARCH_MARKETS = { 1: 'CN', 0: 'CN', 105: 'US', 106: 'US', 107: 'US', 116: 'HK', 176: 'JP' };
const QUOTE_FIELDS = [
  'f43', 'f44', 'f45', 'f46', 'f47', 'f48', 'f57', 'f58', 'f59', 'f60',
  'f84', 'f85', 'f86', 'f107', 'f116', 'f117', 'f127', 'f162', 'f167',
  'f169', 'f170', 'f171', 'f173', 'f174', 'f175', 'f183', 'f189',
].join(',');
const JYS_TO_EXCHANGE = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX', HK: 'HKEX', SSE: 'SSE', SZSE: 'SZSE', BSE: 'BSE', JPX: 'JPX' };
/** Oldest year worth asking for; keeps `max` from dragging in pre-split insanity. */
const EARLIEST_YEAR = 1990;
/** Mainland volume is quoted in lots (手 = 100 shares); every other market in shares. */
const CN_LOT_SIZE = 100;

export class EastmoneyProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'eastmoney', label: PROVIDER_CONFIG.eastmoney.label, ...opts });
    this.capabilities = { search: true, quote: true, candles: true, profile: true, universe: true };
    this.markets = PROVIDER_CONFIG.eastmoney.markets || ['US', 'HK', 'CN', 'JP'];
    /** Markets its bulk listing feed can page (see UNIVERSE_PROVIDERS). */
    this.listingMarkets = ['US', 'HK', 'CN', 'JP'];
    this.intervals = PROVIDER_CONFIG.eastmoney.intervals;
    this.secidCache = new Map();
    /** Last mirror that answered, per request kind. */
    this.goodHost = new Map();
    /** hostname → epoch ms until which it is skipped. */
    this.hostDownUntil = new Map();
  }

  timeZoneOf(market) {
    return (MARKET_SESSIONS[market] && MARKET_SESSIONS[market].timeZone) || 'America/New_York';
  }

  /**
   * Mirrors to try for one request kind, best-known host first and cooled-down
   * hosts last. `kind` is `quote` (stock/get, ulist, clist) or `history` (kline).
   */
  hostList(kind) {
    const cfg = PROVIDER_CONFIG.eastmoney;
    const pool = kind === 'history' ? cfg.historyHosts : cfg.quoteHosts;
    const now = Date.now();
    const ordered = [];
    const preferred = this.goodHost.get(kind);
    if (preferred) ordered.push(preferred);
    for (const host of pool) if (!ordered.includes(host)) ordered.push(host);
    const warm = ordered.filter((host) => (this.hostDownUntil.get(host) || 0) <= now);
    const cold = ordered.filter((host) => (this.hostDownUntil.get(host) || 0) > now);
    return [...warm, ...cold].slice(0, Math.max(1, cfg.maxHostsPerRequest || 4));
  }

  /**
   * Fetch one path from the first mirror that answers, remembering which host
   * worked. Every failure records the hostname, so a later run can tell *which*
   * alias was refused instead of concluding the whole provider is blocked.
   */
  async fetch(kind, pathWithQuery, opts = {}) {
    const cfg = PROVIDER_CONFIG.eastmoney;
    const errors = [];
    const hosts = this.hostList(kind);
    for (let index = 0; index < hosts.length; index += 1) {
      const host = hosts[index];
      try {
        // The first host gets a family-flipping retry (a connection that resets
        // per address family is not a dead mirror); the rest get a single attempt
        // each, because a mirror that just failed is the thing being worked
        // around, and `retries` defaults to 2 per request — six mirrors at three
        // attempts each would turn one dead provider into a minute-long stall.
        const res = await httpGet(`https://${host}${pathWithQuery}`, {
          provider: this.id,
          limiter: this.limiter,
          ...opts,
          retries: index === 0 ? Math.max(1, opts.retries ?? 1) : 0,
        });
        this.goodHost.set(kind, host);
        this.hostDownUntil.delete(host);
        return res;
      } catch (err) {
        this.hostDownUntil.set(host, Date.now() + (cfg.hostCooldownMs || 30_000));
        errors.push(`${host}: ${(err && err.message) || err}`);
      }
    }
    throw new TradingError(
      CODES.UPSTREAM_ERROR,
      `every eastmoney mirror failed for ${pathWithQuery.split('?')[0]} (${errors.join('; ')})`,
      { provider: this.id },
    );
  }

  /**
   * Market indices are outside the per-venue stock tables: Eastmoney serves them
   * under market number 100 and has no VIX/HSTECH at all. The directory decides,
   * so this provider is simply not offered for an index it cannot serve.
   */
  supportsSymbol(symbol, feature) {
    return indexSupportFor(this.id, symbol, feature);
  }

  /**
   * Resolve the `secid` (`<market>.<code>`) Eastmoney uses, which differs per
   * US venue (105 NASDAQ / 106 NYSE / 107 AMEX).
   */
  async resolveSecid(symbol) {
    const parsed = parseSymbol(symbol);
    if (parsed.kind === 'index') {
      const secid = parsed.index && parsed.index.eastmoneySecid;
      if (!secid) {
        throw new TradingError(CODES.NOT_FOUND, `eastmoney has no listing for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
      }
      this.secidCache.set(parsed.symbol, secid);
      return secid;
    }
    const cached = this.secidCache.get(parsed.symbol);
    if (cached !== undefined) {
      if (cached === null) throw new TradingError(CODES.NOT_FOUND, `eastmoney has no listing for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
      return cached;
    }
    const candidates = eastmoneyCandidates(parsed.symbol);
    // HK, mainland and Tokyo codes carry their market number in the symbol
    // already (`116.00700`, `1.600519`, `176.7203`), so the venue lookup is only
    // needed for US tickers, whose listing venue varies.
    if (parsed.market === 'HK' || parsed.market === 'CN' || parsed.market === 'JP') {
      const secid = candidates[0];
      this.secidCache.set(parsed.symbol, secid);
      return secid;
    }
    // One request resolves the venue; inexistent secids are simply absent.
    try {
      const res = await this.fetch('quote', `${PROVIDER_CONFIG.eastmoney.ulistPath}?secids=${candidates.join(',')}&fields=f12,f13&fltt=2`);
      const rows = (res.json && res.json.data && res.json.data.diff) || [];
      const hit = Array.isArray(rows) ? rows.find((r) => r && num(r.f13) !== null) : null;
      if (hit) {
        const secid = `${Math.trunc(num(hit.f13))}.${hit.f12}`;
        this.secidCache.set(parsed.symbol, secid);
        return secid;
      }
    } catch {
      /* fall through to the sequential probe below */
    }
    for (const secid of candidates) {
      try {
        const res = await this.fetch('quote', `${PROVIDER_CONFIG.eastmoney.quotePath}?secid=${secid}&fields=f43,f57&fltt=2`, {
          retries: 1,
        });
        if (res.json && res.json.data && num(res.json.data.f43) !== null) {
          this.secidCache.set(parsed.symbol, secid);
          return secid;
        }
      } catch {
        /* try the next venue */
      }
    }
    this.secidCache.set(parsed.symbol, null);
    throw new TradingError(CODES.NOT_FOUND, `eastmoney has no listing for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
  }

  async searchStocks(query, market) {
    const cfg = PROVIDER_CONFIG.eastmoney;
    // The suggest endpoint accepts up to 100 rows; a 20-row page left entire
    // market segments (ETFs, HK names behind a wall of A-shares) unreachable.
    const raw = String(query || '').trim();
    // Class shares are spelled with an underscore upstream (`BRK_B`); asking for
    // the ordinary `BRK.B` spelling answers nothing at all, so both spellings are
    // asked for and merged.
    const inputs = [raw];
    const underscored = raw.replace(/[.\-]/g, '_');
    if (underscored !== raw) inputs.push(underscored);
    const collected = [];
    const seenCodes = new Set();
    for (const input of inputs) {
      const url = `${cfg.searchUrl}?input=${encodeURIComponent(input)}&type=14&token=${cfg.searchToken}&count=${SEARCH_RESULT_LIMIT}`;
      const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
      const rows = (res.json && res.json.QuotationCodeTable && res.json.QuotationCodeTable.Data) || [];
      for (const r of rows) {
        if (!r || !r.Code) continue;
        const key = String(r.Code).toUpperCase();
        if (seenCodes.has(key)) continue;
        seenCodes.add(key);
        collected.push(r);
      }
      if (collected.length) break;
    }
    const needle = raw.toUpperCase();
    const out = [];
    const seen = new Set();
    for (const r of collected) {
      if (!r || !r.Code) continue;
      const classify = String(r.Classify || '');
      const code = String(r.Code).toUpperCase();
      const isExact = code === needle || code.replace(/_/g, '.') === needle;
      // The feed names the market itself (`Classify`: UsStock / HK / AStock /
      // JPX). Anything else — NEEQ, LSE, a fund house — is a look-alike that the
      // suggest endpoint mixes in for the same code (`7203` answers a Tokyo row
      // plus a Beijing and a London one) and must not become a symbol we claim.
      const mkt = marketFromClass(classify, num(r.MktNum));
      if (!mkt) continue;
      if (!isExact && !SEARCH_CLASSES.has(classify)) continue;
      // Measured TypeUS values: 1 US common, 3 ADR / HK common, 4 closed-end
      // fund, 5 ETF/ETN. 2 (bonds, OTC pink sheets), 6 (warrants) stay out. The
      // field is US-only: applying it to a mainland or Tokyo row would drop
      // every result whose code is not an exact match.
      if (!isExact && mkt === 'US' && !SEARCH_SECURITY_TYPES.has(String(r.TypeUS || ''))) continue;
      if (market && market !== mkt) continue;
      let parsed;
      try {
        parsed = parseSymbol(r.Code, mkt);
      } catch {
        continue;
      }
      if (parsed.market !== mkt) continue;
      if (seen.has(parsed.symbol)) continue;
      seen.add(parsed.symbol);
      const nameZh = /[\u4e00-\u9fff]/.test(String(r.Name || '')) ? r.Name : undefined;
      const typeUs = String(r.TypeUS || '');
      const marketNumber = num(r.MktNum) !== null ? Math.trunc(num(r.MktNum)) : null;
      out.push({
        symbol: parsed.symbol,
        exchangeSymbol: parsed.symbol,
        name: String(r.Name || parsed.symbol),
        ...(nameZh ? { nameZh } : {}),
        market: mkt,
        exchange: venueName(marketNumber) || JYS_TO_EXCHANGE[classify] || exchangeOf(mkt, parsed.board),
        currency: currencyOf(mkt),
        quoteType: typeUs === '5' ? 'ETF' : typeUs === '4' ? 'CEF' : mkt === 'HK' ? 'HK' : mkt,
      });
      if (out.length >= 30) break;
    }
    return out;
  }

  /**
   * Page through the complete listed-security table for a US or HK board
   * (`clist`). This is the only endpoint that exposes the *whole* universe:
   * search answers a relevance slice, so most tickers were unreachable before.
   *
   * Measured shape: `pz` is hard-capped at 100 rows per page, `pn` is
   * one-based, and `data.total` carries the board size. `f12` is the venue
   * code (`BRK_B`, `00001`), `f14` the (often Chinese) name, `f100` the sector.
   */
  async listSecurities({ market, board, page = 1, size = UNIVERSE_PAGE_SIZE } = {}) {
    const cfg = PROVIDER_CONFIG.eastmoney;
    let boardCfg;
    try {
      boardCfg = universeBoard(market, board);
    } catch (err) {
      throw new TradingError(CODES.BAD_REQUEST, err.message, { provider: this.id });
    }
    const pn = Math.max(1, Math.trunc(page) || 1);
    const pz = Math.min(UNIVERSE_PAGE_SIZE, Math.max(1, Math.trunc(size) || UNIVERSE_PAGE_SIZE));
    const path =
      `${cfg.clistPath}?pn=${pn}&pz=${pz}&po=0&np=1&ut=${cfg.clistToken}` +
      `&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(boardCfg.fs)}&fields=f12,f13,f14,f100`;
    const res = await this.fetch('quote', path);
    const data = res.json && res.json.data;
    const rows = (data && data.diff && Object.values(data.diff)) || [];
    const records = [];
    for (const r of rows) {
      if (!r || !r.f12) continue;
      let parsed;
      try {
        parsed = parseSymbol(r.f12, market);
      } catch {
        continue;
      }
      if (parsed.market !== market) continue;
      const name = String(r.f14 || '').trim() || parsed.symbol;
      const nameZh = /[\u4e00-\u9fff]/.test(name) ? name : undefined;
      records.push({
        symbol: parsed.symbol,
        code: r.f12,
        name,
        ...(nameZh ? { nameZh } : {}),
        market,
        exchange: venueName(num(r.f13) === null ? null : Math.trunc(num(r.f13))) || boardCfg.exchange,
        board: boardCfg.id,
        industry: r.f100 ? String(r.f100) : undefined,
        kind: 'stock',
      });
    }
    return {
      market,
      board: boardCfg.id,
      label: boardCfg.label,
      exchange: boardCfg.exchange,
      page: pn,
      size: pz,
      total: data && num(data.total) !== null ? Math.trunc(num(data.total)) : records.length,
      pages: data && num(data.total) !== null ? Math.ceil(Math.trunc(num(data.total)) / pz) : null,
      rows: records,
    };
  }

  /**
   * Realtime quote; `name`/`nameZh` are merged in by the service from the symbol
   * directory.
   *
   * `fltt=2` makes the server answer real numbers (`f43` = 1258.62 rather than
   * 125862 with `f59` = 2, `f170` = 1.86 rather than 186, `f162` = 17.67 rather
   * than 1767). Measured identical across US/HK/CN/JP quotes and indices, and
   * measured *unchanged* for volume, turnover, market cap and share count — so
   * only the price/ratio dialect depends on it.
   */
  async getQuote(symbol) {
    const parsed = parseSymbol(symbol);
    const secid = await this.resolveSecid(parsed.symbol);
    const cfg = PROVIDER_CONFIG.eastmoney;
    const res = await this.fetch('quote', `${cfg.quotePath}?secid=${secid}&fields=${QUOTE_FIELDS}&fltt=2`);
    const d = res.json && res.json.data;
    if (!d || num(d.f43) === null) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `eastmoney returned no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const nameRaw = typeof d.f58 === 'string' ? d.f58 : '';
    const isZh = /[\u4e00-\u9fff]/.test(nameRaw);
    const lots = num(d.f47);
    return makeQuote({
      symbol: parsed.symbol,
      market: parsed.market,
      currency: currencyOf(parsed.market),
      price: num(d.f43),
      change: num(d.f169),
      changePct: num(d.f170),
      open: num(d.f46),
      high: num(d.f44),
      low: num(d.f45),
      previousClose: num(d.f60),
      // A mainland quote reports 手 (lots of 100 shares) while every other market
      // reports shares; quoted in shares so the number means one thing.
      volume: lots === null ? null : parsed.market === 'CN' ? lots * CN_LOT_SIZE : lots,
      timestamp: num(d.f86) ? num(d.f86) * 1000 : Date.now(),
      source: this.id,
      delaySeconds: cfg.delaySeconds,
      ...(isZh ? { nameZh: nameRaw } : { name: nameRaw || undefined }),
      exchange: exchangeOf(parsed.market, parsed.board),
    });
  }

  async getCandles(symbol, interval, range) {
    const parsed = parseSymbol(symbol);
    const klt = KLT[interval];
    if (!klt) throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `eastmoney does not support interval ${interval}`, { provider: this.id, symbol: parsed.symbol });
    const secid = await this.resolveSecid(parsed.symbol);
    const beg = this.beginDate(range, parsed.market);
    const cfg = PROVIDER_CONFIG.eastmoney;
    const build = (fqt) =>
      `${cfg.klinePath}?secid=${secid}&klt=${klt}&fqt=${fqt}&beg=${beg}&end=20500101` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
    const load = async (fqt) => {
      const res = await this.fetch('history', build(fqt));
      const rows = res.json && res.json.data && res.json.data.klines;
      return Array.isArray(rows) ? rows : null;
    };
    // Mainland and Tokyo series were verified unadjusted; the US/HK series were
    // verified adjusted. Either way the other spelling is tried when the first
    // returns nothing.
    const firstFqt = parsed.market === 'CN' || parsed.market === 'JP' ? 0 : 1;
    const secondFqt = firstFqt === 1 ? 0 : 1;
    let raw = await load(firstFqt);
    if (!raw) raw = await load(secondFqt);
    if (!raw || !raw.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `eastmoney returned no candles for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    let rows = parseKlines(raw, interval, this.timeZoneOf(parsed.market));
    // Forward adjustment can drive distant history negative; prefer raw prices then.
    if (rows.some((r) => r.close <= 0)) {
      const unadjusted = await load(0).catch(() => null);
      if (unadjusted && unadjusted.length) {
        const alt = parseKlines(unadjusted, interval, this.timeZoneOf(parsed.market));
        if (alt.length && !alt.some((r) => r.close <= 0)) rows = alt;
      }
    }
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `eastmoney returned an unusable candle series for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const want = Math.max(30, candleLimit(range, interval, parsed.market));
    return candles.slice(-Math.min(want, candles.length));
  }

  /** Candles are also the cheapest profile source Eastmoney offers (no fundamentals API is reachable). */
  async getCompanyProfile(symbol) {
    const parsed = parseSymbol(symbol);
    const secid = await this.resolveSecid(parsed.symbol);
    const cfg = PROVIDER_CONFIG.eastmoney;
    const res = await this.fetch('quote', `${cfg.quotePath}?secid=${secid}&fields=${QUOTE_FIELDS}&fltt=2`);
    const d = res.json && res.json.data;
    if (!d) throw new TradingError(CODES.DATA_UNAVAILABLE, `eastmoney returned no profile for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    const nameRaw = typeof d.f58 === 'string' ? d.f58 : '';
    const isZh = /[\u4e00-\u9fff]/.test(nameRaw);
    const listed = num(d.f189) !== null ? String(Math.trunc(num(d.f189))) : null;
    return makeProfile({
      symbol: parsed.symbol,
      market: parsed.market,
      name: isZh ? parsed.symbol : nameRaw || parsed.symbol,
      nameZh: isZh ? nameRaw : undefined,
      exchange: exchangeOf(parsed.market, parsed.board),
      currency: currencyOf(parsed.market),
      industry: typeof d.f127 === 'string' ? d.f127 : undefined,
      marketCap: num(d.f116),
      // With `fltt=2` the ratio fields arrive in real units (600519: 17.67).
      peRatio: num(d.f162) || null,
      sharesOutstanding: num(d.f84),
      // No fundamentals endpoint is reachable, so the field stays explicitly
      // absent rather than being invented (搂34 rule 2).
      description: listed ? `Listed ${listed.slice(0, 4)}-${listed.slice(4, 6)}-${listed.slice(6, 8)}.` : undefined,
      source: this.id,
      timestamp: num(d.f86) ? num(d.f86) * 1000 : Date.now(),
    });
  }

  /** `beg` (YYYYMMDD, Beijing) that comfortably covers the requested range. */
  beginDate(range, market) {
    const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['6mo'];
    const p = zonedParts(new Date(), 'Asia/Shanghai');
    const days = Math.min(cfg.days * 2 + 20, 18_000);
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day) - days * 86_400_000);
    const y = Math.max(EARLIEST_YEAR, dt.getUTCFullYear());
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
}

/**
 * The market a suggest row belongs to: its own `Classify` first (the feed speaks
 * it clearly), then the market number as a fallback for rows that carry a
 * legitimate number but an unfamiliar class. `null` means "not a market we
 * serve", which is how look-alike rows from other venues and boards are dropped.
 */
function marketFromClass(classify, marketNumber) {
  if (classify === 'UsStock') return 'US';
  if (classify === 'HK') return 'HK';
  if (classify === 'AStock') return 'CN';
  if (classify === 'JPX') return 'JP';
  if (/^(NEEQ|LSE|BSE|OTC|FUND)/i.test(classify)) return null;
  const byNumber = marketNumber !== null ? SEARCH_MARKETS[Math.trunc(marketNumber)] : undefined;
  return byNumber || null;
}

/**
 * Eastmoney kline rows: `date,open,close,high,low,volume,turnover,amplitude,changePct,change,turnoverRate`
 * (note open/close/high/low order — not the OHLC order the other providers use).
 */
function parseKlines(rows, interval, timeZone) {
  const intraday = interval !== '1d' && interval !== '1wk';
  const out = [];
  for (const line of rows) {
    const cells = String(line).split(',');
    if (cells.length < 6) continue;
    const [dateText, open, close, high, low, volume] = cells;
    const timestamp = intraday
      ? zonedWallClockToEpoch(dateText, 'Asia/Shanghai')
      : zonedWallClockToEpoch(`${dateText} 12:00`, timeZone);
    if (!Number.isFinite(timestamp)) continue;
    out.push({ timestamp, open: Number(open), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume) });
  }
  return out;
}
