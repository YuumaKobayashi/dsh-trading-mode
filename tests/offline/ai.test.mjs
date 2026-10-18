/**
 * AI layer contract (0.5.1, unchanged by the 0.6.0 publication work).
 *
 * Drives TradingAi against a fake host llm service that implements only the
 * published StreamChunk protocol — no DSH package, no network. This is the test
 * that would have caught the original "AI_UNAVAILABLE" regression.
 *
 *   node tests/offline/ai.test.mjs   (or: npm run test:ai)
 */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import {
  ChunkAssembler,
  RECENCY_DIRECTIVE,
  STOCK_SYSTEM_PROMPT,
  TradingAi,
  ageMsOf,
  buildBriefInput,
  buildStockInput,
  buildUserMessage,
  qualityFor,
  recencyOf,
} from '../../lib/trading/ai.js';

let passed = 0;
const failures = [];

/** Report this suite's result to the offline runner (0.7.0 P0-3); best effort. */
function report() {
  const target = process.env.DSH_TEST_RESULT_FILE;
  if (!target) return;
  try {
    appendFileSync(
      target,
      `${JSON.stringify({ title: 'ai', required: true, passed, failed: failures.length, skipped: 0, skipReasons: [], failures: failures.map((f) => `${f.title}: ${f.message}`), ok: failures.length === 0 })}\n`,
      'utf8',
    );
  } catch {
    /* reporting must never break the suite */
  }
}

async function check(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${title}`);
  } catch (err) {
    failures.push({ title, message: err && err.message });
    console.log(`FAIL  ${title}\n      ${err && err.message}`);
  }
}

/** A minimal but contract-faithful fake of the host `llm` service. */
function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    listProviders: () => script.providers || [],
    listModels: async (provider) => (script.modelsByProvider || {})[provider] || [],
    stream(options) {
      calls.push(options);
      const chunks = typeof script.run === 'function' ? script.run(options, calls.length) : script.chunks || [];
      return (async function* gen() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const textStream = (text, finish = { kind: 'stop' }) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: text.slice(0, 12) },
  { type: 'text-delta', index: 0, text: text.slice(12) },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } },
  { type: 'finish', reason: finish },
];

/** Mirrors what DSH's agent-default-model reports on this machine. */
const defaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };

const ANALYSIS = JSON.stringify({
  summary: 'Trend is constructive.',
  trend: { shortTerm: 'up', mediumTerm: 'flat', longTerm: 'up' },
  momentum: 'rising',
  volume: 'average',
  supportLevels: [100],
  resistanceLevels: [120],
  riskFactors: ['valuation'],
  keyObservations: ['ma20 above ma50'],
});

const SNAPSHOT = {
  symbol: 'AAPL',
  market: 'US',
  asOf: Date.now(),
  quote: { price: 200, change: 1, changePct: 0.5, currency: 'USD', source: 'eastmoney', timestamp: Date.now() },
  profile: { name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD' },
  technical: { technical: { rsi14: 55, ma20: 195 }, bars: 120, interval: '1d', unavailable: [] },
  candles: [],
};

async function main() {
  await check('the request envelope matches RequestUserInput (no id, no source)', () => {
    const message = buildUserMessage('hello');
    assert.deepEqual(message, { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    assert.ok(!('source' in message), 'source must not be attached to a request message');
    assert.ok(!('id' in message), 'id must not be attached to a request message');
  });

  await check('the chunk assembler keeps text, drops reasoning and honours block-end/usage', () => {
    const assembler = new ChunkAssembler();
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
    assembler.push({ type: 'reasoning-delta', index: 1, text: 'thinking…' });
    assembler.push({ type: 'text-delta', index: 0, text: '{"a":' });
    assembler.push({ type: 'text-delta', index: 0, text: '1}' });
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: '{"a":1}' } });
    assembler.push({ type: 'usage', usage: { outputTokens: 5 } });
    assembler.push({ type: 'finish', reason: { kind: 'stop' } });
    assert.equal(assembler.text(), '{"a":1}');
    assert.ok(!assembler.text().includes('thinking'), 'reasoning must never leak into the answer');
    assert.equal(assembler.usage.outputTokens, 5);
    assert.equal(assembler.finishReason().kind, 'stop');
  });

  await check('the chunk assembler infers stop from text when no finish chunk arrives', () => {
    const assembler = new ChunkAssembler();
    assembler.push({ type: 'text-delta', index: 0, text: '{"ok":true}' });
    assert.equal(assembler.finishReason().kind, 'stop');
    const empty = new ChunkAssembler();
    assert.equal(empty.finishReason().kind, 'error');
  });

  await check('askJson drives the public stream contract end to end', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const { value, meta } = await ai.askJson('system', 'payload');
    assert.equal(value.summary, 'Trend is constructive.');
    assert.equal(meta.provider, 'deepseek-official');
    assert.equal(meta.model, 'deepseek-flash');
    assert.equal(meta.attempt, 1);
    assert.equal(meta.usage.outputTokens, 34);
    const call = llm.calls[0];
    assert.equal(call.provider, 'deepseek-official');
    assert.equal(call.model, 'deepseek-flash');
    assert.equal(call.system, 'system');
    assert.equal(call.maxTokens, 2400);
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].role, 'user');
    assert.equal(call.messages[0].content[0].text, 'payload');
    assert.ok(!('source' in call.messages[0]), 'the host rejects a source on request messages');
    assert.ok(call.signal, 'a timeout signal must be passed to the host');
  });

  await check('analyzeStock normalises the model output and stamps its provenance', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const { analysis, meta } = await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    assert.equal(analysis.summary, 'Trend is constructive.');
    assert.deepEqual(analysis.supportLevels, [100]);
    assert.equal(meta.symbol, 'AAPL');
    assert.equal(meta.provider, 'deepseek-official');
    assert.ok(meta.disclaimer, 'the disclaimer must be attached');
    assert.ok(!/Simplified Chinese/.test(llm.calls[0].system), 'English runs must not carry the localisation directive');
  });

  await check('watchlistBrief sends the localisation directive and counts stocks', async () => {
    const brief = JSON.stringify({
      headline: '科技股走弱',
      stocksTracked: 2,
      upCount: 1,
      downCount: 1,
      strongestMover: 'AAPL',
      largestDecline: '0700.HK',
      unusualVolume: [],
      keyObservations: ['成交温和'],
    });
    const llm = fakeLlm({ chunks: textStream(brief) });
    const ai = new TradingAi({ llm, defaultModel });
    const { brief: value, meta } = await ai.watchlistBrief(
      {
        asOf: Date.now(),
        stocks: [
          { symbol: 'AAPL', market: 'US', quote: { price: 200, change: 1, changePct: 0.5, currency: 'USD' } },
          { symbol: '0700.HK', market: 'HK', quote: { price: 400, change: -2, changePct: -0.5, currency: 'HKD' } },
        ],
      },
      { lang: 'zh' },
    );
    assert.equal(value.headline, '科技股走弱');
    assert.equal(meta.stocksTracked, 2);
    assert.equal(meta.lang, 'zh');
    assert.ok(/Simplified Chinese/.test(llm.calls[0].system), 'zh runs must carry the localisation directive');
  });

  await check('a late-bound llm service starts unavailable and becomes usable (0.5.0 regression)', async () => {
    let service = null;
    const ai = new TradingAi({ llm: () => service, defaultModel: () => defaultModel });
    assert.equal(ai.available, false, 'the plugin must degrade instead of throwing when llm is not there yet');
    assert.match(ai.unavailableReason(), /ctx\.get\("llm"\)/);
    service = fakeLlm({ chunks: textStream(ANALYSIS) });
    assert.equal(ai.available, true, 'the service must be re-read on every call');
    const { value } = await ai.askJson('system', 'payload');
    assert.equal(value.summary, 'Trend is constructive.');
  });

  await check('a missing llm service fails once with AI_UNAVAILABLE, not three retries', async () => {
    const ai = new TradingAi({ llm: null, defaultModel });
    await assert.rejects(
      () => ai.askJson('system', 'payload'),
      (err) => err.code === 'AI_UNAVAILABLE' && /LLM runtime is not available/.test(err.message) && err.retryable === false,
    );
  });

  await check('provider discovery awaits listModels and prefers a DeepSeek model', async () => {
    const llm = fakeLlm({
      providers: [{ id: 'openai' }, { id: 'deepseek-official' }],
      modelsByProvider: { openai: ['gpt-4o'], 'deepseek-official': ['deepseek-chat', 'deepseek-reasoner'] },
      chunks: textStream(ANALYSIS),
    });
    const ai = new TradingAi({ llm, defaultModel: null });
    assert.equal(ai.resolveRouteSync(), null);
    const route = await ai.resolveRoute();
    assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-chat' });
    assert.equal(ai.available, true);
  });

  await check('the default-model selection is read tolerantly (provider/model aliases)', () => {
    const ai = new TradingAi({ llm: null, defaultModel: { currentSelection: () => ({ providerId: 'deepseek-official', modelId: 'deepseek-flash' }) } });
    assert.deepEqual(ai.resolveRouteSync(), { provider: 'deepseek-official', model: 'deepseek-flash' });
    const partial = new TradingAi({ llm: null, defaultModel: { currentSelection: () => ({ provider: 'deepseek-official' }) } });
    assert.equal(partial.resolveRouteSync(), null, 'an incomplete selection must fall through to discovery');
    const throwing = new TradingAi({ llm: null, defaultModel: { currentSelection: () => { throw new Error('no profile'); } } });
    assert.equal(throwing.resolveRouteSync(), null, 'a throwing selection must not break status()');
  });

  await check('a retryable provider failure is retried and the second attempt wins', async () => {
    const llm = fakeLlm({
      run: (_options, callIndex) =>
        callIndex === 1
          ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream 500' } } }]
          : textStream(ANALYSIS),
    });
    const ai = new TradingAi({ llm, defaultModel });
    const { value, meta } = await ai.askJson('system', 'payload', { attempts: 2, timeoutMs: 5000 });
    assert.equal(value.summary, 'Trend is constructive.');
    assert.equal(meta.attempt, 2);
    assert.equal(llm.calls.length, 2);
  });

  await check('terminal finish reasons map to actionable errors', async () => {
    const cases = [
      [{ kind: 'max-tokens' }, /token cap/],
      [{ kind: 'aborted', failure: { message: 'user cancelled' } }, /aborted/],
      [{ kind: 'error', failure: { message: 'boom', code: 'AUTH' } }, /boom/],
    ];
    for (const [finish, pattern] of cases) {
      const llm = fakeLlm({ chunks: [{ type: 'finish', reason: finish }] });
      const ai = new TradingAi({ llm, defaultModel });
      await assert.rejects(
        () => ai.askJson('system', 'payload', { attempts: 1, timeoutMs: 5000 }),
        (err) => err.code === 'AI_UNAVAILABLE' && pattern.test(err.message),
        `expected ${JSON.stringify(finish)} to fail with ${pattern}`,
      );
    }
  });

  await check('a stream that yields nothing is an empty response, not a JSON crash', async () => {
    const llm = fakeLlm({ chunks: [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'finish', reason: { kind: 'stop' } }] });
    const ai = new TradingAi({ llm, defaultModel });
    await assert.rejects(
      () => ai.askJson('system', 'payload', { attempts: 1, timeoutMs: 5000 }),
      (err) => err.code === 'AI_UNAVAILABLE' && /no text/.test(err.message),
    );
  });

  await check('status() reports availability, route and the blocking reason', async () => {
    const ready = new TradingAi({ llm: fakeLlm({ chunks: textStream(ANALYSIS) }), defaultModel });
    const status = ready.status();
    assert.equal(status.available, true);
    assert.equal(status.reason, null);
    assert.deepEqual(status.route, { provider: 'deepseek-official', model: 'deepseek-flash' });
    assert.equal(status.maxTokens, 2400);
    const blocked = new TradingAi({ llm: null, defaultModel: null });
    assert.equal(blocked.status().available, false);
    assert.ok(blocked.status().reason);
  });

  // ---- 0.7.0 P1-4: a delayed snapshot must never be described as live ----

  await check('ageMsOf reads seconds and milliseconds alike and rejects junk', () => {
    const now = 1_700_000_000_000;
    assert.equal(ageMsOf(now / 1000, now), 0, 'seconds must be normalised');
    assert.equal(ageMsOf(now - 5_000, now), 5_000);
    assert.equal(ageMsOf(null, now), null);
    assert.equal(ageMsOf('not-a-date', now), null);
    assert.equal(ageMsOf(0, now), null);  });

  await check('recencyOf grades fresh, delayed, stale and historical, and says unknown', () => {
    const now = Date.now();
    const at = (msAgo) => recencyOf(now - msAgo, {});
    assert.equal(at(60_000).grade, 'fresh');
    assert.equal(at(10 * 60_000).grade, 'delayed');
    assert.equal(at(2 * 3_600_000).grade, 'stale');
    assert.equal(at(2 * 24 * 3_600_000).grade, 'historical');
    assert.equal(recencyOf(null, {}).grade, 'unknown');
    assert.equal(at(60_000).ageSeconds, 60);
    const flagged = recencyOf(now, { stale: true, staleReason: 'upstream closed', marketOpen: false });
    assert.equal(flagged.grade, 'fresh', 'the grade is about age');
    assert.equal(flagged.stale, true, 'the stale flag is carried separately');
    assert.equal(flagged.staleReason, 'upstream closed');
    assert.equal(flagged.marketSessionOpen, false);
    return 'fresh/delayed/stale/historical/unknown all graded';
  });

  await check('qualityFor never claims live data it cannot vouch for', () => {
    const fresh = qualityFor({ grade: 'fresh', ageSeconds: 12, stale: false });
    assert.match(fresh.qualification, /recent/i);
    assert.ok(!/real[- ]time snapshot|is real-time/i.test(fresh.qualification));
    assert.equal(fresh.historyGrade, null);
    const stale = qualityFor(
      { grade: 'stale', ageSeconds: 7200, stale: true, staleReason: 'cache' },
      { quality: { grade: 'partial' }, bars: 120 },
    );
    assert.match(stale.qualification, /not a current quote/i);
    assert.equal(stale.historyGrade, 'partial', 'the indicator grade travels with the answer');
    assert.equal(stale.historyBars, 120);
    const unknown = qualityFor(null, null);
    assert.equal(unknown.grade, 'unknown');
    assert.match(unknown.qualification, /do not describe the numbers as current/i);
    return 'qualification text is conservative in every grade';
  });

  await check('the recency directive is appended to the system prompt without rewriting the spec rules', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    const system = llm.calls[0].system;
    assert.ok(system.includes(STOCK_SYSTEM_PROMPT), 'the specified stock prompt must stay verbatim');
    assert.ok(system.includes(RECENCY_DIRECTIVE.trim()), 'the recency rules must be appended');
    assert.ok(/never describe/i.test(system) || /do not describe/i.test(system), 'the directive must forbid live wording');
  });

  await check('analyzeStock stamps dataQuality from the snapshot age', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const fresh = await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    assert.equal(fresh.meta.dataQuality.grade, 'fresh');
    assert.equal(fresh.meta.dataQuality.historyGrade, null, 'no technical quality block on this snapshot');
    const old = await ai.analyzeStock(
      { ...SNAPSHOT, asOf: Date.now() - 3 * 86_400_000, stale: true },
      { lang: 'en' },
    );
    assert.equal(old.meta.dataQuality.grade, 'historical');
    assert.equal(old.meta.dataQuality.stale, true);
    assert.match(old.meta.dataQuality.qualification, /previous session|historical/i);
    return `fresh=${fresh.meta.dataQuality.grade}, old=${old.meta.dataQuality.grade}`;
  });

  await check('buildStockInput carries dataRecency and the indicator quality', () => {
    const input = buildStockInput({
      ...SNAPSHOT,
      technical: { technical: { rsi14: 55 }, bars: 70, interval: '1d', unavailable: [], quality: { grade: 'partial', bars: 70 } },
    });
    assert.ok(input.data.dataRecency, 'the model must see how old the data is');
    assert.equal(input.data.dataRecency.grade, 'fresh');
    assert.equal(input.data.technical.quality.grade, 'partial');
    assert.equal(input.dataAvailability.historyGrade, 'partial');
    assert.ok(input.dataAvailability.quote);
    return 'dataRecency + technical.quality present';
  });

  await check('buildBriefInput ages the whole brief by its oldest row', () => {
    const stocks = [
      { symbol: 'AAPL', quote: { timestamp: Date.now() }, stale: false },
      { symbol: 'MSFT', quote: { timestamp: Date.now() - 2 * 86_400_000 }, stale: true },
    ];
    const input = buildBriefInput({ stocks, asOf: Date.now() });
    assert.equal(input.dataRecency.grade, 'historical', 'one historical row ages the brief');
    assert.equal(input.dataRecency.staleStocks, 1, 'the count of cached rows is reported');
    assert.equal(input.dataRecency.stale, true, 'a cached row marks the brief stale');
    assert.equal(input.dataQuality.grade, 'historical');
    assert.match(input.dataQuality.qualification, /previous session|historical/i);
    return 'brief aged by oldest row';
  });

  console.log(`\n=== ${passed}/${passed + failures.length} checks passed, ${failures.length} failed ===`);
  report();
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure.title}: ${failure.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  failures.push({ title: 'suite crashed', message: err && err.message });
  report();
  process.exit(1);
});
