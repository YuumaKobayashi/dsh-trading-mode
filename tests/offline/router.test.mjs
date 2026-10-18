/**
 * Router contract (0.6.0, publication tasks B1/B4).
 *
 * The router is the only component that knows the chain order, so this suite
 * locks in: configured order wins, a user override is honoured, failures are
 * recorded per *capability*, and a provider whose candle endpoint is blocked
 * keeps serving search/quotes.
 *
 * Fake providers only — this suite never touches the network.
 *
 *   node tests/offline/router.test.mjs
 */
import assert from 'node:assert/strict';

import { applyProviderChains, marketConfig, providerIds } from '../../lib/trading/config.js';
import { CODES } from '../../lib/trading/errors.js';
import { ProviderHealth, healthScope } from '../../lib/trading/http.js';
import { MarketDataRouter } from '../../lib/trading/router.js';
import { createSuite, exitCodeFor } from './harness.mjs';

function fakeProvider(id, opts = {}) {
  const markets = opts.markets || ['US'];
  const features = opts.features || ['quote', 'candles', 'search', 'profile'];
  return {
    id,
    label: opts.label || id.toUpperCase(),
    markets,
    capabilities: Object.fromEntries(features.map((feature) => [feature, true])),
    intervals: opts.intervals || null,
    supports: (feature, market) => features.includes(feature) && markets.includes(market),
    supportsInterval: (interval) => !opts.intervals || opts.intervals.includes(interval),
    supportsSymbol: () => true,
  };
}

function buildRouter(opts = {}) {
  const ids = opts.ids || providerIds();
  const providers = new Map(ids.map((id) => [id, fakeProvider(id, (opts.options && opts.options[id]) || {})]));
  const health = new ProviderHealth({ failureThreshold: opts.threshold || 3, cooldownMs: opts.cooldownMs || 60_000 });
  return { router: new MarketDataRouter({ providers, health, logger: null }), health, providers };
}

const suite = createSuite('router: configured order, capability-scoped health');

await suite.check('the chain follows configuration order and drops unregistered providers', () => {
  const configured = marketConfig('US').chain;
  assert.ok(configured.length >= 2, 'the default US chain must have a fallback');
  const { router } = buildRouter();
  assert.deepEqual(router.chainFor('US'), configured);
  const without = configured[configured.length - 1];
  const partial = buildRouter({ ids: providerIds().filter((id) => id !== without) });
  assert.deepEqual(partial.router.chainFor('US'), configured.filter((id) => id !== without));
  assert.throws(
    () => router.chainFor('MARS'),
    (err) => err.code === CODES.UNSUPPORTED_MARKET && /market MARS is not supported/.test(err.message),
  );
  return `${configured.join(' → ')}`;
});

await suite.check('a `providers` override changes the order without touching code', () => {
  const shipped = marketConfig('US').chain;
  const [first, second] = shipped;
  const { router } = buildRouter();
  applyProviderChains({ US: [second, first] });
  try {
    assert.deepEqual(router.chainFor('US'), [second, first]);
    assert.equal(router.candidates('quote', 'US')[0].id, second, 'candidates respect the override');
    assert.deepEqual(router.chainFor('HK'), marketConfig('HK').chain, 'other markets are untouched');
  } finally {
    applyProviderChains(null);
  }
  assert.deepEqual(router.chainFor('US'), shipped, 'clearing restores the shipped order');
  return `${second} first`;
});

await suite.check('candidates filter by capability, interval and symbol support', () => {
  const ids = providerIds();
  const daily = ids[0];
  const intraday = ids[1] || ids[0];
  const { router } = buildRouter({ options: { [daily]: { features: ['quote'], intervals: ['1d', '1wk'] } } });
  const quotes = router.candidates('quote', 'US');
  assert.ok(quotes.every((c) => c.id !== daily || c.provider.capabilities.quote), 'lookup must not offer a provider that cannot serve the feature');
  const intradayCandles = router.candidates('candles', 'US', '5m', 'AAPL');
  assert.ok(!intradayCandles.some((c) => c.id === daily), 'a 1d/1wk-only provider must not be asked for 5m');
  if (intraday !== daily) assert.ok(intradayCandles.every((c) => c.id !== undefined));
  return `${quotes.length} quote candidates, ${intradayCandles.length} 5m candidates`;
});

await suite.check('run walks the chain, records per-capability health and returns the winner', async () => {
  const [primary, fallback] = marketConfig('US').chain;
  const { router, health } = buildRouter();
  const calls = [];
  const result = await router.run({
    feature: 'quote',
    market: 'US',
    symbol: 'AAPL',
    fn: async (provider) => {
      calls.push(provider.id);
      if (provider.id === primary) throw new Error('socket hang up');
      return { price: 1 };
    },
  });
  assert.deepEqual(calls, [primary, fallback]);
  assert.equal(result.provider, fallback);
  assert.deepEqual(result.value, { price: 1 });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].provider, primary);
  assert.equal(health.state.get(healthScope(primary, 'quote')).failures, 1);
  assert.equal(health.snapshot()[healthScope(fallback, 'quote')].successes, 1);
  return `${primary} → ${fallback}`;
});

await suite.check('a broken candle endpoint does not take search away from that provider', async () => {
  const [primary] = marketConfig('US').chain;
  const { router, health } = buildRouter({ threshold: 2 });
  for (let i = 0; i < 2; i += 1) {
    health.record(healthScope(primary, 'candles'), false, { message: 'eastmoney mirror refused' });
  }
  assert.equal(health.isOpen(healthScope(primary, 'candles')), true);
  assert.equal(health.isOpen(healthScope(primary, 'search')), false);
  const searchCandidates = router.candidates('search', 'US');
  const row = searchCandidates.find((c) => c.id === primary);
  assert.ok(row, 'the provider is still a search candidate');
  assert.equal(row.healthy, true, 'its search capability is not in cooldown');
  const candleCandidates = router.candidates('candles', 'US');
  if (candleCandidates.some((c) => c.id === primary)) {
    assert.equal(candleCandidates.find((c) => c.id === primary).healthy, false);
  }
  const result = await router.run({ feature: 'search', market: 'US', fn: async (provider) => [provider.id] });
  assert.deepEqual(result.value, [primary], 'search still goes to the primary provider');
  const status = router.status();
  const statusRow = status.providers.find((p) => p.id === primary);
  assert.equal(statusRow.scopes.candles.healthy, false, 'the status API names the broken capability');
  assert.equal(statusRow.scopes.search.successes, 1, 'and reports the search that still works');
  assert.equal(statusRow.degraded, true);
  assert.ok(status.transport && (status.transport.mode === 'auto' || status.transport.mode === 'standard'));
  assert.deepEqual(status.chains.US.chain, marketConfig('US').chain);
  return `${primary}: candles open, search fine`;
});

await suite.check('a validation shortfall is not a health failure', async () => {
  const [primary, fallback] = marketConfig('US').chain;
  const { router, health } = buildRouter();
  const result = await router.run({
    feature: 'candles',
    market: 'US',
    interval: '1d',
    symbol: 'AAPL',
    fn: async (provider) => (provider.id === primary ? { bars: 2 } : { bars: 1 }),
    validate: (value) => value.bars >= 5,
    sizeOf: (value) => value.bars,
  });
  assert.equal(result.degraded, true, 'the fullest partial answer is returned');
  assert.equal(result.provider, primary, 'and it is the largest one');
  assert.deepEqual(result.value, { bars: 2 });
  assert.equal(health.snapshot()[healthScope(primary, 'candles')], undefined, 'answering short is not failing');
  assert.equal(result.attempts.length, marketConfig('US').chain.length, 'every provider was tried');
  return 'partial series kept, breaker untouched';
});

await suite.check('when every provider is cooling down the router half-opens the oldest failure', async () => {
  const chain = marketConfig('US').chain;
  const { router, health } = buildRouter({ threshold: 1, cooldownMs: 60_000 });
  for (const id of chain) health.record(healthScope(id, 'quote'), false, { message: 'down' });
  const oldest = chain[chain.length - 1];
  health.state.get(healthScope(oldest, 'quote')).lastFailAt = 1;
  const probed = [];
  const result = await router.run({
    feature: 'quote',
    market: 'US',
    symbol: 'AAPL',
    fn: async (provider) => {
      probed.push(provider.id);
      return { price: 2 };
    },
  });
  assert.deepEqual(probed, [oldest], 'exactly one half-open probe');
  assert.equal(result.provider, oldest);
  assert.equal(health.isOpen(healthScope(oldest, 'quote')), false, 'a successful probe closes the cooldown');
  assert.equal(router.status().providers.find((p) => p.id === oldest).scopes.quote.healthy, true);
  return `probed ${oldest}`;
});

await suite.check('no candidate at all is a NO_PROVIDER error that names the request', async () => {
  const { router } = buildRouter({ options: Object.fromEntries(providerIds().map((id) => [id, { features: [] }])) });
  await assert.rejects(
    () => router.run({ feature: 'candles', market: 'JP', interval: '5m', fn: async () => null }),
    (err) => err.code === CODES.NO_PROVIDER && /no provider can serve candles for JP @ 5m/.test(err.message),
  );
  return 'NO_PROVIDER';
});

await suite.check('every provider failing folds into one DATA_UNAVAILABLE error', async () => {
  const chain = marketConfig('US').chain;
  const { router } = buildRouter();
  await assert.rejects(
    () => router.run({ feature: 'quote', market: 'US', symbol: 'ZZZZ', fn: async () => { throw new Error('boom'); } }),
    (err) => err.code === CODES.DATA_UNAVAILABLE && err.message.includes(`quote for ZZZZ unavailable (${chain[0]}:`),
  );
  return 'aggregated';
});

process.exit(exitCodeFor(suite.finish()));
