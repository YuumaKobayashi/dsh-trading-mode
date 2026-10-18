/**
 * Nasdaq provider — the US listing fallback (added in 0.4.1).
 *
 * Eastmoney's bulk `clist` feed is the primary source for the browse/list UI, but
 * it is also the endpoint that gets refused from this network for stretches of
 * time (measured: TCP reset while `stock/get` keeps answering). Nasdaq publishes
 * its own screener table, which returns a whole exchange in a single request —
 * measured 2026-10-07: NASDAQ 4,033 / NYSE 2,690 / AMEX 293 rows, ~1.2 s each —
 * so when `clist` is down the browser still shows the whole US market.
 *
 * Boards mirror the primary feed's vocabulary (NASDAQ / NYSE / AMEX) so switching
 * boards keeps working when the fallback takes over.
 *
 * Capability scope is deliberately narrow: listings only. Quotes and candles
 * stay with the regular chain, so no business code sees a second quote source.
 *
 * Trade-off (documented in the delivery report): English names only, and the
 * screener covers listed stocks rather than eastmoney's full ETF/ETN tail.
 */

import { PROVIDER_CONFIG } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet } from '../http.js';
import { MarketDataProvider } from '../schema.js';

/** The `exchange` query values the screener accepts, one board each. */
const EXCHANGE_BOARDS = [
  { id: 'NASDAQ', label: 'NASDAQ', exchange: 'NASDAQ', query: 'nasdaq' },
  { id: 'NYSE', label: 'NYSE', exchange: 'NYSE', query: 'nyse' },
  { id: 'AMEX', label: 'AMEX', exchange: 'AMEX', query: 'amex' },
];
const SYMBOL_SHAPE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export class NasdaqProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'nasdaq', label: PROVIDER_CONFIG.nasdaq.label, ...opts });
    this.capabilities = { search: false, quote: false, candles: false, profile: false, universe: true };
    this.markets = ['US'];
    /** It lists the US market only, whatever else it might be asked for. */
    this.listingMarkets = ['US'];
    this.intervals = PROVIDER_CONFIG.nasdaq.intervals;
    /** One cached table per board id, fetched on first use. */
    this.tables = new Map();
  }

  supportsSymbol() {
    return true;
  }

  /** Nasdaq lists US stocks only; the HK browser keeps eastmoney/sina. */
  boards(market) {
    if (market !== 'US') return [];
    return EXCHANGE_BOARDS.map((b) => ({ id: b.id, label: b.label, exchange: b.exchange, market: 'US' }));
  }

  boardConfig(board) {
    if (board === undefined || board === null || board === '') return EXCHANGE_BOARDS[0];
    const raw = String(board).trim().toUpperCase();
    return EXCHANGE_BOARDS.find((b) => b.id === raw || b.query === raw.toLowerCase()) || null;
  }

  /** One request fetches an entire exchange; everything else slices the cached rows. */
  async fetchTable(boardId) {
    const board = this.boardConfig(boardId) || EXCHANGE_BOARDS[0];
    const cfg = PROVIDER_CONFIG.nasdaq;
    const url = `${cfg.base}${cfg.screenerPath}?tableonly=true&limit=${cfg.limit}&offset=0&download=false&exchange=${board.query}`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter, headers: cfg.headers });
    const table = res.json && res.json.data && res.json.data.table;
    const raw = table && Array.isArray(table.rows) ? table.rows : null;
    if (!raw) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `nasdaq returned no ${board.id} listing table`, { provider: this.id });
    }
    const rows = [];
    for (const item of raw) {
      const code = String((item && item.symbol) || '').trim().toUpperCase();
      if (!code || !SYMBOL_SHAPE.test(code)) continue;
      rows.push({
        symbol: code,
        code,
        name: String((item && item.name) || '').trim() || code,
        market: 'US',
        exchange: board.exchange,
        board: board.id,
        industry: item && item.industry ? String(item.industry) : undefined,
        kind: 'stock',
      });
    }
    if (!rows.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `nasdaq ${board.id} listing table was empty`, { provider: this.id });
    }
    const total = Number(table.totalrecords) || rows.length;
    const entry = { rows, total, board, fetchedAt: Date.now() };
    this.tables.set(board.id, entry);
    return entry;
  }

  async tableOrFetch(boardId) {
    const cached = this.tables.get(boardId);
    if (cached) return cached;
    return this.fetchTable(boardId);
  }

  /**
   * The upstream feed has no paging; pages are slices of the cached table, which
   * keeps the interface identical to eastmoney's feed.
   */
  async listSecurities({ market, board, page = 1, size = 100 } = {}) {
    if (market && market !== 'US') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `nasdaq lists the US market only (got ${market})`);
    }
    const wanted = this.boardConfig(board);
    if (!wanted) {
      throw new TradingError(CODES.BAD_REQUEST, `nasdaq does not publish the ${board} board`, { provider: this.id });
    }
    const table = await this.tableOrFetch(wanted.id);
    const pz = Math.max(1, Math.trunc(Number(size)) || 100);
    const pn = Math.max(1, Math.trunc(Number(page)) || 1);
    const offset = (pn - 1) * pz;
    const rows = table.rows.slice(offset, offset + pz);
    if (!rows.length && pn > 1) {
      throw new TradingError(CODES.NOT_FOUND, `nasdaq ${wanted.id} listing page ${pn} is past the end of the table`, {
        provider: this.id,
      });
    }
    return {
      market: 'US',
      board: wanted.id,
      label: wanted.label,
      exchange: wanted.exchange,
      page: pn,
      size: pz,
      total: table.total,
      pages: Math.max(1, Math.ceil(table.total / pz)),
      fetchedAt: table.fetchedAt,
      rows,
    };
  }
}

export default NasdaqProvider;
