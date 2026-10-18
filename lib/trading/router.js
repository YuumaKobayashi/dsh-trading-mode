/**
 * MarketDataRouter — provider selection (spec §15).
 *
 * Picks a provider by market, request type and provider health, walks the chain
 * on failure, and records the outcome. This is the *only* place that knows the
 * chain order; providers never call each other and business code never names one
 * (§8, §16, §77.24).
 */

import { MARKET_DATA_CONFIG, marketConfig } from './config.js';
import { CODES, TradingError, toTradingError } from './errors.js';
import { healthScope, transportState } from './http.js';

export class MarketDataRouter {
  /**
   * @param {{providers: Map<string, import('./schema.js').MarketDataProvider>, health: import('./http.js').ProviderHealth, logger?: any}} opts
   */
  constructor(opts) {
    this.providers = opts.providers;
    this.health = opts.health;
    this.logger = opts.logger || null;
  }

  provider(id) {
    return this.providers.get(id) || null;
  }

  /** Ordered provider ids for a market, configured in MARKET_DATA_CONFIG. */
  chainFor(market) {
    if (!MARKET_DATA_CONFIG[market]) {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `market ${market} is not supported`, { symbol: market });
    }
    return marketConfig(market).chain.filter((id) => this.providers.has(id));
  }

  /**
   * Providers able to serve a request, healthy first. `interval` narrows the set
   * so a daily-only provider is never asked for 5m candles.
   * @returns {Array<{provider: any, id: string, healthy: boolean}>}
   */
  candidates(feature, market, interval, symbol) {
    const out = [];
    for (const id of this.chainFor(market)) {
      const provider = this.providers.get(id);
      if (!provider.supports(feature, market)) continue;
      if (interval && typeof provider.supportsInterval === 'function' && !provider.supportsInterval(interval)) continue;
      if (symbol && typeof provider.supportsSymbol === 'function' && !provider.supportsSymbol(symbol, feature)) continue;
      out.push({ provider, id, healthy: !this.health.isOpen(healthScope(id, feature)) });
    }
    return out;
  }

  /**
   * Run `fn(provider)` against each candidate until one succeeds.
   *
   * Retry/fallback/circuit-breaking live here (§43/§44). When every provider is
   * inside its cooldown we still probe the single least-recently-failed one
   * (half-open), so a transient outage cannot wedge the plugin for a minute.
   *
   * @template T
   * @param {{feature: 'search'|'quote'|'candles'|'profile', market: 'US'|'HK', interval?: string, symbol?: string, fn: (provider: any) => Promise<T>, validate?: (value: T) => boolean, sizeOf?: (value: T) => number}} req
   * @returns {Promise<{value: T, provider: string, attempts: Array<{provider: string, error: string, code: string}>, degraded?: boolean}>}
   */
  async run(req) {
    const all = this.candidates(req.feature, req.market, req.interval, req.symbol);
    if (!all.length) {
      throw new TradingError(CODES.NO_PROVIDER, `no provider can serve ${req.feature} for ${req.market}${req.interval ? ` @ ${req.interval}` : ''}`, {
        symbol: req.symbol,
      });
    }
    let ordered = all.filter((c) => c.healthy);
    if (!ordered.length) {
      // Half-open probe: the candidate whose last failure for *this* capability
      // is oldest.
      const probe = all
        .slice()
        .sort(
          (a, b) =>
            (this.health.state.get(healthScope(a.id, req.feature))?.lastFailAt || 0) -
            (this.health.state.get(healthScope(b.id, req.feature))?.lastFailAt || 0),
        )[0];
      ordered = [probe];
      this.logger?.debug?.(`all providers unhealthy, probing ${probe.id} for ${req.feature}`);
    }
    const attempts = [];
    /** Best answer that failed validation — kept so a partial range still renders. */
    let best = null;
    for (const candidate of ordered) {
      let value;
      try {
        value = await req.fn(candidate.provider);
      } catch (err) {
        const tradingError = toTradingError(err, `${candidate.id} failed`);
        this.health.record(healthScope(candidate.id, req.feature), false, { message: tradingError.message });
        attempts.push({ provider: candidate.id, error: tradingError.message, code: tradingError.code });
        this.logger?.warn?.(`${req.feature} ${req.symbol || ''} via ${candidate.id} failed: ${tradingError.code} ${tradingError.message}`);
        continue;
      }
      if (req.validate && !req.validate(value)) {
        // Served, but not enough of it: treat as a failed attempt and let the
        // chain continue (falling back to the largest such answer at the end).
        //
        // Deliberately *not* recorded as a health failure: the provider did
        // answer, it just cannot serve this range (measured: tencent returns two
        // US daily bars but serves HK candles and every quote). Recording it
        // would trip the breaker and take the provider out for its cooldown.
        const size = Number(req.sizeOf ? req.sizeOf(value) : 0) || 0;
        attempts.push({ provider: candidate.id, error: 'insufficient data for the requested range', code: CODES.DATA_UNAVAILABLE });
        if (!best || size > best.size) best = { value, id: candidate.id, size };
        this.logger?.warn?.(
          `${req.feature} ${req.symbol || ''} via ${candidate.id} returned insufficient data (${size} bars); trying the next provider`,
        );
        continue;
      }
      this.health.record(healthScope(candidate.id, req.feature), true);
      return { value, provider: candidate.id, attempts };
    }
    if (best) {
      // Every provider came up short: return the fullest answer rather than a
      // hard failure — a newly listed symbol legitimately has few bars.
      this.logger?.warn?.(`${req.feature} ${req.symbol || ''}: returning the fullest partial series from ${best.id} (${best.size} bars)`);
      return { value: best.value, provider: best.id, attempts, degraded: true };
    }
    throw this.aggregate(req, attempts, ordered.map((c) => c.id));
  }

  /** Fold per-provider failures into one error that says what actually happened. */
  aggregate(req, attempts, tried) {
    const subject = `${req.feature}${req.symbol ? ` for ${req.symbol}` : ''}`;
    const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
    const codes = new Set(attempts.map((a) => a.code));
    // A semantic answer ("this symbol does not exist") beats a transport error.
    if (codes.has(CODES.NOT_FOUND)) {
      return new TradingError(CODES.NOT_FOUND, `${subject} not found on any provider (${detail})`, { symbol: req.symbol });
    }
    if (codes.has(CODES.UPSTREAM_BLOCKED) && codes.size === 1) {
      return new TradingError(CODES.UPSTREAM_BLOCKED, `${subject} unavailable: every provider in the chain refused the request (${detail})`, {
        symbol: req.symbol,
        provider: tried.join(','),
      });
    }
    return new TradingError(CODES.DATA_UNAVAILABLE, `${subject} unavailable (${detail})`, { symbol: req.symbol, provider: tried.join(',') });
  }

  /** Health + capability report for `GET /api/trading/status` (§20 data source status). */
  status() {
    // Health is stored per provider *capability* (`eastmoney::candles`); the row
    // below is the rollup, with the per-capability detail in `scopes` so a flaky
    // endpoint no longer looks like a dead provider (0.6.0, task B4).
    const snapshot = this.health.providers();
    const providers = [];
    for (const [id, provider] of this.providers) {
      const s = snapshot[id] || {
        healthy: true,
        degraded: false,
        calls: 0,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        scopes: {},
      };
      providers.push({
        id,
        label: provider.label,
        healthy: s.healthy !== false,
        degraded: Boolean(s.degraded),
        capabilities: { ...provider.capabilities },
        intervals: provider.intervals ? [...provider.intervals] : null,
        markets: [...provider.markets],
        calls: s.calls || 0,
        successes: s.successes || 0,
        failures: s.failures || 0,
        consecutiveFailures: s.consecutiveFailures || 0,
        lastOkAt: s.lastOkAt || null,
        lastError: s.lastError || null,
        cooldownRemainingMs: s.cooldownRemainingMs || 0,
        scopes: s.scopes || {},
      });
    }
    return {
      providers,
      transport: transportState(),
      chains: Object.fromEntries(
        Object.entries(MARKET_DATA_CONFIG).map(([market, cfg]) => [
          market,
          {
            primary: cfg.primary,
            historicalFallback: cfg.historicalFallback,
            chain: marketConfig(market).chain.filter((id) => this.providers.has(id)),
          },
        ]),
      ),
    };
  }
}
