/**
 * Transport policy (0.6.0, publication task B2).
 *
 * Three promises are locked in here:
 *   1. `standard` (the default) uses the runtime's own address handling and
 *      never rewrites an address family;
 *   2. `auto` upgrades *only a host that actually failed* to the compatibility
 *      policy and then succeeds through it;
 *   3. `compatibility` is available for networks where the generic path is known
 *      to be broken.
 *
 * The HTTP part runs against a loopback server on 127.0.0.1, so this suite needs
 * no internet and no DNS.
 *
 *   node tests/offline/transport.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { HTTP_POLICY, networkMode, setNetworkMode } from '../../lib/trading/config.js';
import {
  ProviderHealth,
  healthScope,
  httpGet,
  isTransportFailure,
  resetTransportState,
  transportState,
} from '../../lib/trading/http.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('transport: standard by default, compatibility on demand');

await suite.check('health is scoped per provider capability', () => {
  assert.equal(healthScope('yahoo', 'candles'), 'yahoo::candles');
  assert.equal(healthScope('yahoo', 'search'), 'yahoo::search');
  assert.equal(healthScope('yahoo'), 'yahoo');
  return 'yahoo::candles / yahoo::search';
});

await suite.check('only transport-level failures qualify for the compatibility policy', () => {
  assert.equal(isTransportFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransportFailure(new Error('socket hang up')), true);
  assert.equal(isTransportFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTransportFailure(new Error('getaddrinfo EAI_AGAIN finance.yahoo.com')), true);
  assert.equal(isTransportFailure(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), false);
  assert.equal(isTransportFailure(new Error('yahoo responded 403')), false);
  assert.equal(isTransportFailure(null), false);
  return 'reset/timeout/DNS yes, abort/403 no';
});

await suite.check('one failing capability does not take the whole provider down', () => {
  const health = new ProviderHealth({ failureThreshold: 2, cooldownMs: 5_000 });
  for (let i = 0; i < 2; i += 1) health.record(healthScope('yahoo', 'candles'), false, { message: 'socket hang up' });
  assert.equal(health.isOpen(healthScope('yahoo', 'candles')), true, 'the candle scope must be in cooldown');
  assert.equal(health.isOpen(healthScope('yahoo', 'search')), false, 'search was never touched');
  assert.equal(health.providerDown('yahoo'), true, 'the only capability we know about is cooling down');
  let row = health.providers().yahoo;
  assert.equal(row.healthy, false);
  assert.equal(row.degraded, true);
  assert.equal(row.failures, 2);
  assert.equal(row.scopes.candles.failures, 2);
  assert.equal(row.scopes.candles.healthy, false);
  assert.match(row.scopes.candles.lastError, /socket hang up/);

  for (let i = 0; i < 2; i += 1) health.record(healthScope('yahoo', 'search'), false, { message: 'connect ETIMEDOUT' });
  row = health.providers().yahoo;
  assert.equal(row.failures, 4);
  assert.equal(Object.keys(row.scopes).sort().join(','), 'candles,search');
  assert.ok(row.cooldownRemainingMs > 0);

  health.record(healthScope('yahoo', 'search'), true);
  assert.equal(health.providers().yahoo.scopes.search.failures, 0);
  assert.equal(health.providerDown('yahoo'), false, 'a search that answers keeps the provider usable');
  row = health.providers().yahoo;
  assert.equal(row.healthy, true, 'the provider is healthy again even though candles is still cooling down');
  assert.equal(row.degraded, true, 'and it still reports the degraded capability');
  assert.equal(row.scopes.candles.healthy, false);
  health.reset();
  assert.deepEqual(health.snapshot(), {});
  return 'per-capability cooldown, per-provider verdict';
});

/* ------------------------------------------------------------------ *
 * Loopback transport checks
 * ------------------------------------------------------------------ */

let destroys = 0;
let serving = true;
const server = http.createServer((req, res) => {
  if (!serving || destroys > 0) {
    if (destroys > 0) destroys -= 1;
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/data`;

try {
  await suite.check('standard (default) reaches a plain HTTP endpoint without touching families', async () => {
    setNetworkMode('standard');
    resetTransportState();
    destroys = 0;
    const res = await httpGet(url, { accept: 'json', provider: 'loopback', retries: 1, timeoutMs: 3_000 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    const state = transportState();
    assert.equal(state.mode, 'standard');
    assert.deepEqual(state.compatibilityHosts, [], 'standard must never rewrite address families');
    return 'standard';
  });

  await suite.check('auto falls back to compatibility for the host that failed, then succeeds', async () => {
    setNetworkMode('auto');
    resetTransportState();
    destroys = 1;
    const res = await httpGet(url, { accept: 'json', provider: 'loopback', retries: 2, timeoutMs: 3_000 });
    assert.equal(res.status, 200, 'the retry must go through the compatibility policy');
    const state = transportState();
    assert.equal(state.mode, 'auto');
    assert.deepEqual(state.compatibilityHosts, ['127.0.0.1'], 'only the host that failed is remembered');
    return `remembered ${state.compatibilityHosts.join(',')}`;
  });

  await suite.check('compatibility can be selected up front and is reported by the status API', async () => {
    setNetworkMode('compatibility');
    resetTransportState();
    destroys = 0;
    const res = await httpGet(url, { accept: 'json', provider: 'loopback', retries: 1, timeoutMs: 3_000 });
    assert.deepEqual(res.json, { ok: true });
    assert.equal(transportState().mode, 'compatibility');
    return 'compatibility';
  });

  await suite.check('standard keeps a hard failure a failure (no hidden family flipping)', async () => {
    setNetworkMode('standard');
    resetTransportState();
    destroys = 5;
    await assert.rejects(
      () => httpGet(url, { accept: 'json', provider: 'loopback', retries: 1, timeoutMs: 2_000 }),
      (err) => /loopback request failed/.test(err.message),
    );
    assert.deepEqual(transportState().compatibilityHosts, [], 'the user asked for standard and gets standard');
    destroys = 0;
    return 'reported, not papered over';
  });

  await suite.check('resetTransportState clears remembered hosts and families', () => {
    setNetworkMode('auto');
    resetTransportState();
    const state = transportState();
    assert.deepEqual(state.compatibilityHosts, []);
    assert.deepEqual(state.workingFamilies, {});
    assert.equal(networkMode(), 'auto');
    assert.equal(typeof HTTP_POLICY.retryBaseDelayMs, 'number');
    return 'cleared';
  });
} finally {
  serving = false;
  setNetworkMode(null);
  resetTransportState();
  await new Promise((resolve) => server.close(resolve));
}

process.exit(exitCodeFor(suite.finish()));
