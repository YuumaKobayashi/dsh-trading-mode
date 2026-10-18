/**
 * Full listing universe (added in 0.4.0).
 *
 * Why it exists: the remote search endpoint only ever answers a relevance slice
 * of a market, so "Add Stock" could reach a few hundred names out of ~13.8k US
 * and ~3.4k HK listings — most ETFs, and any HK company whose Chinese name is
 * buried under a wall of A-share matches, could not be added at all.
 *
 * This module walks the provider's bulk listing feed board by board, keeps the
 * rows it has seen in a searchable index, and persists that index so the browser
 * works offline-first on the next launch. It never invents data: every row comes
 * from the provider layer (spec §14/§16), and a board that cannot be fetched is
 * simply absent from the totals rather than reported as empty.
 */

import fs from 'node:fs';
import path from 'node:path';

import { MARKETS, MAX_UNIVERSE_BYTES, UNIVERSE_PAGE_LIMIT, UNIVERSE_PAGE_SIZE, UNIVERSE_POLICY, UNIVERSE_PROVIDERS, universeBoards } from './config.js';
import { CODES, TradingError } from './errors.js';
import { isMarket, parseSymbol } from './symbols.js';

const SCHEMA_VERSION = 1;
/** Persistence is throttled: a bulk walk touches the disk every N pages. */
const FLUSH_EVERY_PAGES = 20;
const DIGITS = /^\d+$/;

function nowMs() {
  return Date.now();
}

export class StockUniverse {
  constructor({ logger, provider, providers, homeDir, filePath } = {}) {
    this.logger = logger || null;
    /** Ordered listing providers; the first one that answers is remembered. */
    this.providers = Array.isArray(providers) && providers.length ? providers.slice() : provider ? [provider] : [];
    /** market → provider that last answered (sticks until it fails). */
    this.active = new Map();
    this.filePath = filePath || path.join(homeDir || process.cwd(), 'trading-mode', 'universe.json');
    /** market → Map<symbol, record> */
    this.rows = new Map();
    /** `MARKET:BOARD` → { total, pages, fetchedAt, complete } */
    this.totals = new Map();
    /** `MARKET:BOARD:page` → { at, rows } */
    this.pages = new Map();
    this.readOnly = false;
    this.lastError = null;
    this.writes = 0;
    this.updatedAt = null;
    this.loading = null;
    /** Abort controller of the walk in flight (0.7.0), so it can be cancelled. */
    this.controller = null;
    /** Why the last walk stopped early: 'cancelled' | 'budget' | null. */
    this.cancelReason = null;
  }

  setProvider(provider) {
    this.providers = provider ? [provider] : [];
    this.active.clear();
  }

  setProviders(providers) {
    this.providers = Array.isArray(providers) ? providers.filter(Boolean) : [];
    this.active.clear();
  }

  /** Listed providers able to serve a market, in configured order. */
  chainFor(market) {
    const configured = UNIVERSE_PROVIDERS[market] || [];
    const capable = (p) =>
      p && typeof p.listSecurities === 'function' && (p.listingMarkets || p.markets || []).includes(market);
    const out = [];
    for (const id of configured) {
      const provider = this.providers.find((p) => p && p.id === id && capable(p));
      if (provider) out.push(provider);
    }
    // Anything not named in the config but capable still gets a turn.
    for (const provider of this.providers) {
      if (!capable(provider)) continue;
      if (!out.includes(provider)) out.push(provider);
    }
    return out;
  }

  /** Board descriptors of one provider (providers may publish their own list). */
  boardsFor(provider, market) {
    if (provider && typeof provider.boards === 'function') {
      const boards = provider.boards(market);
      if (Array.isArray(boards) && boards.length) return boards;
    }
    return universeBoards(market);
  }

  /** Load the persisted snapshot; never throws — a broken file only means "empty". */
  async init() {
    try {
      const text = await fs.promises.readFile(this.filePath, 'utf8');
      if (text.length > MAX_UNIVERSE_BYTES) {
        this.lastError = `universe snapshot larger than ${MAX_UNIVERSE_BYTES} bytes`;
        if (this.logger) this.logger.warn(`[trading-mode] ${this.lastError}`);
        return this;
      }
      const parsed = JSON.parse(text);
      if (parsed && parsed.rows) {
        for (const [market, list] of Object.entries(parsed.rows)) {
          if (!isMarket(market) || !Array.isArray(list)) continue;
          const bucket = new Map();
          for (const row of list) {
            if (!Array.isArray(row) || !row[0]) continue;
            bucket.set(row[0], {
              symbol: row[0],
              name: row[1] || row[0],
              market,
              board: row[2] || undefined,
              exchange: row[3] || (market === 'HK' ? 'HKEX' : market === 'CRYPTO' ? 'CRYPTO' : undefined),
              industry: row[4] || undefined,
              kind: row[5] || 'stock',
              nameZh: row[6] || undefined,
              nameEn: row[7] || undefined,
            });
          }
          this.rows.set(market, bucket);
        }
      }
      if (parsed && parsed.totals) {
        for (const [key, total] of Object.entries(parsed.totals)) {
          if (typeof total === 'number') this.totals.set(key, { total, pages: Math.ceil(total / UNIVERSE_PAGE_SIZE), complete: false, fetchedAt: parsed.updatedAt || null });
        }
      }
      this.updatedAt = parsed && parsed.updatedAt ? parsed.updatedAt : null;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        this.lastError = err && err.message ? err.message : String(err);
        if (this.logger) this.logger.warn(`[trading-mode] universe snapshot unreadable: ${this.lastError}`);
      }
    }
    return this;
  }

  loadedCount(market) {
    const bucket = this.rows.get(market);
    return bucket ? bucket.size : 0;
  }

  /**
   * Board descriptors for the API/UI, annotated with what has been fetched.
   *
   * The active provider decides the list: when eastmoney answers the browser
   * shows NASDAQ/NYSE/AMEX (or the three HK boards), and when the fallback feed
   * is serving it shows that feed's own boards instead of offering a board the
   * backend cannot page.
   */
  boards(market) {
    const markets = market && isMarket(market) ? [market] : MARKETS.slice();
    const out = [];
    for (const m of markets) {
      const chain = this.chainFor(m);
      const provider = this.active.get(m) && chain.includes(this.active.get(m)) ? this.active.get(m) : chain[0];
      const boards = provider ? this.boardsFor(provider, m) : universeBoards(m);
      for (const board of boards) {
        const key = `${m}:${board.id}`;
        const meta = this.totals.get(key);
        out.push({
          market: m,
          id: board.id,
          label: board.label,
          exchange: board.exchange,
          provider: provider ? provider.id : null,
          total: meta ? meta.total : null,
          pages: meta ? meta.pages : null,
          complete: Boolean(meta && meta.complete),
          fetchedAt: meta ? meta.fetchedAt : null,
        });
      }
    }
    return out;
  }

  /**
   * One page straight from a listing provider, cached in memory and folded into
   * the searchable index. `page` is one-based, mirroring the upstream feeds.
   *
   * Providers are tried in configured order — the preferred feed first, then the
   * fallback — and whichever answers becomes the active feed for that market.
   * A board id that the active feed does not publish falls back to its default
   * board, so a UI opened on `NASDAQ` keeps working when the US feed switches to
   * the single-board Nasdaq table.
   */
  async page({ market, board, page = 1, size = UNIVERSE_PAGE_SIZE, force = false } = {}) {
    if (!isMarket(market)) {
      throw new TradingError(CODES.BAD_REQUEST, `universe market must be one of ${MARKETS.join(', ')} (got ${market})`);
    }
    const chain = this.chainFor(market);
    if (!chain.length) {
      throw new TradingError(CODES.NO_PROVIDER, `no provider can list the ${market} universe`);
    }
    const pn = Math.min(UNIVERSE_PAGE_LIMIT, Math.max(1, Math.trunc(Number(page)) || 1));
    const pz = Math.min(UNIVERSE_PAGE_SIZE, Math.max(1, Math.trunc(Number(size)) || UNIVERSE_PAGE_SIZE));
    const requested = board === undefined || board === null || board === '' ? null : String(board).trim();
    if (requested && !this.knownBoard(market, requested)) {
      throw new TradingError(CODES.BAD_REQUEST, `unknown board "${requested}" for the ${market} universe`);
    }
    const active = this.active.get(market);
    const ordered = active && chain.includes(active) ? [active, ...chain.filter((p) => p !== active)] : chain;
    const failures = [];
    for (const provider of ordered) {
      let boardCfg = null;
      try {
        boardCfg = this.resolveBoard(provider, market, board);
      } catch (err) {
        failures.push({ provider: provider.id, error: err.message, code: CODES.BAD_REQUEST });
        continue;
      }
      const key = `${market}:${boardCfg.id}:${pn}:${pz}`;
      const cached = this.pages.get(key);
      if (cached && !force) {
        this.active.set(market, provider);
        return { ...cached.value, provider: provider.id, cached: true };
      }
      try {
        const result = await provider.listSecurities({ market, board: boardCfg.id, page: pn, size: pz });
        const value = { ...result, board: boardCfg.id, boardFallback: boardCfg.fallback === true };
        this.pages.set(key, { at: nowMs(), value });
        this.active.set(market, provider);
        this.absorb(market, boardCfg.id, value);
        this.scheduleFlush();
        return { ...value, provider: provider.id, cached: false };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        failures.push({ provider: provider.id, error: message, code: (err && err.code) || CODES.UPSTREAM_ERROR });
        this.lastError = `${market} universe via ${provider.id}: ${message}`;
        if (this.logger) this.logger.warn(`[trading-mode] ${this.lastError}`);
      }
    }
    const detail = failures.map((f) => `${f.provider}: ${f.error}`).join('; ');
    throw new TradingError(CODES.DATA_UNAVAILABLE, `the ${market} listing feed is unavailable (${detail})`, {
      provider: failures.map((f) => f.provider).join(','),
    });
  }

  /**
   * A board id is valid when any feed — or the shared board config — publishes it.
   * A *known* board that the serving feed does not carry is not an error: the feed
   * answers with its own default board and flags `boardFallback`. A board nobody
   * publishes is a caller mistake and must surface instead of silently walking the market.
   */
  knownBoard(market, board) {
    const raw = String(board).trim().toUpperCase();
    const pool = [...universeBoards(market)];
    for (const provider of this.chainFor(market)) pool.push(...this.boardsFor(provider, market));
    return pool.some((b) => (b.id && b.id.toUpperCase() === raw) || (b.fs && b.fs === String(board).trim()));
  }

  /** Resolve a board id against one provider, falling back to its default board. */
  resolveBoard(provider, market, board) {
    const boards = this.boardsFor(provider, market);
    if (!boards.length) throw new TradingError(CODES.BAD_REQUEST, `provider ${provider.id} lists no ${market} boards`);
    if (board === undefined || board === null || board === '') return { ...boards[0] };
    const raw = String(board).trim();
    const hit = boards.find((b) => b.id.toUpperCase() === raw.toUpperCase() || (b.fs && b.fs === raw));
    if (hit) return { ...hit };
    // A board from another feed's vocabulary (e.g. NASDAQ after the US feed
    // switched) is not an error: page the default board instead.
    return { ...boards[0], fallback: true };
  }

  /** Fold a provider page into the searchable index and record the board total. */
  absorb(market, boardId, result) {
    let bucket = this.rows.get(market);
    if (!bucket) {
      bucket = new Map();
      this.rows.set(market, bucket);
    }
    for (const row of (result && result.rows) || []) {
      if (!row || !row.symbol) continue;
      bucket.set(row.symbol, {
        symbol: row.symbol,
        name: row.name || row.symbol,
        market,
        board: row.board || boardId,
        exchange: row.exchange,
        industry: row.industry,
        kind: row.kind || 'stock',
        nameZh: row.nameZh,
        nameEn: row.nameEn,
      });
    }
    const key = `${market}:${boardId}`;
    const prev = this.totals.get(key);
    const total = result && typeof result.total === 'number' ? result.total : prev ? prev.total : null;
    const pages = result && typeof result.pages === 'number' ? result.pages : prev ? prev.pages : null;
    this.totals.set(key, {
      total,
      pages: pages || (total ? Math.ceil(total / UNIVERSE_PAGE_SIZE) : null),
      complete: prev && prev.complete ? true : false,
      fetchedAt: nowMs(),
    });
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Walk one board (or a whole market) end to end. Progress is reported per page
   * so the caller can stream status back to the UI, and the snapshot is written
   * as it goes: an interrupted walk still leaves a usable index behind.
   *
   * The walk stops on the last page when the feed publishes a page count, and on
   * the first short page when it does not (the Sina HK list publishes no total).
   */
  async loadAll({ market, board, size = UNIVERSE_PAGE_SIZE, signal, onProgress, budgetMs } = {}) {
    const markets = market && isMarket(market) ? [market] : MARKETS.slice();
    if (board !== undefined && board !== null && board !== '') {
      for (const m of markets) {
        if (!this.knownBoard(m, board)) {
          throw new TradingError(CODES.BAD_REQUEST, `unknown board "${String(board).trim()}" for the ${m} universe`);
        }
      }
    }
    const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : UNIVERSE_POLICY.budgetMs;
    const deadline = budget > 0 ? nowMs() + budget : Number.POSITIVE_INFINITY;
    const controller = new AbortController();
    this.controller = controller;
    this.cancelReason = null;
    const relayAbort = () => {
      if (!this.cancelReason) this.cancelReason = 'cancelled';
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    };
    if (signal) {
      if (signal.aborted) relayAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', relayAbort, { once: true });
    }
    /** Why the walk should stop right now, or null to continue. */
    const stopReason = () => {
      if (this.cancelReason) return this.cancelReason;
      if (signal && signal.aborted) return 'cancelled';
      if (nowMs() > deadline) return 'budget';
      return null;
    };
    const summary = {
      markets: [],
      rows: 0,
      complete: true,
      reason: null,
      budgetMs: budget > 0 ? budget : null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    try {
      for (const m of markets) {
        const chain = this.chainFor(m);
        if (!chain.length) {
          summary.complete = false;
          summary.reason = summary.reason || 'no provider for this market';
          continue;
        }
        const provider = this.active.get(m) && chain.includes(this.active.get(m)) ? this.active.get(m) : chain[0];
        let boards = this.boardsFor(provider, m);
        if (board) {
          const wanted = String(board).trim().toUpperCase();
          const hit = boards.find((b) => b.id.toUpperCase() === wanted || b.id === board);
          boards = hit ? [hit] : [{ ...boards[0], fallback: true }];
        }
        for (const b of boards) {
          const stopBeforeBoard = stopReason();
          if (stopBeforeBoard) {
            summary.complete = false;
            summary.reason = summary.reason || stopBeforeBoard;
            break;
          }
          let pn = 1;
          let count = 0;
          let exhausted = false;
          for (;;) {
            const stop = stopReason();
            if (stop) {
              summary.complete = false;
              summary.reason = summary.reason || stop;
              break;
            }
            const pg = await this.page({ market: m, board: b.id, page: pn, size, force: pn === 1 });
            count += pg.rows.length;
            const pages = typeof pg.pages === 'number' ? pg.pages : null;
            if (onProgress) onProgress({ market: m, board: pg.board || b.id, page: pn, pages, total: pg.total, rows: count, provider: pg.provider });
            if (pn % FLUSH_EVERY_PAGES === 0) await this.flush();
            if (pages ? pn >= pages : pg.rows.length < size) {
              exhausted = true;
              break;
            }
            pn += 1;
            if (pn > UNIVERSE_PAGE_LIMIT) break;
          }
          const finalBoard = (this.active.get(m) && this.boardsFor(this.active.get(m), m).find((x) => x.id === b.id)) || b;
          const key = `${m}:${finalBoard.id}`;
          const meta = this.totals.get(key);
          if (meta) this.totals.set(key, { ...meta, complete: exhausted ? true : meta.complete });
          if (!exhausted) summary.complete = false;
          summary.markets.push({ market: m, board: finalBoard.id, rows: count, pages: meta ? meta.pages : null, complete: exhausted });
          if (stopReason()) break;
        }
      }
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', relayAbort);
      this.controller = null;
    }
    summary.rows = this.totalRows();
    summary.cancelled = summary.reason === 'cancelled';
    summary.finishedAt = new Date().toISOString();
    if (!summary.complete && !summary.reason) summary.reason = 'incomplete walk';
    await this.flush();
    return summary;
  }

  /** Rows held across every market (0.7.0: the old US+HK sum under-reported). */
  totalRows() {
    return MARKETS.reduce((sum, m) => sum + this.loadedCount(m), 0);
  }

  /** Background walk: only one may run at a time. */
  async refresh({ market, board, signal, onProgress, budgetMs } = {}) {
    if (this.loading) return { started: false, running: true, already: true };
    const run = this.loadAll({ market, board, signal, onProgress, budgetMs })
      .catch((err) => {
        this.lastError = err && err.message ? err.message : String(err);
        if (this.logger) this.logger.warn(`[trading-mode] universe refresh failed: ${this.lastError}`);
        return { error: this.lastError };
      })
      .then((result) => {
        this.loading = null;
        return result;
      });
    this.loading = run;
    return { started: true, running: true };
  }

  /**
   * Stop the walk that is currently running (0.7.0). Rows already absorbed stay,
   * the summary reports `complete: false` + `reason: 'cancelled'`, and the caller
   * gets an explicit answer instead of a promise that never settles.
   */
  cancel(reason = 'cancelled') {
    const running = Boolean(this.loading);
    this.cancelReason = String(reason || 'cancelled');
    if (this.controller) {
      try {
        this.controller.abort();
      } catch {
        /* nothing to abort */
      }
    }
    return { cancelled: running, running, reason: this.cancelReason };
  }

  /** Local substring search across everything fetched so far. */
  search(query, { market, limit = 20 } = {}) {
    const raw = typeof query === 'string' ? query.trim() : '';
    if (!raw) return [];
    const upper = raw.toUpperCase();
    const numeric = DIGITS.test(raw);
    const markets = market && isMarket(market) ? [market] : MARKETS.slice();
    const hits = [];
    for (const m of markets) {
      const bucket = this.rows.get(m);
      if (!bucket) continue;
      for (const row of bucket.values()) {
        const symbol = row.symbol.toUpperCase();
        // `0700.HK` / `600519.SH` / `7203.T` all answer to their bare code too.
        const bare = symbol.includes('.') ? symbol.slice(0, symbol.lastIndexOf('.')) : symbol;
        const bareShort = bare.replace(/^0+/, '');
        const name = String(row.name || '').toUpperCase();
        let score = 0;
        if (symbol === upper || bare === upper) score = 1000;
        else if (numeric && (bareShort === raw.replace(/^0+/, '') || bare === raw)) score = 900;
        else if (symbol.startsWith(upper)) score = 500;
        else if (name === upper) score = 400;
        else if (name.startsWith(upper)) score = 300;
        else if (name.includes(raw)) score = 200;
        else if (symbol.includes(upper)) score = 120;
        else continue;
        // Exchange-traded products are useful but should not outrank a company
        // with the same prefix, matching the remote ranker's policy.
        if (/ETF|ETN|基金|信托|牛|熊|购|沽/i.test(row.name || '')) score -= 60;
        hits.push({ ...row, score });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    return hits.slice(0, Math.max(1, limit)).map(({ score, ...row }) => row);
  }

  /** Resolve one symbol to its universe record (used to enrich arbitrary adds). */
  lookup(symbol) {
    let parsed;
    try {
      parsed = parseSymbol(symbol);
    } catch {
      return null;
    }
    const bucket = this.rows.get(parsed.market);
    return bucket ? bucket.get(parsed.symbol) || null : null;
  }

  scheduleFlush() {
    if (this.flushTimer || this.readOnly) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 2000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  snapshot() {
    const rows = {};
    for (const [market, bucket] of this.rows) {
      rows[market] = Array.from(bucket.values()).map((r) => [
        r.symbol,
        r.name,
        r.board || '',
        r.exchange || '',
        r.industry || '',
        r.kind || '',
        r.nameZh || '',
        r.nameEn || '',
      ]);
    }
    const totals = {};
    for (const [key, meta] of this.totals) totals[key] = meta.total;
    return { version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), totals, rows };
  }

  async flush() {
    if (this.readOnly) return false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const payload = JSON.stringify(this.snapshot());
      if (payload.length > MAX_UNIVERSE_BYTES) {
        this.lastError = `universe snapshot exceeds ${MAX_UNIVERSE_BYTES} bytes; keeping the previous copy`;
        if (this.logger) this.logger.warn(`[trading-mode] ${this.lastError}`);
        return false;
      }
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
      this.writes += 1;
      return true;
    } catch (err) {
      this.readOnly = true;
      this.lastError = err && err.message ? err.message : String(err);
      if (this.logger) this.logger.warn(`[trading-mode] universe snapshot not persisted: ${this.lastError}`);
      return false;
    }
  }

  status() {
    const meta = {};
    for (const [key, value] of this.totals) meta[key] = { ...value };
    const providers = [];
    for (const market of MARKETS) {
      for (const provider of this.chainFor(market)) {
        providers.push({
          id: provider.id,
          label: provider.label,
          market,
          active: this.active.get(market) === provider,
          boards: this.boardsFor(provider, market).map((b) => b.id),
        });
      }
    }
    const counts = Object.fromEntries(MARKETS.map((m) => [m, this.loadedCount(m)]));
    return {
      size: this.totalRows(),
      counts,
      boards: this.boards(),
      totals: meta,
      providers,
      updatedAt: this.updatedAt,
      refreshing: Boolean(this.loading),
      cancelReason: this.cancelReason,
      storage: this.readOnly ? 'read-only' : 'file',
      lastError: this.lastError,
    };
  }

  info() {
    return {
      backend: this.readOnly ? 'file (read-only)' : 'file',
      filePath: this.filePath,
      size: this.totalRows(),
      refreshing: Boolean(this.loading),
      writes: this.writes,
    };
  }
}

export default StockUniverse;
