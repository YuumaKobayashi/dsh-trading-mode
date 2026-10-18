/**
 * Market Data Cache (spec §41/§42, §13).
 *
 * Two tiers:
 *  - an in-memory Map, always present, read synchronously;
 *  - an optional persistent adapter (backed by a DSH storage domain) so that
 *    quotes survive a DSH restart and can still be served as `stale: true`
 *    when every provider is down.
 *
 * The cache is shared process-wide and keyed by symbol (never per user), which
 * is what prevents "4000 users → 4000 upstream calls" (§13).
 */

import { CACHE_TTL } from './config.js';
import { marketStatus } from './sessions.js';

const g = globalThis;

export class MarketDataCache {
  /**
   * @param {{persist?: {load: () => Promise<Record<string, any>>, save: (snapshot: Record<string, any>) => Promise<void>}, logger?: any, memoryLimit?: number}} [opts]
   */
  constructor(opts = {}) {
    this.persist = opts.persist || null;
    this.logger = opts.logger || null;
    this.memoryLimit = opts.memoryLimit || 4_000;
    this.map = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.stats = { hits: 0, misses: 0, staleServed: 0, expired: 0, persisted: 0, evicted: 0 };
  }

  /** Restore persisted entries; call once during plugin apply. */
  async hydrate() {
    if (!this.persist) return 0;
    try {
      const snapshot = await this.persist.load();
      const now = Date.now();
      let n = 0;
      for (const [key, rec] of Object.entries(snapshot || {})) {
        if (!rec || typeof rec !== 'object' || !('value' in rec)) continue;
        this.map.set(key, { value: rec.value, storedAt: rec.storedAt || now, ttl: rec.ttl || 0 });
        n += 1;
      }
      if (n) this.logger?.info?.(`cache hydrated: ${n} entries`);
      return n;
    } catch (e) {
      this.logger?.warn?.('cache hydrate failed:', e && e.message);
      return 0;
    }
  }

  /**
   * @param {string} key
   * @param {{allowStale?: boolean}} [opts]
   * @returns {{value:any, storedAt:number, ageMs:number, fresh:boolean, maxAgeMs:number}|null}
   */
  get(key, opts = {}) {
    const rec = this.map.get(key);
    if (!rec) {
      this.stats.misses += 1;
      return null;
    }
    const ageMs = Date.now() - rec.storedAt;
    const fresh = rec.ttl > 0 ? ageMs <= rec.ttl : false;
    const kind = key.split(':')[0];
    const ceiling = CACHE_TTL.maxStaleAge[kind] ?? CACHE_TTL.maxStaleAge.quote;
    if (ageMs > ceiling) {
      this.stats.expired += 1;
      this.map.delete(key);
      this.touch();
      return null;
    }
    if (fresh) this.stats.hits += 1;
    else if (opts.allowStale) this.stats.staleServed += 1;
    return { value: rec.value, storedAt: rec.storedAt, ageMs, fresh, maxAgeMs: ceiling };
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, storedAt: Date.now(), ttl: ttlMs });
    if (this.map.size > this.memoryLimit) this.evict();
    this.touch();
  }

  /** TTL for a cache kind, chosen by whether its market is currently open. */
  ttlFor(kind, market) {
    const open = market ? marketStatus(market).open : false;
    const table = open ? CACHE_TTL.open : CACHE_TTL.closed;
    return table[kind] ?? table.quote;
  }

  /**
   * Fetch-through helper.
   * @template T
   * @param {string} key
   * @param {{kind: string, market?: 'US'|'HK', ttlMs?: number, force?: boolean, allowStale?: boolean, staleTtlMs?: number}} policy
   * @param {(ctx: {stale: any}) => Promise<T>} loader
   * @returns {Promise<{value: T, cached: boolean, stale: boolean, storedAt: number, provider?: string}>}
   */
  async through(key, policy, loader) {
    const ttl = policy.ttlMs ?? this.ttlFor(policy.kind, policy.market);
    const hit = this.get(key);
    if (hit && hit.fresh && !policy.force) {
      return { value: hit.value, cached: true, stale: false, storedAt: hit.storedAt };
    }
    try {
      const value = await loader({ stale: null });
      this.set(key, value, ttl);
      return { value, cached: false, stale: false, storedAt: Date.now() };
    } catch (err) {
      const fallback = this.get(key, { allowStale: true });
      if (fallback && policy.allowStale !== false) {
        this.logger?.warn?.(`serving stale cache for ${key} (${Math.round(fallback.ageMs / 1000)}s old) after: ${err && err.message}`);
        return { value: fallback.value, cached: true, stale: true, storedAt: fallback.storedAt, provider: fallback.value && fallback.value.source };
      }
      throw err;
    }
  }

  invalidate(prefix) {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (!prefix || key.startsWith(prefix)) {
        this.map.delete(key);
        n += 1;
      }
    }
    if (n) this.touch();
    return n;
  }

  touch() {
    this.dirty = true;
    if (!this.persist || this.flushTimer) return;
    if (typeof g.setTimeout !== 'function') return;
    this.flushTimer = g.setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 4_000);
    if (this.flushTimer && typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  async flush() {
    if (!this.persist || !this.dirty) return 0;
    this.dirty = false;
    const snapshot = {};
    for (const [key, rec] of this.map) snapshot[key] = { value: rec.value, storedAt: rec.storedAt, ttl: rec.ttl };
    this.stats.persisted = Object.keys(snapshot).length;
    await this.persist.save(snapshot);
    return Object.keys(snapshot).length;
  }

  evict() {
    const entries = [...this.map.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    const drop = Math.max(1, Math.floor(this.memoryLimit * 0.1));
    for (let i = 0; i < drop && i < entries.length; i += 1) {
      this.map.delete(entries[i][0]);
      this.stats.evicted += 1;
    }
  }

  snapshot() {
    return { size: this.map.size, ...this.stats };
  }

  /** Reported by `GET /api/trading/status` so the live cache mode is never a guess. */
  get backendName() {
    if (!this.persist) return 'memory';
    return this.persist.name || 'persisted';
  }

  clear() {
    this.map.clear();
    this.touch();
  }
}
