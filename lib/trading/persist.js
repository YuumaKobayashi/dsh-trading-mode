/**
 * Cache persistence (spec §41).
 *
 * The spec suggests "reuse DSH's Redis". This DSH build ships no Redis, no DB
 * and no cross-process cache service, so the market-data cache is persisted as a
 * small atomic JSON file under the DSH home directory. That is a deliberate,
 * documented deviation — see Known Limitations in the README:
 *
 *  - it is a *cache*, so losing it costs latency and never correctness;
 *  - the watchlist (which must never be lost) uses the supported
 *    `dsh-storage-domain` service instead — see watchlist.js;
 *  - the live backend is reported by `GET /api/trading/status`.
 *
 * Writes go through a temp file + rename and are debounced by MarketDataCache,
 * so a crash cannot truncate the file. Entries are capped, because a single
 * quote is a couple of hundred bytes but a 1600-bar candle array is not.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Keys kept in the persisted snapshot, newest first. */
const MAX_PERSISTED_KEYS = 500;
/** Serialised snapshot ceiling; anything larger is trimmed, never written whole. */
const MAX_PERSIST_BYTES = 4 * 1024 * 1024;

export class FileCachePersist {
  /**
   * @param {{filePath: string, logger?: any, maxKeys?: number}} opts
   */
  constructor(opts) {
    this.filePath = opts.filePath;
    this.logger = opts.logger || null;
    this.maxKeys = opts.maxKeys || MAX_PERSISTED_KEYS;
    this.name = `file:${this.filePath}`;
    this.lastSavedAt = null;
    this.lastSaveError = null;
  }

  async load() {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (err && err.code === 'ENOENT') return {};
      this.logger?.warn?.(`market cache: could not read ${this.filePath}: ${err && err.message}`);
      return {};
    }
  }

  async save(snapshot) {
    try {
      const trimmed = this.trim(snapshot);
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(trimmed), 'utf8');
      await fs.promises.rename(tmp, this.filePath);
      this.lastSavedAt = Date.now();
      this.lastSaveError = null;
      return Object.keys(trimmed).length;
    } catch (err) {
      // A cache that cannot persist must never break a request (§44).
      this.lastSaveError = err && err.message;
      this.logger?.warn?.(`market cache: persist failed: ${this.lastSaveError}`);
      return 0;
    }
  }

  /** Keep the newest `maxKeys` entries that still fit the byte budget. */
  trim(snapshot) {
    const entries = Object.entries(snapshot || {}).sort((a, b) => (b[1]?.storedAt || 0) - (a[1]?.storedAt || 0));
    const out = {};
    let bytes = 2;
    for (const [key, record] of entries) {
      if (Object.keys(out).length >= this.maxKeys) break;
      const size = key.length + estimate(record);
      if (bytes + size > MAX_PERSIST_BYTES) break;
      out[key] = record;
      bytes += size;
    }
    return out;
  }

  info() {
    return { backend: 'file', filePath: this.filePath, lastSavedAt: this.lastSavedAt, lastSaveError: this.lastSaveError };
  }
}

/** Cheap serialised size estimate for the byte budget. */
function estimate(record) {
  try {
    return JSON.stringify(record).length;
  } catch {
    return 0;
  }
}
