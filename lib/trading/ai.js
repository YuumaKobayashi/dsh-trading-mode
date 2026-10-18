/**
 * DeepSeek analysis layer (spec §4, §34–§37, §40, §43, §53).
 *
 * Hard boundary (§4): this module never fetches market data. It receives an
 * already-computed, structured snapshot from MarketDataService and returns
 * natural-language interpretation. It is also never allowed to invent numbers —
 * the prompt forbids it and the output schema has no free-form price fields
 * other than levels the model must copy from the supplied support/resistance
 * candidates.
 */

import { AI_CONFIG, DISCLAIMER } from './config.js';
import { CODES, TradingError } from './errors.js';

/** Provider failure codes worth another attempt (mirrors dsh-llm-retry). */
const RETRYABLE = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'AI_INVALID_OUTPUT']);

/** Spec §34 — reproduced as required, with the output contract appended. */
export const STOCK_SYSTEM_PROMPT = `You are the AI market analysis engine inside DSH Trading Mode. Analyze only the structured financial data provided by the system.

Rules you must follow:
1. Never invent market data.
2. Never invent prices, volume, technical indicators, company information or events.
3. Use only values provided in the input.
4. Clearly distinguish factual observations from interpretation.
5. If data is missing, state that it is unavailable.
6. Respect market data timestamps.
7. Do not describe delayed data as live market data.
8. Do not recalculate technical indicators when system-calculated values are supplied.
9. Explain technical concepts clearly.
10. Do not make guaranteed price predictions.
11. Do not present the output as financial advice.
12. Focus on: trend, momentum, volume, volatility, support, resistance, risk.

Return ONE JSON object and nothing else — no prose, no markdown, no code fences. The object must match exactly this shape:
{
  "summary": string,
  "trend": { "shortTerm": string, "mediumTerm": string, "longTerm": string },
  "momentum": string,
  "volume": string,
  "supportLevels": number[],
  "resistanceLevels": number[],
  "riskFactors": string[],
  "keyObservations": string[]
}
supportLevels and resistanceLevels must be copied from the "levels" block of the input (pivotSupport / pivotResistance / low52w / high52w / ma20 / ma50 / ma200). Use an empty array when the input has no usable level. Every number you write must appear in the input.`;

/** Spec §40 — reproduced as required, plus the output contract. */
export const BRIEF_SYSTEM_PROMPT = `You are generating a concise market brief for a user's stock watchlist. Use only supplied structured market data.

Identify:
1. Largest gainers
2. Largest decliners
3. Unusual volume
4. Important technical changes
5. Differences among watched companies
6. Stocks near important support or resistance

Do not assume the user owns these stocks. Refer to them as watchlist stocks. Do not provide guaranteed predictions. Keep the output concise and data-driven.

Also produce, for the UI header, a plain count of how many watchlist stocks were tracked and how many were up versus down.

Return ONE JSON object and nothing else — no prose, no markdown, no code fences. The object must match exactly this shape:
{
  "headline": string,
  "stocksTracked": number,
  "upCount": number,
  "downCount": number,
  "strongestMover": string,
  "largestDecline": string,
  "unusualVolume": string[],
  "keyObservations": string[]
}
Every symbol, price and percentage you mention must come from the input. Use an empty array for unusualVolume when nothing qualifies.`;

/**
 * Recency directive (0.7.0, plan item: no live-sounding wording on old data).
 * 0.8.0 (round-3 P1⑤) renamed the youngest grade `live` → `fresh`: this plugin
 * consumes public, unauthenticated endpoints and has no real-time entitlement, so
 * no grade may be described as live.
 *
 * The published spec fixes the two system prompts, so this is **appended**, not
 * interleaved: the original text above stays byte-for-byte intact.
 */
export const RECENCY_DIRECTIVE = `
Recency rules for this answer (the input carries dataRecency and dataQuality — trust them):
- grade "fresh": the numbers are recent, but they are still not a real-time feed; say the timestamp instead of promising a live price.
- grade "delayed": say explicitly that the data is delayed.
- grade "stale": say the data is the last available data, not current, and name its timestamp.
- grade "historical": the numbers are from a previous session; never present them as a current price.
- Never write "now", "today", "currently trading" or "live" whatever the grade.
- When stale is true, name which block (quote or candles) is stale and why.`;

/**
 * Localisation directive appended to the system prompt.
 *
 * The published spec fixes the system prompts and the JSON contract, so the
 * prompts themselves are never rewritten: only the natural-language strings
 * inside the answer change. Keys, codes, symbols and numbers stay exactly as the
 * schema requires, which keeps `normalizeAnalysis()` / `normalizeBrief()`
 * language-agnostic.
 *
 * @param {string|null|undefined} lang 'en' (default) or 'zh'
 * @returns {string} '' for English, otherwise the additive instruction
 */
export function languageDirective(lang) {
  if (lang !== 'zh') return '';
  return `

Localisation: write every human-readable string in the JSON values (summary, trend, momentum, volume, riskFactors, keyObservations, and for a brief: headline, strongestMover, largestDecline, unusualVolume) in Simplified Chinese (简体中文). Keep every JSON key, ticker symbol, currency code, number, unit and percentage exactly as specified above — do not translate or reformat them.`;
}

/**
 * Assembles the host `llm.stream()` chunk sequence into text, per the public
 * `StreamChunk` contract.
 *
 * The plugin must NOT import `@deepseek-ai/dsh-llm`: that package is a host
 * dependency that lives inside the application bundle and is not installed into
 * the profile (`autoInstallPeers: false` + a `link:`-ed plugin has no
 * node_modules), so resolving it from plugin code always failed and every brief
 * died with AI_UNAVAILABLE. The chunk union is public API, so assembling it here
 * is both sufficient and strictly more robust than depending on host internals.
 *
 * Handled: block-start / text-delta / reasoning-delta / tool-call-delta /
 * block-end / usage / finish. Unknown types are ignored on purpose.
 */
export class ChunkAssembler {
  constructor() {
    /** @type {Map<number|string, any>} */
    this.blocks = new Map();
    /** @type {(number|string)[]} */
    this.order = [];
    this.current = null;
    this.usage = null;
    /** @type {{kind: string|null, failure: any, raw: any}} */
    this.finish = { kind: null, failure: null, raw: null };
    this.sawChunk = false;
  }

  /** @param {any} chunk */
  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return this;
    this.sawChunk = true;
    switch (chunk.type) {
      case 'block-start': {
        const block = this.blockFor(chunk.index, chunk.blockType || 'text');
        block.type = chunk.blockType || block.type;
        break;
      }
      case 'text-delta': {
        this.blockFor(chunk.index, 'text').text += typeof chunk.text === 'string' ? chunk.text : '';
        break;
      }
      case 'reasoning-delta': {
        const block = this.blockFor(chunk.index, 'reasoning');
        block.type = 'reasoning';
        block.reasoning += typeof chunk.text === 'string' ? chunk.text : '';
        break;
      }
      case 'tool-call-delta': {
        const block = this.blockFor(chunk.index ?? chunk.id, 'tool-call');
        block.type = 'tool-call';
        block.name = chunk.name ?? block.name;
        block.arguments = `${block.arguments || ''}${chunk.argumentsDelta ?? ''}`;
        break;
      }
      case 'block-end': {
        const block = this.blockFor(chunk.index, chunk.block?.type || 'text');
        block.ended = true;
        if (chunk.block && typeof chunk.block === 'object') {
          if (typeof chunk.block.type === 'string') block.type = chunk.block.type;
          if (typeof chunk.block.text === 'string') block.text = chunk.block.text;
          if (typeof chunk.block.reasoning === 'string') block.reasoning = chunk.block.reasoning;
          block.final = chunk.block;
        }
        break;
      }
      case 'usage': {
        if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage;
        break;
      }
      case 'finish': {
        const reason = chunk.reason;
        const kind = typeof reason === 'string' ? reason : reason?.kind ?? reason?.type ?? null;
        const failure = reason && typeof reason === 'object' ? reason.failure ?? null : null;
        this.finish = { kind, failure, raw: reason };
        break;
      }
      default:
        break;
    }
    return this;
  }

  blockFor(index, type) {
    const key = typeof index === 'number' || typeof index === 'string' ? index : this.current ?? 0;
    this.current = key;
    let block = this.blocks.get(key);
    if (!block) {
      block = { index: key, type, text: '', reasoning: '', ended: false };
      this.blocks.set(key, block);
      this.order.push(key);
    }
    return block;
  }

  /** Visible answer text: text blocks only, never reasoning or tool arguments. */
  text() {
    return this.order
      .map((key) => this.blocks.get(key))
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
      .map((block) => block.text)
      .join('');
  }

  /** The terminal finish reason, inferred when the stream ended without one. */
  finishReason() {
    if (this.finish.kind) return this.finish;
    if (this.text()) return { kind: 'stop', failure: null, raw: null };
    return { kind: 'error', failure: { message: 'the model stream ended without producing any text' }, raw: null };
  }
}

export class TradingAi {
  /**
   * @param {{llm?: any, defaultModel?: any, logger?: any, config?: any}} [opts]
   *   `llm` / `defaultModel` may be the service itself **or a getter**. Getters
   *   are preferred: the plugin is applied from `ready` and the services it
   *   needs may be registered afterwards, so binding them once at apply time
   *   could freeze them to `undefined`.
   */
  constructor(opts = {}) {
    this._llm = opts.llm || null;
    this._defaultModel = opts.defaultModel || null;
    this.logger = opts.logger || null;
    this.config = { ...AI_CONFIG, ...(opts.config || {}) };
    /** @type {'idle'|'ok'|'degraded'} */
    this.state = 'idle';
    this.lastError = null;
    this.calls = 0;
    this.failures = 0;
    this.lastRoute = null;
  }

  /** Late-bound host `llm` service (see the constructor note). */
  get llm() {
    return readService(this._llm);
  }

  /** Late-bound host `agentDefaultModel` service. */
  get defaultModel() {
    return readService(this._defaultModel);
  }

  get available() {
    const llm = this.llm;
    return Boolean(llm && typeof llm.stream === 'function');
  }

  /** Why the AI panel is unavailable — surfaced in `status()` for diagnosis. */
  unavailableReason() {
    if (!this._llm) return 'the plugin did not receive the llm service (ctx.llm)';
    const llm = this.llm;
    if (!llm) return 'ctx.get("llm") is not registered (is the dsh-llm plugin loaded?)';
    if (typeof llm.stream !== 'function') return 'the llm service exposes no stream() method';
    if (!this.resolveRouteSync()) return 'no DeepSeek model route is configured in DSH';
    return null;
  }

  /**
   * Synchronous part of route resolution: explicit overrides → plugin config →
   * DSH's current default model. Async provider discovery lives in
   * `resolveRoute()`.
   */
  resolveRouteSync(overrides = {}) {
    if (overrides.provider && overrides.model) return { provider: overrides.provider, model: overrides.model };
    if (this.config.provider && this.config.model) return { provider: this.config.provider, model: this.config.model };
    try {
      const model = this.defaultModel;
      const selection = model && typeof model.currentSelection === 'function' ? model.currentSelection() : null;
      // The host hands back a detached selection; accept both the documented
      // `{provider, model}` shape and a `{providerId, modelId}` alias so a host
      // rename degrades to the async discovery path instead of failing.
      if (selection) {
        const provider = selection.provider || selection.providerId;
        const id = selection.model || selection.modelId;
        if (provider && id) return { provider, model: id };
      }
    } catch (err) {
      this.logger?.debug?.(`ai: currentSelection() failed: ${err && err.message}`);
    }
    return null;
  }

  /**
   * The model route to use. Falls back to asking the llm service which provider
   * advertises a DeepSeek model; `listModels()` is asynchronous in the host
   * contract, so this method is async too.
   */
  async resolveRoute(overrides = {}) {
    const direct = this.resolveRouteSync(overrides);
    if (direct) return direct;
    const llm = this.llm;
    try {
      if (llm && typeof llm.listProviders === 'function') {
        const providers = (await llm.listProviders()) || [];
        for (const provider of providers) {
          const id = typeof provider === 'string' ? provider : provider?.id;
          if (!id) continue;
          let models = [];
          try {
            models = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
          } catch (err) {
            this.logger?.debug?.(`ai: listModels(${id}) failed: ${err && err.message}`);
          }
          const model = (models || []).map((m) => (typeof m === 'string' ? m : m?.id)).find((m) => m && /deepseek/i.test(m));
          if (model) return { provider: id, model };
        }
      }
    } catch (err) {
      this.logger?.debug?.(`ai: provider discovery failed: ${err && err.message}`);
    }
    return null;
  }

  /**
   * One structured DeepSeek call: `ctx.llm.stream()` → chunk assembly → JSON.
   * The DSH retry plugin does not cover direct plugin calls, so retry here.
   */
  async askJson(system, userText, opts = {}) {
    const llm = this.llm;
    if (!llm || typeof llm.stream !== 'function') {
      throw new TradingError(CODES.AI_UNAVAILABLE, `the DSH LLM runtime is not available to this plugin: ${this.unavailableReason() || 'no llm service'}`, { retryable: false });
    }
    const route = await this.resolveRoute(opts);
    if (!route) {
      throw new TradingError(
        CODES.AI_UNAVAILABLE,
        'no DeepSeek model route is configured in DSH (set a model in the GUI, or configure provider/model for the trading-mode plugin)',
        { retryable: false },
      );
    }
    this.lastRoute = route;

    const attempts = Math.max(1, opts.attempts ?? 3);
    const maxTokens = opts.maxTokens ?? this.config.maxTokens;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      const startedAt = Date.now();
      try {
        // Request messages must satisfy the host's `RequestUserInput` shape:
        // role + content only — no `id`, no `source` (both are `never` there).
        const assembler = new ChunkAssembler();
        const stream = await llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [buildUserMessage(userText)],
          system,
          maxTokens,
          temperature: this.config.temperature,
          signal: controller.signal,
        });
        for await (const chunk of stream) assembler.push(chunk);

        const finish = assembler.finishReason();
        if (finish.kind === 'aborted') {
          throw Object.assign(new Error(`the model call was aborted: ${finish.failure?.message || 'timeout or cancellation'}`), { code: 'TIMEOUT', aborted: true });
        }
        if (finish.kind === 'error') {
          throw Object.assign(new Error(finish.failure?.message || 'the model reported an error'), { code: finish.failure?.code || 'SERVER' });
        }
        if (finish.kind === 'max-tokens') {
          throw Object.assign(new Error(`the model hit the ${maxTokens}-token cap before finishing its JSON; nothing usable was returned`), { code: 'AI_INVALID_OUTPUT' });
        }
        if (finish.kind !== 'stop') {
          throw Object.assign(new Error(`unusable finish reason: ${finish.kind}`), { code: 'AI_INVALID_OUTPUT' });
        }
        const text = assembler.text();
        if (!text.trim()) {
          throw Object.assign(new Error('the model returned no text'), { code: 'EMPTY_RESPONSE' });
        }
        const parsed = JSON.parse(repair(text));
        this.calls += 1;
        this.state = 'ok';
        this.lastError = null;
        return { value: parsed, meta: { provider: route.provider, model: route.model, attempt, elapsedMs: Date.now() - startedAt, usage: assembler.usage || null } };
      } catch (err) {
        lastError = err;
        const code = err?.code ?? err?.failure?.code;
        const retryable = !code || RETRYABLE.has(code);
        this.logger?.debug?.(`ai: attempt ${attempt}/${attempts} failed (${code || 'unknown'}: ${err && err.message})`);
        if (attempt >= attempts || !retryable) break;
        await sleep(500 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    }
    this.failures += 1;
    this.state = 'degraded';
    this.lastError = lastError ? lastError.message : 'unknown failure';
    throw new TradingError(CODES.AI_UNAVAILABLE, `DeepSeek analysis failed: ${this.lastError}`, { cause: lastError, provider: route.provider });
  }

  /**
   * §37 single-stock analysis. `snapshot` is assembled by ApiRoutes from the
   * service — this function performs no I/O of its own.
   * @param {any} snapshot {symbol, quote, profile, technical, candles}
   */
  async analyzeStock(snapshot, opts = {}) {
    const input = buildStockInput(snapshot);
    const lang = opts.lang === 'zh' ? 'zh' : 'en';
    const { value, meta } = await this.askJson(STOCK_SYSTEM_PROMPT + RECENCY_DIRECTIVE + languageDirective(lang), JSON.stringify(input), opts);
    const analysis = normalizeAnalysis(value);
    return {
      analysis,
      meta: {
        ...meta,
        symbol: snapshot.symbol,
        dataAsOf: input.data.asOf,
        quoteSource: snapshot.quote?.source || null,
        dataStale: Boolean(snapshot.stale),
        dataQuality: qualityFor(input.data.dataRecency, input.data.technical),
        lang,
        disclaimer: DISCLAIMER,
      },
    };
  }

  /** §38–§40 watchlist brief. */
  async watchlistBrief(snapshot, opts = {}) {
    const input = buildBriefInput(snapshot);
    if (!input.stocks.length) {
      throw new TradingError(CODES.BAD_REQUEST, 'the watchlist is empty, so there is nothing to summarise');
    }
    const lang = opts.lang === 'zh' ? 'zh' : 'en';
    const { value, meta } = await this.askJson(BRIEF_SYSTEM_PROMPT + RECENCY_DIRECTIVE + languageDirective(lang), JSON.stringify(input), opts);
    const brief = normalizeBrief(value, input);
    return {
      brief,
      meta: {
        ...meta,
        stocksTracked: input.stocks.length,
        dataAsOf: input.asOf,
        dataQuality: qualityFor(input.dataRecency, null),
        lang,
        disclaimer: DISCLAIMER,
      },
    };
  }

  status() {
    return {
      available: this.available,
      state: this.state,
      reason: this.unavailableReason(),
      route: this.resolveRouteSync(),
      lastRoute: this.lastRoute,
      calls: this.calls,
      failures: this.failures,
      lastError: this.lastError,
      maxTokens: this.config.maxTokens,
      timeoutMs: this.config.timeoutMs,
    };
  }
}

// -------------------------------------------------------------------- shaping

/** Everything the model is allowed to see, and nothing else (§4/§16). */
export function buildStockInput(snapshot) {
  const { quote, profile, technical } = snapshot;
  const dataRecency = recencyOf(snapshot.asOf ?? quote?.timestamp, {
    stale: Boolean(snapshot.stale),
    staleReason: snapshot.staleReason ?? null,
    marketOpen: snapshot.marketOpen ?? null,
    dataAgeMs: snapshot.dataAgeMs,
  });
  return {
    instruction: 'Analyse this single stock using only the values below.',
    data: {
      symbol: snapshot.symbol,
      market: snapshot.market,
      company: {
        name: profile?.name || quote?.name || null,
        nameZh: profile?.nameZh || quote?.nameZh || null,
        exchange: profile?.exchange || quote?.exchange || null,
        currency: profile?.currency || quote?.currency || null,
        industry: profile?.industry || null,
        sector: profile?.sector || null,
        country: profile?.country || null,
        description: profile?.description ? truncate(profile.description, 900) : null,
      },
      quote: quote
        ? {
            price: quote.price,
            change: quote.change,
            changePct: quote.changePct,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            previousClose: quote.previousClose,
            volume: quote.volume,
            timestamp: isoOrNull(quote.timestamp),
            source: quote.source,
            delaySeconds: quote.delaySeconds,
            stale: Boolean(quote.stale),
          }
        : null,
      asOf: isoOrNull(snapshot.asOf),
      /** 0.7.0: the model must know how old the numbers are before it writes prose. */
      dataRecency,
      technical: technical
        ? {
            asOf: isoOrNull(technical.asOf),
            bars: technical.bars,
            interval: technical.interval,
            values: technical.technical,
            trendAlignment: technical.technical?.trendAlignment,
            unavailable: technical.unavailable,
            /** How much history backs the indicators (may be 'insufficient'). */
            quality: technical.quality ?? null,
          }
        : null,
      levels: technical?.levels || null,
      recentDailyCloses: recentCloses(snapshot.candles, 20),
      marketSessionOpen: snapshot.marketOpen ?? null,
    },
    dataAvailability: {
      quote: Boolean(quote),
      profile: Boolean(profile),
      technical: Boolean(technical?.technical),
      missingFields: technical?.unavailable || [],
      historyGrade: technical?.quality?.grade ?? null,
    },
  };
}

export function buildBriefInput(snapshot) {
  const stamps = (snapshot.stocks || []).map((entry) => entry.quote?.timestamp).filter((ts) => Number.isFinite(Number(ts)));
  const oldest = stamps.length ? Math.min(...stamps.map(Number)) : null;
  const staleStocks = (snapshot.stocks || []).filter((entry) => entry.stale).length;
  // A brief is only as fresh as its *oldest* row: `snapshot.asOf` is the moment
  // the payload was assembled, so it must never upgrade a stale watchlist to
  // "live" — it is only a fallback when no row carries a timestamp.
  const dataRecency = recencyOf(oldest ?? snapshot.asOf, {
    stale: staleStocks > 0,
    staleReason: staleStocks ? `${staleStocks} of ${(snapshot.stocks || []).length} watchlist rows are cached` : null,
    marketOpen: null,
    dataAgeMs: null,
  });
  return {
    instruction: 'Summarise this watchlist using only the values below.',
    stocks: (snapshot.stocks || []).map((entry) => ({
      symbol: entry.symbol,
      name: entry.quote?.name || entry.quote?.nameZh || null,
      market: entry.market,
      currency: entry.quote?.currency || null,
      price: entry.quote?.price ?? null,
      change: entry.quote?.change ?? null,
      changePct: entry.quote?.changePct ?? null,
      volume: entry.quote?.volume ?? null,
      volumeRatio20d: entry.technical?.technical?.volumeRatio20d ?? null,
      rsi14: entry.technical?.technical?.rsi14 ?? null,
      macdHistogram: entry.technical?.technical?.macdHistogram ?? null,
      ma20: entry.technical?.technical?.ma20 ?? null,
      ma50: entry.technical?.technical?.ma50 ?? null,
      ma200: entry.technical?.technical?.ma200 ?? null,
      trendAlignment: entry.technical?.technical?.trendAlignment ?? null,
      high52w: entry.technical?.technical?.high52w ?? null,
      low52w: entry.technical?.technical?.low52w ?? null,
      timestamp: isoOrNull(entry.quote?.timestamp),
      source: entry.quote?.source ?? null,
      stale: Boolean(entry.stale),
      unavailable: entry.technical?.unavailable || [],
      errors: entry.error ? [entry.error] : [],
    })),
    asOf: isoOrNull(snapshot.asOf),
    dataRecency: { ...dataRecency, staleStocks, totalStocks: (snapshot.stocks || []).length },
    dataQuality: qualityFor(dataRecency, null),
  };
}

/** Age of a provider timestamp in ms; timestamps arrive in seconds or ms. */
export function ageMsOf(asOf, now = Date.now()) {
  const ts = Number(asOf);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return Math.max(0, now - ms);
}

/**
 * Turn "when was this measured" into a grade the prompt and the UI can use.
 * `ageMs` may be supplied when the caller already computed it.
 */
export function recencyOf(asOf, { stale = false, staleReason = null, marketOpen = null, dataAgeMs = null } = {}) {
  const ageMs = Number.isFinite(dataAgeMs) ? dataAgeMs : ageMsOf(asOf);
  const ageSeconds = ageMs === null ? null : Math.round(ageMs / 1000);
  let grade = 'unknown';
  if (ageMs !== null) {
    if (ageMs <= AI_CONFIG.freshMaxAgeMs) grade = 'fresh';
    else if (ageMs <= AI_CONFIG.staleWarnMs) grade = 'delayed';
    else if (ageMs <= AI_CONFIG.staleHistoricalMs) grade = 'stale';
    else grade = 'historical';
  }
  return {
    asOf: isoOrNull(asOf),
    ageSeconds,
    grade,
    stale: Boolean(stale),
    staleReason: staleReason || null,
    marketSessionOpen: marketOpen ?? null,
  };
}

/**
 * The compact quality verdict returned with an answer, so the client can label
 * it ("fresh" / "delayed" / "last available session") instead of implying the
 * numbers are real-time.
 */
export function qualityFor(dataRecency, technical) {
  const recency = dataRecency || { grade: 'unknown', ageSeconds: null, stale: false };
  const grade = recency.grade || 'unknown';
  const qualification =
    grade === 'fresh'
      ? 'Market data is recent; the timestamp is shown and the feed is not claimed to be real-time.'
      : grade === 'delayed'
        ? 'Market data is delayed; treat the numbers as indicative, not real-time.'
        : grade === 'stale'
          ? 'Market data is the last available snapshot, not a current quote.'
          : grade === 'historical'
            ? 'Market data is from a previous session and is shown as historical values.'
            : 'Data age could not be determined; do not describe the numbers as current.';
  return {
    grade,
    ageSeconds: recency.ageSeconds ?? null,
    stale: Boolean(recency.stale),
    staleReason: recency.staleReason || null,
    qualification,
    historyGrade: technical?.quality?.grade ?? null,
    historyBars: technical?.bars ?? null,
  };
}

/** §35 shape, coerced field by field — the model is never trusted blindly. */
export function normalizeAnalysis(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const trend = src.trend && typeof src.trend === 'object' ? src.trend : {};
  return {
    summary: text(src.summary, 'No summary was returned.'),
    trend: {
      shortTerm: text(trend.shortTerm, 'Unavailable.'),
      mediumTerm: text(trend.mediumTerm, 'Unavailable.'),
      longTerm: text(trend.longTerm, 'Unavailable.'),
    },
    momentum: text(src.momentum, 'Unavailable.'),
    volume: text(src.volume, 'Unavailable.'),
    supportLevels: numbers(src.supportLevels),
    resistanceLevels: numbers(src.resistanceLevels),
    riskFactors: strings(src.riskFactors),
    keyObservations: strings(src.keyObservations),
  };
}

export function normalizeBrief(raw, input) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const computedUp = input.stocks.filter((s) => typeof s.changePct === 'number' && s.changePct > 0).length;
  const computedDown = input.stocks.filter((s) => typeof s.changePct === 'number' && s.changePct < 0).length;
  return {
    headline: text(src.headline, 'Market brief unavailable.'),
    stocksTracked: typeof src.stocksTracked === 'number' ? src.stocksTracked : input.stocks.length,
    upCount: typeof src.upCount === 'number' ? src.upCount : computedUp,
    downCount: typeof src.downCount === 'number' ? src.downCount : computedDown,
    strongestMover: text(src.strongestMover, 'Unavailable.'),
    largestDecline: text(src.largestDecline, 'Unavailable.'),
    unusualVolume: strings(src.unusualVolume),
    keyObservations: strings(src.keyObservations),
  };
}

/** Strip markdown fences, then take the outermost JSON object (§ research). */
export function repair(text) {
  const raw = String(text ?? '').trim();
  const stripped = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start < 0 || end < start ? stripped : stripped.slice(start, end + 1);
}

/**
 * A user message in the shape the host accepts (`RequestUserInput`): role and
 * content only. `id` and `source` are declared `never` on the request side, so
 * the plugin must not attach its own provenance envelope here.
 */
export function buildUserMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** Resolve a service that may have been handed over directly or as a getter. */
function readService(value) {
  if (typeof value === 'function') {
    try {
      return value() || null;
    } catch {
      return null;
    }
  }
  return value || null;
}

function text(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length) return value.map((v) => String(v)).join(' ');
  return fallback;
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : typeof entry === 'number' ? String(entry) : typeof entry === 'object' && entry ? text(entry.text ?? entry.description ?? entry.name, '') : ''))
    .filter((entry) => entry.length > 0);
}

function numbers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
      if (entry && typeof entry === 'object' && typeof entry.level === 'number') return entry.level;
      const parsed = Number.parseFloat(String(entry));
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter((entry) => entry !== null);
}

function recentCloses(candles, count) {
  if (!Array.isArray(candles) || !candles.length) return [];
  return candles.slice(-count).map((c) => ({ timestamp: isoOrNull(c.timestamp), close: c.close, volume: c.volume ?? null }));
}

function isoOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
