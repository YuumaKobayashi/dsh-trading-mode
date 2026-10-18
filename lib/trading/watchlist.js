/**
 * User watchlist persistence (spec §10/§11/§12/§13).
 *
 * Two rules drive this module:
 *
 *  1. The watchlist is *private per DSH user* and must survive a browser
 *     refresh, a re-login and even a different machine. LocalStorage is
 *     therefore not an option (§11) and the file/schema below is the source of
 *     truth.
 *  2. It stores **membership only**. Prices are public data and are fetched once
 *     per symbol by MarketDataService (§13), so 4000 users watching NVDA still
 *     cause exactly one upstream request.
 *
 * Storage backend preference:
 *  - `@deepseek-ai/dsh-storage-domain` (the supported DSH persistence service)
 *  - a plain atomic JSON file under the DSH home directory as a documented
 *    degraded mode. Which one is live is reported by `GET /api/trading/status`.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CODES, TradingError } from './errors.js';
import { MARKETS } from './config.js';
import { currencyOf, parseSymbol } from './symbols.js';

export const DOMAIN_NAME = 'trading_watchlist';
export const DOMAIN_VERSION = 1;

/**
 * Markets a stored watchlist row may belong to. Derived from the single source
 * of truth so adding a market can never leave the persistence schema behind
 * (0.6.0: this used to be a hard-coded `['US','HK']`, which made the domain
 * backend silently back-up-and-skip A-share, Tokyo and crypto rows while the
 * JSON backend accepted them).
 */
export const WATCHLIST_MARKET_VALUES = MARKETS.slice();

/** Fields required by §12 — kept identical in both backends. */
export function makeWatchlistItem(input, userId, position) {
  const now = Date.now();
  const record = input && typeof input === 'object' && input.symbol ? input : {};
  // `market` is always derived, never inherited blindly: a row whose market was
  // missing used to be stored as `undefined`, which the host storage-domain
  // schema then rejected (0.6.0). The hint wins when given, otherwise the
  // symbol decides.
  const parsed = parseSymbol(record.symbol || input, record.market);
  const market = record.market || parsed.market;
  return {
    id: record.id ? record.id : randomUUID(),
    userId,
    symbol: parsed.symbol,
    market,
    name: record.name || null,
    nameZh: record.nameZh || null,
    exchange: record.exchange || parsed.exchange || null,
    currency: record.currency || currencyOf(market),
    position: typeof position === 'number' ? position : record.position || 0,
    isFavorite: Boolean(record.isFavorite),
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
}

/**
 * Domain-table row schema. Deliberately loose (all optional except the
 * identity fields) so a future field addition never invalidates stored rows.
 * Exported so the offline suite can validate one row per market without a host
 * storage service.
 */
export function itemSchema(z) {
  return z
    .object({
      id: z.string(),
      userId: z.string(),
      symbol: z.string(),
      market: z.enum(WATCHLIST_MARKET_VALUES),
      name: z.string().nullable().optional(),
      nameZh: z.string().nullable().optional(),
      exchange: z.string().nullable().optional(),
      currency: z.string().nullable().optional(),
      position: z.number().optional(),
      isFavorite: z.boolean().optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    })
    .passthrough();
}

export class WatchlistStore {
  /**
   * @param {{logger?: any, homeDir?: string}} [opts]
   */
  constructor(opts = {}) {
    this.logger = opts.logger || null;
    this.homeDir = opts.homeDir || defaultHomeDir();
    this.filePath = path.join(this.homeDir, 'trading-mode', 'watchlist.json');
    /** @type {'pending'|'domain'|'file'} */
    this.backend = 'pending';
    this.backendDetail = null;
    /** @type {any} */
    this.domain = null;
    /** @type {any} */
    this.table = null;
    /** @type {Map<string, any[]>} userId → items (file backend cache) */
    this.memory = new Map();
    this.writes = 0;
  }

  /**
   * Open the best available backend. Never throws: a missing storage service is
   * a degraded mode, not a failure to load (§44).
   * @param {{ctx?: any}} [opts]
   */
  async init(opts = {}) {
    const ctx = opts.ctx || null;
    if (ctx) {
      try {
        const mod = await import('@deepseek-ai/dsh-storage-domain');
        const { defineDomain, domainTable } = mod;
        const service = resolveStorageService(ctx);
        if (service && typeof service.open === 'function' && typeof defineDomain === 'function') {
          const { z } = await import('zod');
          const spec = defineDomain({
            name: DOMAIN_NAME,
            version: DOMAIN_VERSION,
            layout: 'single',
            invalidRecords: 'backup-and-skip',
            tables: { items: domainTable(itemSchema(z)) },
          });
          this.domain = await service.open(spec);
          this.table = this.domain.table('items');
          this.backend = 'domain';
          this.backendDetail = `${DOMAIN_NAME}@${DOMAIN_VERSION} via dsh-storage-domain`;
          this.logger?.info?.(`watchlist: using DSH storage domain (${this.backendDetail})`);
          return this;
        }
        this.backendDetail = 'dsh-storage-domain or storageDomain service unavailable';
      } catch (err) {
        this.backendDetail = `dsh-storage-domain unavailable: ${err && err.message}`;
        this.logger?.warn?.(`watchlist: falling back to file storage — ${this.backendDetail}`);
      }
    } else {
      this.backendDetail = 'no cordis context supplied';
    }
    await this.openFileBackend();
    return this;
  }

  async openFileBackend() {
    this.backend = 'file';
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
      for (const record of records) {
        if (!record || typeof record.userId !== 'string' || typeof record.symbol !== 'string') continue;
        const bucket = this.memory.get(record.userId) || [];
        bucket.push(record);
        this.memory.set(record.userId, bucket);
      }
      this.backendDetail = `${this.backendDetail ? `${this.backendDetail}; ` : ''}file backend ${this.filePath}`;
      this.logger?.info?.(`watchlist: using file storage at ${this.filePath} (${records.length} rows)`);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.backendDetail = `${this.backendDetail ? `${this.backendDetail}; ` : ''}file backend ${this.filePath} (created on first write)`;
      } else {
        this.logger?.warn?.(`watchlist: could not read ${this.filePath}: ${err && err.message}`);
        throw new TradingError(CODES.STORAGE_ERROR, `watchlist storage is unavailable: ${err && err.message}`, { cause: err });
      }
    }
  }

  async dispose() {
    try {
      await this.domain?.close?.();
    } catch (err) {
      this.logger?.warn?.(`watchlist: domain close failed: ${err && err.message}`);
    }
  }

  // ------------------------------------------------------------------ reading

  /**
   * All rows, optionally for a single user, sorted by position then creation.
   * @param {string} userId
   */
  async list(userId) {
    const rows = this.backend === 'domain' ? [...this.table.entries()].map(([, value]) => value) : [...this.memory.values()].flat();
    return rows
      .filter((row) => row && row.userId === userId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  async get(userId, symbol) {
    const canonical = parseSymbol(symbol).symbol;
    const rows = await this.list(userId);
    return rows.find((row) => row.symbol === canonical) || null;
  }

  // ------------------------------------------------------------------ writing

  /**
   * Add a symbol. Idempotent: re-adding returns the existing row (§26 forbids
   * implying ownership, but duplicates would still be a bug).
   * @param {string} userId
   * @param {any} input symbol, or a record with symbol/name/exchange…
   */
  async add(userId, input) {
    const canonical = parseSymbol(input && input.symbol ? input.symbol : input).symbol;
    const existing = await this.get(userId, canonical);
    const rows = await this.list(userId);
    if (existing) {
      const merged = { ...existing, ...pickDefined(input), id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() };
      await this.write(merged, true);
      return { item: merged, created: false };
    }
    const item = makeWatchlistItem(input, userId, rows.length);
    if (rows.length >= MAX_ITEMS) {
      throw new TradingError(CODES.BAD_REQUEST, `watchlist is limited to ${MAX_ITEMS} symbols`);
    }
    await this.write(item, false);
    return { item, created: true };
  }

  /** @returns {Promise<{removed: boolean}>} */
  async remove(userId, symbol) {
    const canonical = parseSymbol(symbol).symbol;
    const existing = await this.get(userId, canonical);
    if (!existing) return { removed: false };
    await this.deleteRow(existing);
    await this.reindex(userId);
    return { removed: true };
  }

  /** §3.1 "Watchlist ordering" — `symbols` is the desired order, unknown entries ignored. */
  async reorder(userId, symbols) {
    if (!Array.isArray(symbols)) throw new TradingError(CODES.BAD_REQUEST, 'order must be an array of symbols');
    const rows = await this.list(userId);
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const ordered = [];
    for (const raw of symbols) {
      const canonical = parseSymbol(raw).symbol;
      const row = bySymbol.get(canonical);
      if (!row) continue;
      bySymbol.delete(canonical);
      ordered.push(row);
    }
    // Anything the client did not mention keeps its relative order at the end.
    for (const row of rows) if (bySymbol.has(row.symbol)) ordered.push(row);
    let index = 0;
    for (const row of ordered) {
      if (row.position !== index) await this.write({ ...row, position: index, updatedAt: Date.now() }, true);
      index += 1;
    }
    return this.list(userId);
  }

  async setFavorite(userId, symbol, isFavorite) {
    const existing = await this.get(userId, symbol);
    if (!existing) throw new TradingError(CODES.NOT_FOUND, `${parseSymbol(symbol).symbol} is not in the watchlist`);
    const updated = { ...existing, isFavorite: Boolean(isFavorite), updatedAt: Date.now() };
    await this.write(updated, true);
    return updated;
  }

  /** Assign contiguous positions after a removal. */
  async reindex(userId) {
    const rows = await this.list(userId);
    let index = 0;
    for (const row of rows) {
      if (row.position !== index) await this.write({ ...row, position: index }, true);
      index += 1;
    }
  }

  // ------------------------------------------------------------- backend glue

  async write(item, isUpdate) {
    this.writes += 1;
    if (this.backend === 'domain') {
      try {
        if (isUpdate && (await this.table.get(item.id))) await this.table.update(item.id, () => item);
        else await this.table.put(item.id, item);
        return item;
      } catch (err) {
        throw new TradingError(CODES.STORAGE_ERROR, `could not write watchlist row: ${err && err.message}`, { cause: err });
      }
    }
    const bucket = this.memory.get(item.userId) || [];
    const at = bucket.findIndex((row) => row.id === item.id || row.symbol === item.symbol);
    if (at >= 0) bucket[at] = { ...bucket[at], ...item };
    else bucket.push(item);
    this.memory.set(item.userId, bucket);
    await this.flush();
    return item;
  }

  async deleteRow(item) {
    if (this.backend === 'domain') {
      try {
        await this.table.delete(item.id);
        return;
      } catch (err) {
        throw new TradingError(CODES.STORAGE_ERROR, `could not delete watchlist row: ${err && err.message}`, { cause: err });
      }
    }
    const bucket = this.memory.get(item.userId) || [];
    this.memory.set(
      item.userId,
      bucket.filter((row) => row.id !== item.id),
    );
    await this.flush();
  }

  /** Atomic-ish file write: temp file + rename, so a crash cannot truncate the list. */
  async flush() {
    const rows = [...this.memory.values()].flat();
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify({ version: DOMAIN_VERSION, items: rows }, null, 2), 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      throw new TradingError(CODES.STORAGE_ERROR, `could not persist watchlist: ${err && err.message}`, { cause: err });
    }
  }

  /** Diagnostics for `GET /api/trading/status`. */
  info() {
    return { backend: this.backend, detail: this.backendDetail, filePath: this.backend === 'file' ? this.filePath : null, writes: this.writes };
  }
}

export const MAX_ITEMS = 50;

function defaultHomeDir() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return process.env.DSH_HOME.trim();
  if (process.env.DSH_DIR && process.env.DSH_DIR.trim()) return process.env.DSH_DIR.trim();
  return path.join(os.homedir(), '.dsh');
}

/** Locate the storage service however this DSH build exposes it. */
function resolveStorageService(ctx) {
  for (const key of ['storageDomain', 'storage', 'storage-service']) {
    const service = ctx.get ? ctx.get(key) : null;
    if (service && typeof service.open === 'function') return service;
  }
  return null;
}

function pickDefined(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of ['name', 'nameZh', 'exchange', 'currency']) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key];
  }
  return out;
}
