/**
 * Market data cache (§13/§41/§42): one upstream load per cold key.
 *
 * The cache always avoided a *second* request for a warm key, but twenty
 * requests that arrived together on a cold key each started their own loader,
 * which multiplies provider rate limits exactly when a page opens. These
 * checks pin the in-flight sharing and that it is cleaned up afterwards.
 *
 *   node tests/offline/cache.test.mjs
 */
import assert from 'node:assert/strict';

import { createSuite, exitCodeFor } from './harness.mjs';
import { MarketDataCache } from '../../lib/trading/cache.js';

const suite = createSuite('market data cache');
const policy = { kind: 'quote', market: 'US', ttlMs: 60_000 };

const logger = { info() {}, warn() {}, debug() {} };

await suite.check('concurrent cold requests for one key load once (0.8.2 regression)', async () => {
  const cache = new MarketDataCache({ logger });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { price: 42 };
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => cache.through('quote:US:AAPL', policy, loader)));
  assert.equal(loads, 1, `twenty simultaneous requests made ${loads} upstream loads`);
  assert.equal(cache.stats.coalesced, 19, `coalesced ${cache.stats.coalesced} of 19 followers`);
  assert.ok(
    results.every((result) => result.value.price === 42 && result.cached === false),
    'every caller must receive the single shared result',
  );
  return `20 requests → 1 load, ${cache.stats.coalesced} coalesced`;
});

await suite.check('the in-flight entry is released, so a later cold request loads again', async () => {
  const cache = new MarketDataCache({ logger });
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return { price: loads };
  };
  await cache.through('quote:US:MSFT', { kind: 'quote', market: 'US', ttlMs: 0 }, loader);
  assert.equal(cache.inflight.size, 0, 'a settled load must not stay in the in-flight map');
  const second = await cache.through('quote:US:MSFT', { kind: 'quote', market: 'US', ttlMs: 0 }, loader);
  assert.equal(loads, 2, 'a zero-TTL key must load again on the next request');
  assert.equal(second.value.price, 2);
  return 'in-flight map emptied after settle';
});

await suite.check('a failed load is shared but not cached, so the next request retries', async () => {
  const cache = new MarketDataCache({ logger });
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('upstream down');
  };
  const outcomes = await Promise.allSettled([cache.through('candles:US:AAPL', policy, failing), cache.through('candles:US:AAPL', policy, failing)]);
  assert.equal(attempts, 1, `two simultaneous failures made ${attempts} attempts`);
  assert.ok(
    outcomes.every((outcome) => outcome.status === 'rejected' && /upstream down/.test(outcome.reason.message)),
    'both callers must see the loader error',
  );
  assert.equal(cache.get('candles:US:AAPL'), null, 'a failed load must not be stored');
  await assert.rejects(() => cache.through('candles:US:AAPL', policy, failing), /upstream down/);
  assert.equal(attempts, 2, 'the retry must start a new load');
  return 'shared failure, no cache entry, retry works';
});

process.exit(exitCodeFor(suite.finish()));
