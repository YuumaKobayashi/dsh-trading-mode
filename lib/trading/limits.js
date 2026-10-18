/**
 * Inbound request limits (spec: a plugin that fans out to public upstreams must
 * protect both itself and the upstreams — no unbounded fan-out).
 *
 * Two independent mechanisms:
 *   - QuotaLimiter      sliding-window counters per (bucket, scope, key)
 *   - ConcurrencyGate   in-flight counters per (bucket, scope, key)
 *
 * Both are intentionally in-process: the trading mode is a local, single-machine
 * panel, and the goal is to stop one UI session from hammering public endpoints,
 * not to run a multi-tenant quota service.
 */

const DEFAULT_WINDOW_MS = 60_000;

function cleanNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class QuotaLimiter {
  constructor({ windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.windowMs = Math.max(1_000, Math.trunc(cleanNumber(windowMs, DEFAULT_WINDOW_MS)));
    this.now = now;
    /** @type {Map<string, number[]>} bucket+scope+key -> timestamps */
    this.hits = new Map();
  }

  prune(ts) {
    const cutoff = ts - this.windowMs;
    for (const [key, stamps] of this.hits) {
      const kept = stamps.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(key, kept);
      else this.hits.delete(key);
    }
    return cutoff;
  }

  static entryKey(bucket, scope, key) {
    return `${bucket}|${scope}|${key}`;
  }

  /** Count of recorded hits inside the window. */
  count(bucket, scope, key) {
    const stamps = this.hits.get(QuotaLimiter.entryKey(bucket, scope, key));
    if (!stamps || !stamps.length) return 0;
    const cutoff = this.now() - this.windowMs;
    return stamps.filter((t) => t > cutoff).length;
  }

  /**
   * Try to consume one unit from every limit given. All limits are checked before
   * anything is recorded, so a rejected request never consumes quota.
   *
   * @param {string} bucket      e.g. 'request' | 'analyze' | 'brief' | 'universe'
   * @param {Array<{scope: string, key: string, limit: number}>} limits
   * @returns {{ok: true, remaining: number} | {ok: false, scope: string, limit: number, retryAfterMs: number}}
   */
  take(bucket, limits) {
    const ts = this.now();
    const cutoff = this.prune(ts);
    let tightestRemaining = Number.POSITIVE_INFINITY;
    let tightestScope = null;
    let tightestLimit = 0;
    for (const item of limits) {
      const limit = Math.trunc(cleanNumber(item && item.limit, 0));
      if (!(limit > 0)) continue;
      const stamps = (this.hits.get(QuotaLimiter.entryKey(bucket, item.scope, item.key)) || []).filter((t) => t > cutoff);
      if (stamps.length >= limit) {
        const oldest = stamps[0];
        const retryAfterMs = Math.max(250, Math.round(oldest + this.windowMs - ts));
        return { ok: false, scope: item.scope, limit, retryAfterMs };
      }
      const remaining = limit - stamps.length;
      if (remaining < tightestRemaining) {
        tightestRemaining = remaining;
        tightestScope = item.scope;
        tightestLimit = limit;
      }
    }
    for (const item of limits) {
      const limit = Math.trunc(cleanNumber(item && item.limit, 0));
      if (!(limit > 0)) continue;
      const key = QuotaLimiter.entryKey(bucket, item.scope, item.key);
      const stamps = (this.hits.get(key) || []).filter((t) => t > cutoff);
      stamps.push(ts);
      this.hits.set(key, stamps);
    }
    return { ok: true, remaining: tightestScope ? tightestRemaining - 1 : Number.POSITIVE_INFINITY, scope: tightestScope, limit: tightestLimit };
  }

  /** Remaining quota per limit, for observability. */
  peek(bucket, limits) {
    const cutoff = this.now() - this.windowMs;
    const out = [];
    for (const item of limits) {
      const limit = Math.trunc(cleanNumber(item && item.limit, 0));
      if (!(limit > 0)) continue;
      const stamps = (this.hits.get(QuotaLimiter.entryKey(bucket, item.scope, item.key)) || []).filter((t) => t > cutoff);
      out.push({ scope: item.scope, limit, used: stamps.length, remaining: Math.max(0, limit - stamps.length) });
    }
    return out;
  }

  snapshot() {
    const cutoff = this.now() - this.windowMs;
    const rows = [];
    for (const [key, stamps] of this.hits) {
      const live = stamps.filter((t) => t > cutoff).length;
      if (live) rows.push({ key, used: live });
    }
    return { windowMs: this.windowMs, entries: rows.length, rows };
  }

  reset() {
    this.hits.clear();
  }
}

export class ConcurrencyGate {
  constructor() {
    /** @type {Map<string, number>} bucket+scope+key -> in flight */
    this.active = new Map();
  }

  static entryKey(bucket, scope, key) {
    return `${bucket}|${scope}|${key}`;
  }

  /**
   * @param {string} bucket
   * @param {Array<{scope: string, key: string, limit: number}>} limits
   * @returns {{ok: true, tokens: string[]} | {ok: false, scope: string, limit: number, active: number}}
   */
  enter(bucket, limits) {
    for (const item of limits) {
      const limit = Math.trunc(cleanNumber(item && item.limit, 0));
      if (!(limit > 0)) continue;
      const live = this.active.get(ConcurrencyGate.entryKey(bucket, item.scope, item.key)) || 0;
      if (live >= limit) return { ok: false, scope: item.scope, limit, active: live };
    }
    const tokens = [];
    for (const item of limits) {
      const limit = Math.trunc(cleanNumber(item && item.limit, 0));
      if (!(limit > 0)) continue;
      const key = ConcurrencyGate.entryKey(bucket, item.scope, item.key);
      this.active.set(key, (this.active.get(key) || 0) + 1);
      tokens.push(key);
    }
    return { ok: true, tokens };
  }

  release(tokens) {
    if (!Array.isArray(tokens)) return;
    for (const key of tokens) {
      const live = (this.active.get(key) || 0) - 1;
      if (live > 0) this.active.set(key, live);
      else this.active.delete(key);
    }
  }

  snapshot() {
    return { entries: this.active.size, rows: [...this.active.entries()].map(([key, active]) => ({ key, active })) };
  }

  reset() {
    this.active.clear();
  }
}

/**
 * Turn a pack of `{scope, key, limit}` descriptions into a plain object for the
 * `/status` payload, so an operator can see how much head-room is left.
 */
export function quotaView(limiter, gate, bucket, limits) {
  return {
    bucket,
    window: limiter ? limiter.windowMs : null,
    limits: limiter ? limiter.peek(bucket, limits) : [],
    inFlight: gate ? gate.snapshot().rows.filter((r) => r.key.startsWith(`${bucket}|`)).map((r) => ({ scope: r.key.split('|')[1], active: r.active })) : [],
  };
}
