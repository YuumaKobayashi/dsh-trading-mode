/**
 * Inbound request limits (0.7.0, publication task P0-4).
 *
 * The panel fans out to public market-data endpoints, so the limits are part of
 * the product contract: a burst must be *rejected*, not silently forwarded, a
 * rejected request must not consume quota, the window must actually expire, and
 * the per-user and global concurrency caps must be independent.
 *
 * Pure in-process checks — no clock waiting, no network.
 *
 *   node tests/offline/limits.test.mjs
 */
import assert from 'node:assert/strict';

import { API_POLICY, UNIVERSE_POLICY } from '../../lib/trading/config.js';
import { ConcurrencyGate, QuotaLimiter, quotaView } from '../../lib/trading/limits.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('limits: quota windows and concurrency gates');

/** A controllable clock so the window semantics are testable without sleeping. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

await suite.check('API_POLICY and UNIVERSE_POLICY ship safe, sane defaults', () => {
  assert.equal(API_POLICY.windowMs, 60_000);
  assert.ok(API_POLICY.perUser > 0 && API_POLICY.global >= API_POLICY.perUser, 'global must be at least per-user');
  for (const bucket of ['analyze', 'brief', 'universeRefresh']) {
    const item = API_POLICY.expensive[bucket];
    assert.ok(item && item.perUser > 0 && item.global > 0, `${bucket} must carry both scopes`);
    assert.ok(item.global >= item.perUser, `${bucket} global must not be stricter than per-user`);
    assert.ok(item.perUser < API_POLICY.perUser, `${bucket} must be stricter than the general budget`);
  }
  assert.ok(API_POLICY.maxConcurrentAnalyses > 0 && API_POLICY.maxConcurrentAnalysesGlobal >= API_POLICY.maxConcurrentAnalyses);
  assert.ok(UNIVERSE_POLICY.budgetMs >= 60_000, 'a full-universe walk needs a real budget');
  return `window ${API_POLICY.windowMs}ms, perUser ${API_POLICY.perUser}, global ${API_POLICY.global}`;
});

await suite.check('a burst is refused once the window fills, with a usable retry hint', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 1_000, now: clock.now });
  const limits = [{ scope: 'user', key: 'u1', limit: 3 }];
  for (let i = 0; i < 3; i += 1) {
    const taken = limiter.take('request', limits);
    assert.equal(taken.ok, true, `request ${i + 1} must be allowed`);
    clock.advance(10);
  }
  const refused = limiter.take('request', limits);
  assert.equal(refused.ok, false, 'the fourth request must be refused');
  assert.equal(refused.scope, 'user');
  assert.equal(refused.limit, 3);
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 1_000, `retry hint out of range: ${refused.retryAfterMs}`);
  return `refused with retryAfterMs=${refused.retryAfterMs}`;
});

await suite.check('a refused request does not consume quota, and the window slides', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 1_000, now: clock.now });
  const limits = [{ scope: 'user', key: 'u1', limit: 2 }];
  limiter.take('request', limits);
  limiter.take('request', limits);
  assert.equal(limiter.take('request', limits).ok, false, 'the third must be refused');
  // Retrying while still blocked must not burn the quota that will free up.
  assert.equal(limiter.take('request', limits).ok, false);
  clock.advance(1_500);
  const after = limiter.take('request', limits);
  assert.equal(after.ok, true, 'the window must slide and allow the request again');
  assert.equal(limiter.count('request', 'user', 'u1'), 1, 'only the fresh hit is inside the window');
  return 'quota preserved while blocked, window slid';
});

await suite.check('per-user and global scopes are counted independently', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 60_000, now: clock.now });
  const limits = [
    { scope: 'user', key: 'u1', limit: 2 },
    { scope: 'global', key: 'all', limit: 3 },
  ];
  assert.equal(limiter.take('request', limits).ok, true);
  assert.equal(limiter.take('request', limits).ok, true);
  const perUser = limiter.take('request', limits);
  assert.equal(perUser.ok, false);
  assert.equal(perUser.scope, 'user', 'the tighter scope must be reported first');
  assert.equal(limiter.count('request', 'global', 'all'), 2, 'a rejected request must not charge the global bucket');
  // A different user still has their own room, but the global budget caps them.
  const other = [
    { scope: 'user', key: 'u2', limit: 2 },
    { scope: 'global', key: 'all', limit: 3 },
  ];
  assert.equal(limiter.take('request', other).ok, true);
  const global = limiter.take('request', other);
  assert.equal(global.ok, false);
  assert.equal(global.scope, 'global');
  return 'user and global scopes independent';
});

await suite.check('peek reports head-room without consuming any', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 60_000, now: clock.now });
  const limits = [{ scope: 'user', key: 'u1', limit: 5 }];
  limiter.take('request', limits);
  const rows = limiter.peek('request', limits);
  assert.equal(rows.length, 1);
  assert.deepEqual({ used: rows[0].used, remaining: rows[0].remaining, limit: rows[0].limit }, { used: 1, remaining: 4, limit: 5 });
  assert.equal(limiter.peek('request', limits)[0].used, 1, 'peek must be side-effect free');
  return 'used 1, remaining 4';
});

await suite.check('the concurrency gate blocks a third simultaneous analysis per user', () => {
  const gate = new ConcurrencyGate();
  const limits = (key, limit) => [{ scope: 'user', key, limit }];
  const a = gate.enter('analyze', limits('u1', API_POLICY.maxConcurrentAnalyses));
  assert.equal(a.ok, true);
  const b = gate.enter('analyze', limits('u1', API_POLICY.maxConcurrentAnalyses));
  assert.equal(b.ok, true);
  const c = gate.enter('analyze', limits('u1', API_POLICY.maxConcurrentAnalyses));
  assert.equal(c.ok, false);
  assert.equal(c.scope, 'user');
  assert.equal(c.active, API_POLICY.maxConcurrentAnalyses);
  gate.release(a.tokens);
  const retry = gate.enter('analyze', limits('u1', API_POLICY.maxConcurrentAnalyses));
  assert.equal(retry.ok, true, 'releasing a slot must let the next analysis in');
  gate.release(b.tokens);
  gate.release(retry.tokens);
  assert.equal(gate.snapshot().entries, 0, 'every slot must be returned');
  return `cap ${API_POLICY.maxConcurrentAnalyses} enforced and released`;
});

await suite.check('the concurrency gate is per user and per bucket', () => {
  const gate = new ConcurrencyGate();
  const limits = (key, limit) => [
    { scope: 'user', key, limit: 1 },
    { scope: 'global', key: 'all', limit: 4 },
  ];
  const u1 = gate.enter('analyze', limits('u1', 1));
  assert.equal(u1.ok, true);
  assert.equal(gate.enter('analyze', limits('u1', 1)).ok, false, 'the same user is capped');
  const u2 = gate.enter('analyze', limits('u2', 1));
  assert.equal(u2.ok, true, 'another user is unaffected');
  const brief = gate.enter('brief', limits('u1', 1));
  assert.equal(brief.ok, true, 'a different bucket is unaffected');
  gate.release(u1.tokens);
  gate.release(u2.tokens);
  gate.release(brief.tokens);
  return 'per-user and per-bucket caps hold';
});

await suite.check('a disabled limit (0 or missing) never blocks a request', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 1_000, now: clock.now });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(limiter.take('request', [{ scope: 'user', key: 'u1', limit: 0 }]).ok, true);
  }
  assert.equal(limiter.take('request', []).ok, true, 'an empty limit set must allow the request');
  const gate = new ConcurrencyGate();
  for (let i = 0; i < 10; i += 1) assert.equal(gate.enter('analyze', [{ scope: 'user', key: 'u1', limit: 0 }]).ok, true);
  return 'zero limits are ignored';
});

await suite.check('quotaView renders an operator-readable /status shape', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 60_000, now: clock.now });
  const gate = new ConcurrencyGate();
  const limits = [
    { scope: 'user', key: 'u1', limit: 6 },
    { scope: 'global', key: 'all', limit: 30 },
  ];
  limiter.take('brief', limits);
  const entered = gate.enter('brief', limits);
  const view = quotaView(limiter, gate, 'brief', limits);
  assert.equal(view.bucket, 'brief');
  assert.equal(view.window, 60_000);
  assert.deepEqual(
    view.limits.map((row) => `${row.scope}:${row.used}/${row.limit}`),
    ['user:1/6', 'global:1/30'],
  );
  assert.deepEqual(view.inFlight, [{ scope: 'user', active: 1 }, { scope: 'global', active: 1 }]);
  gate.release(entered.tokens);
  return 'user:1/6 global:1/30, 2 in flight';
});

await suite.check('reset() clears both mechanisms (used by the tests and by reload)', () => {
  const clock = fakeClock();
  const limiter = new QuotaLimiter({ windowMs: 60_000, now: clock.now });
  const limits = [{ scope: 'user', key: 'u1', limit: 1 }];
  limiter.take('request', limits);
  assert.equal(limiter.take('request', limits).ok, false);
  limiter.reset();
  assert.equal(limiter.take('request', limits).ok, true, 'after reset the quota is fresh again');
  const gate = new ConcurrencyGate();
  gate.enter('analyze', limits);
  gate.reset();
  assert.equal(gate.snapshot().entries, 0);
  return 'both mechanisms reset';
});

process.exit(exitCodeFor(suite.finish()));
