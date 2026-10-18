/**
 * Provider registry.
 *
 * The only module allowed to know that concrete provider classes exist (§8).
 * Everything else asks the router for a provider id.
 */

import { PROVIDER_CONFIG } from '../config.js';
import { RateLimiter } from '../http.js';
import { BinanceProvider } from './binance.js';
import { CoinLoreProvider } from './coinlore.js';
import { EastmoneyProvider } from './eastmoney.js';
import { GateProvider } from './gate.js';
import { NasdaqProvider } from './nasdaq.js';
import { SinaProvider } from './sina.js';
import { StooqProvider } from './stooq.js';
import { TencentProvider } from './tencent.js';
import { YahooProvider } from './yahoo.js';

/** @type {Record<string, new (opts: any) => import('../schema.js').MarketDataProvider>} */
export const PROVIDER_CLASSES = {
  yahoo: YahooProvider,
  eastmoney: EastmoneyProvider,
  tencent: TencentProvider,
  stooq: StooqProvider,
  sina: SinaProvider,
  nasdaq: NasdaqProvider,
  binance: BinanceProvider,
  gate: GateProvider,
  coinlore: CoinLoreProvider,
};

/**
 * Instantiate every configured provider with its own rate limiter.
 * @param {{logger?: any}} [opts]
 * @returns {Map<string, import('../schema.js').MarketDataProvider>}
 */
export function buildProviders(opts = {}) {
  const registry = new Map();
  for (const [id, ProviderClass] of Object.entries(PROVIDER_CLASSES)) {
    const cfg = PROVIDER_CONFIG[id];
    if (!cfg) {
      opts.logger?.warn?.(`provider ${id} has no PROVIDER_CONFIG entry and was skipped`);
      continue;
    }
    registry.set(id, new ProviderClass({ logger: opts.logger, limiter: new RateLimiter(), intervals: cfg.intervals }));
  }
  return registry;
}

export {
  BinanceProvider,
  CoinLoreProvider,
  EastmoneyProvider,
  GateProvider,
  NasdaqProvider,
  SinaProvider,
  StooqProvider,
  TencentProvider,
  YahooProvider,
};
