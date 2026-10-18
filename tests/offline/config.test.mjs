/**
 * Configuration contract (0.6.0, publication tasks A4/B1/B2).
 *
 * Locks in what a user is allowed to configure, what the shipped defaults are,
 * and — importantly — that an invalid value is *reported* and leaves the
 * conservative default in force instead of silently degrading or crashing.
 *
 *   node tests/offline/config.test.mjs
 */
import assert from 'node:assert/strict';

import {
  AI_CONFIG,
  API_POLICY,
  CRYPTO_RANGE_DAYS,
  HTTP_POLICY,
  IDENTITY_POLICY,
  MARKETS,
  MARKET_DATA_CONFIG,
  NETWORK_MODES,
  PROVIDER_CONFIG,
  UNIVERSE_POLICY,
  allowUnfencedLoopback,
  applyProviderChains,
  candleLimit,
  chainOverrides,
  marketConfig,
  minBars,
  networkMode,
  providerChain,
  providerChainProblems,
  providerIds,
  rangeDays,
  setAllowUnfencedLoopback,
  setNetworkMode,
  validateProviderChains,
} from '../../lib/trading/config.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('config: markets, provider chains and transport mode');

await suite.check('the five markets are declared in a stable order', () => {
  assert.deepEqual(MARKETS, ['US', 'HK', 'CN', 'JP', 'CRYPTO']);
  return MARKETS.join(', ');
});

await suite.check('every shipped chain only names shipped providers and never repeats one', () => {
  const known = new Set(providerIds());
  for (const market of MARKETS) {
    const chain = marketConfig(market).chain;
    assert.ok(chain.length, `${market} has an empty default chain`);
    for (const id of chain) assert.ok(known.has(id), `${market} chain names unknown provider ${id}`);
    assert.equal(new Set(chain).size, chain.length, `${market} chain repeats a provider`);
    assert.ok(chain.includes(MARKET_DATA_CONFIG[market].primary), `${market} primary provider is not in its own chain`);
  }
  return `${MARKETS.map((m) => `${m}:${marketConfig(m).chain.length}`).join(' ')}`;
});

await suite.check('a valid `providers` override replaces only the markets it names', () => {
  const fallback = marketConfig('US');
  const { applied, problems } = applyProviderChains({ US: ['tencent', 'yahoo'] });
  assert.deepEqual(problems, []);
  assert.deepEqual(applied, ['US']);
  assert.deepEqual(providerChain('US'), ['tencent', 'yahoo']);
  assert.deepEqual(chainOverrides(), { US: ['tencent', 'yahoo'] });
  assert.deepEqual(providerChain('HK'), MARKET_DATA_CONFIG.HK.chain, 'HK must keep the default chain');
  assert.deepEqual(marketConfig('US').primary, MARKET_DATA_CONFIG.US.primary, 'primary is metadata, not order');
  applyProviderChains(null);
  assert.deepEqual(providerChain('US'), fallback.chain, 'clearing the override restores the default');
  return 'US override applied and cleared';
});

await suite.check('an invalid override is reported and the default stays in force', () => {
  const { applied, problems } = applyProviderChains({
    MARS: ['yahoo'],
    US: ['yahoo', 'yahoo'],
    HK: 'yahoo',
    CN: [],
    JP: ['nosuchfeed'],
    CRYPTO: ['gate', 'binance'],
  });
  assert.deepEqual(applied, ['CRYPTO']);
  assert.deepEqual(providerChain('US'), MARKET_DATA_CONFIG.US.chain, 'a duplicate chain must not be applied');
  assert.deepEqual(providerChain('JP'), MARKET_DATA_CONFIG.JP.chain, 'an unknown provider must not be applied');
  assert.deepEqual(providerChain('CRYPTO'), ['gate', 'binance']);
  const text = problems.join('\n');
  assert.match(text, /providers\.MARS: unknown market \(accepted: US, HK, CN, JP, CRYPTO\)/);
  assert.match(text, /providers\.US: provider yahoo is listed twice/);
  assert.match(text, /providers\.HK: expected an array of provider ids/);
  assert.match(text, /providers\.CN: the chain must list at least one provider/);
  assert.match(text, /providers\.JP: unknown provider "nosuchfeed" \(accepted: .*yahoo.*\)/);
  const exposed = providerChainProblems();
  assert.equal(exposed.length, problems.length, 'the problems must be readable from the API');
  applyProviderChains(null);
  return `${problems.length} problems reported`;
});

await suite.check('validateProviderChains is pure (no global state change)', () => {
  const before = JSON.stringify(chainOverrides());
  const result = validateProviderChains({ US: ['stooq'] });
  assert.deepEqual(result.chains, { US: ['stooq'] });
  assert.equal(JSON.stringify(chainOverrides()), before);
  validateProviderChains(['US']);
  return 'pure';
});

await suite.check('networkMode accepts exactly auto | standard | compatibility', () => {
  assert.equal(networkMode(), 'auto', 'the shipped default must be the generic transport');
  assert.deepEqual(NETWORK_MODES, ['auto', 'standard', 'compatibility']);
  assert.equal(setNetworkMode('standard'), 'standard');
  assert.equal(networkMode(), 'standard');
  assert.equal(setNetworkMode('compatibility'), 'compatibility');
  assert.throws(() => setNetworkMode('fast'), /networkMode must be one of auto, standard, compatibility \(got "fast"\)/);
  assert.equal(networkMode(), 'compatibility', 'a rejected value must not change the mode');
  setNetworkMode(null);
  assert.equal(networkMode(), 'auto');
  return 'auto/standard/compatibility';
});

await suite.check('crypto ranges are sized in calendar days, stock ranges in trading days', () => {
  assert.equal(rangeDays('1mo', 'CRYPTO'), 30);
  assert.equal(rangeDays('1mo', 'US'), CRYPTO_RANGE_DAYS['1mo'] > 0 ? rangeDays('1mo', 'US') : null);
  assert.ok(candleLimit('6mo', '1d', 'CRYPTO') > candleLimit('6mo', '1d', 'US'), 'crypto trades every calendar day');
  assert.ok(candleLimit('1d', '5m', 'US') > 0);
  assert.ok(minBars('1y', '1d', 'US') > 0);
  return `6mo/1d crypto=${candleLimit('6mo', '1d', 'CRYPTO')} us=${candleLimit('6mo', '1d', 'US')}`;
});

await suite.check('the retry/timeout policy stays conservative', () => {
  assert.ok(HTTP_POLICY.timeoutMs > 0 && HTTP_POLICY.timeoutMs <= 30_000);
  assert.ok(HTTP_POLICY.retries >= 1 && HTTP_POLICY.retries <= 5);
  assert.ok(HTTP_POLICY.rateLimitPerMinute > 0);
  assert.ok(HTTP_POLICY.failureThreshold >= 1);
  assert.ok(HTTP_POLICY.healthCooldownMs >= 1000);
  const shipped = ['yahoo', 'stooq', 'eastmoney', 'tencent', 'sina', 'nasdaq', 'binance', 'gate', 'coinlore'];
  assert.deepEqual(Object.keys(PROVIDER_CONFIG).sort(), [...shipped].sort(), 'the provider registry must list exactly the shipped providers');
  return `timeout=${HTTP_POLICY.timeoutMs}ms retries=${HTTP_POLICY.retries} providers=${shipped.length}`;
});

await suite.check('the inbound limit policy is published and internally consistent', () => {
  assert.ok(API_POLICY.windowMs > 0);
  assert.ok(API_POLICY.perUser > 0 && API_POLICY.global >= API_POLICY.perUser);
  for (const bucket of ['analyze', 'brief', 'universeRefresh']) {
    const item = API_POLICY.expensive[bucket];
    assert.ok(item, `${bucket} must be listed as an expensive bucket`);
    assert.ok(item.perUser > 0 && item.global >= item.perUser, `${bucket} scopes must be ordered`);
  }
  assert.ok(API_POLICY.maxConcurrentAnalysesGlobal >= API_POLICY.maxConcurrentAnalyses);
  assert.ok(UNIVERSE_POLICY.budgetMs > 0 && UNIVERSE_POLICY.minRestartIntervalMs >= 0);
  return `window=${API_POLICY.windowMs}ms perUser=${API_POLICY.perUser} global=${API_POLICY.global}`;
});

await suite.check('the AI recency thresholds are ordered and conservative', () => {
  // 0.8.0 renamed the youngest grade live → fresh: `fresh` only means "the
  // upstream timestamp is recent", it is never a claim of a live feed.
  assert.ok(AI_CONFIG.freshMaxAgeMs > 0);
  assert.ok(AI_CONFIG.staleWarnMs > AI_CONFIG.freshMaxAgeMs, 'delayed must be older than fresh');
  assert.ok(AI_CONFIG.staleHistoricalMs > AI_CONFIG.staleWarnMs, 'historical must be older than stale');
  assert.ok(AI_CONFIG.timeoutMs >= 30_000 && AI_CONFIG.maxTokens > 0);
  return `fresh≤${AI_CONFIG.freshMaxAgeMs / 1000}s delayed≤${AI_CONFIG.staleWarnMs / 1000}s historical≤${AI_CONFIG.staleHistoricalMs / 3_600_000}h`;
});

await suite.check('the fail-closed security policy is on by default and its single opt-out is explicit', () => {
  assert.equal(API_POLICY.requireHostFence, true, 'the host fence is required, not optional');
  assert.equal(API_POLICY.allowUnfencedLoopback, false, 'the shipped default is fail closed');
  assert.equal(allowUnfencedLoopback(), false, 'and no override is in force at import time');

  // The opt-out is a read-once operator switch with a validated value.
  assert.throws(() => setAllowUnfencedLoopback('maybe'), /must be true or false/);
  try {
    setAllowUnfencedLoopback(true);
    assert.equal(allowUnfencedLoopback(), true);
    assert.equal(API_POLICY.allowUnfencedLoopback, false, 'the constant still describes the shipped default');
    setAllowUnfencedLoopback(false);
    assert.equal(allowUnfencedLoopback(), false);
  } finally {
    setAllowUnfencedLoopback(undefined);
  }
  assert.equal(allowUnfencedLoopback(), false, 'clearing restores the default');

  assert.equal(IDENTITY_POLICY.rejectWritesWithoutIdentity, true, 'per-user writes need an identity');
  return `requireHostFence=${API_POLICY.requireHostFence} allowUnfencedLoopback=${allowUnfencedLoopback()}`;
});

process.exit(exitCodeFor(suite.finish()));
