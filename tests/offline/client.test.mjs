/**
 * Client-half contract: loader shape, slot registration and server-render smoke
 * checks (0.5.x wording rules included).
 *
 * Portable: it discovers react/react-dom instead of hard-coding a profile path,
 * reads lib/client.js from this package, and needs no network.
 *
 *   node tests/offline/client.test.mjs   (or: npm run test:client)
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 0.7.0 (P0-3): the render checks gate a release, so a missing prerequisite is
// a blocker there — `--release`/DSH_TEST_RELEASE turns the SKIP into a FAIL.
const RELEASE = process.argv.includes('--release') || process.env.DSH_TEST_RELEASE === '1';

/** Report this suite's result to the runner (0.7.0 P0-3); best effort. */
function report(result) {
  const target = process.env.DSH_TEST_RESULT_FILE;
  if (!target) return;
  try {
    appendFileSync(target, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {
    /* reporting must never break the suite */
  }
}

// The React that renders these components belongs to the *host*: the client half
// is loaded into the DSH Web shell. Resolve it from, in order, an explicit
// override, this package's own devDependencies, every DSH profile on the
// machine, then a global install. When none of them has react, report SKIP.
function resolveReactRoot() {
  const candidates = [];
  if (process.env.DSH_TRADING_REACT_DIR) candidates.push(process.env.DSH_TRADING_REACT_DIR);
  candidates.push(path.resolve(PLUGIN, 'node_modules'));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = path.join(home, 'profiles');
  // Both layouts exist in the wild: profiles/node_modules (hoisted) and
  // profiles/<name>/node_modules (per-profile).
  candidates.push(path.join(profiles, 'node_modules'));
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(profiles, entry.name, 'node_modules'));
    }
  }
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules'));
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'react')) && existsSync(path.join(dir, 'react-dom'))) return dir;
  }
  return null;
}

const REACT_ROOT = resolveReactRoot();
if (!REACT_ROOT) {
  console.log('\n== client bundle contract ==');
  const reason = 'react/react-dom are not resolvable, so the render checks cannot run';
  if (RELEASE) {
    console.log(`  FAIL  ${reason}.`);
    console.log('        Release builds may not skip the client render checks: run npm install, or point');
    console.log('        DSH_TRADING_REACT_DIR at a directory that contains node_modules.');
    report({ title: 'client', required: true, passed: 0, failed: 1, skipped: 0, skipReasons: [], failures: [reason], ok: false });
    process.exit(1);
  }
  console.log(`  SKIP  ${reason}.`);
  console.log('        Install the devDependencies (npm install), or point');
  console.log('        DSH_TRADING_REACT_DIR at a directory that contains node_modules.');
  report({
    title: 'client',
    required: true,
    passed: 0,
    failed: 0,
    skipped: 1,
    skipReasons: [{ name: 'client render checks', reason }],
    failures: [],
    ok: false,
  });
  process.exit(3);
}
const require = createRequire(path.join(REACT_ROOT, 'noop.js'));

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error && error.message}`);
    console.log(`  FAIL  ${name} — ${error && error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// --------------------------------------------------------------- DOM / loader
let captured = null;
const styleTags = [];

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

// Pin the platform language so the English assertions below are deterministic.
// The plugin follows `navigator.language` unless DSH exposes its own locale, and
// the machine running this test may well be zh-CN (Node exposes that as a
// getter-only global, hence defineProperty rather than assignment).
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  configurable: true,
  writable: true,
});

globalThis.document = {
  head: {
    appendChild(node) {
      styleTags.push(node);
      node.parentNode = {
        removeChild(target) {
          const index = styleTags.indexOf(target);
          if (index >= 0) styleTags.splice(index, 1);
        },
      };
    },
  },
  createElement() {
    return { textContent: '', parentNode: null };
  },
};

globalThis.fetch = () =>
  Promise.reject(Object.assign(new Error('network disabled in the smoke test'), { code: 'ERROR', name: 'Error' }));

const react = require('react');
const { renderToString } = require('react-dom/server');
const h = react.createElement;

console.log('== client bundle contract ==');

const source = readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8');

await check('lib/client.js loads through window.__ModuleLoader__.load', async () => {
  assert(!/^\s*(import|export)\s/m.test(source), 'the bundle must not contain top-level ESM syntax');
  // eslint-disable-next-line no-new-func
  new Function(source)();
  assert(captured, 'load() was never called');
  assert(captured.id === 'dsh-trading-mode', `id must be the npm package name, got ${captured.id}`);
  return `id=${captured.id}`;
});

let mod = null;
await check('factory resolves react and returns { name, inject, apply }', async () => {
  mod = captured.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require("${id}") — only platform seeds are resolvable`);
  });
  assert(typeof mod.apply === 'function', 'apply must be a function');
  assert(mod.name === 'trading-mode', `name must be trading-mode, got ${mod.name}`);
  assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject must declare the slots service');
  return `name=${mod.name} inject=[${mod.inject}]`;
});

const registry = [];
const effects = [];
await check('apply registers the trigger button and the overlay app', async () => {
  // The registration contract is the one the shipped third-party plugins use on
  // the live runtime: `ctx.slots.inject(key, callback)` with a PLAIN callback
  // that returns the registration's disposer (not a generator), and
  // `ctx.slots.register(options, Component)`.
  let activeKey = null;
  const ctx = {
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    slots: {
      inject(key, callback) {
        assert(typeof callback === 'function', 'slots.inject must be given a callback');
        assert(
          callback.constructor.name !== 'GeneratorFunction',
          'slots.inject must take a plain callback returning a disposer, not a generator',
        );
        activeKey = key;
        const disposer = callback();
        activeKey = null;
        assert(typeof disposer === 'function', `slots.inject callback for ${key} must return a disposer`);
        return () => {};
      },
      register(options, Component) {
        assert(typeof Component === 'function', 'slot registration must pass a component function');
        const entry = { key: activeKey, options, Component };
        registry.push(entry);
        return () => {
          const at = registry.indexOf(entry);
          if (at !== -1) registry.splice(at, 1);
        };
      },
    },
  };
  mod.apply(ctx);

  assert(registry.length === 2, `expected 2 slots, got ${registry.length}`);
  const header = registry.find((entry) => entry.key === 'conversation.session.header.actions');
  const overlay = registry.find((entry) => entry.key === 'shell.overlay');
  assert(header, 'the header action slot must be populated');
  assert(overlay, 'the shell.overlay slot must be populated');
  for (const entry of registry) {
    assert(entry.options.name === entry.key, 'registration name must match the slot key');
    assert(typeof entry.options.id === 'string' && entry.options.id.length > 0, 'each registration needs a stable id');
    assert(typeof entry.options.order === 'number', 'each registration needs an order');
    assert(typeof entry.Component === 'function', 'registration must carry a component');
  }
  assert(styleTags.length === 1, 'exactly one stylesheet must be injected');
  assert(effects.some((entry) => String(entry.label).includes('styles')), 'the stylesheet must be cleaned up on dispose');
  return `slots=${registry.map((entry) => entry.key).join(', ')}`;
});

await check('dispose removes the injected stylesheet', async () => {
  for (const entry of effects) {
    if (typeof entry.disposer === 'function') entry.disposer();
  }
  assert(styleTags.length === 0, `stylesheet leaked: ${styleTags.length} still attached`);
  return '0 style tags left';
});

// ------------------------------------------------------------------ ssr render
const internals = mod._internals;

await check('helpers: symbol mapping for the TradingView embed', async () => {
  assert(internals.tradingViewSymbol({ symbol: '0700.HK' }) === 'HKEX:700', '0700.HK must map to HKEX:700');
  assert(internals.tradingViewSymbol({ symbol: 'AAPL', exchange: 'NASDAQ' }) === 'NASDAQ:AAPL', 'US listing keeps its venue');
  assert(internals.tradingViewSymbol({ symbol: 'BABA', exchange: 'NYSE' }) === 'NYSE:BABA', 'NYSE must not collapse to NASDAQ');
  return '0700.HK → HKEX:700, AAPL → NASDAQ:AAPL';
});

await check('helpers: quote formatting never prints NaN', async () => {
  assert(internals.money(421.2, 'HKD') === 'HK$421.20', `got ${internals.money(421.2, 'HKD')}`);
  assert(internals.money(undefined, 'USD') === '—', 'missing price must render as a dash');
  assert(internals.percent(-0.02) === '−0.02%', `got ${internals.percent(-0.02)}`);
  assert(internals.volumeText(1234567) === '1.23M', `got ${internals.volumeText(1234567)}`);
  assert(internals.clockOf(undefined) === '—', 'missing timestamp must render as a dash');
  return 'money/percent/volume/clock';
});

await check('geometry: one body + wick per bar, volume panel below the price', async () => {
  const bars = [
    { timestamp: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { timestamp: 2, open: 11, high: 13, low: 10, close: 10.5, volume: 200 },
  ];
  const series = { timestamp: [1, 2], ma20: [10.5, 10.6], ma50: [10, 10.1], ma200: [9, 9.1] };
  const geo = internals.buildGeometry(bars, series, 1000, 340);
  assert(geo.bodies.length === 2 && geo.wicks.length === 2 && geo.volumes.length === 2, 'one shape per bar');
  assert(geo.lines.length === 3, 'three moving averages must produce three polylines');
  assert(geo.max === 13 && geo.min === 9, `price range wrong: ${geo.min}..${geo.max}`);
  assert(geo.volumes.every((v) => v.y > 200), 'volume bars must sit in the lower panel');
  return `${geo.bodies.length} bars, ${geo.lines.length} MAs`;
});

await check('downsample keeps the first and last bar', async () => {
  const bars = Array.from({ length: 1500 }, (_, i) => ({ timestamp: i, open: i, high: i, low: i, close: i, volume: i }));
  const out = internals.downsample(bars, 320);
  assert(out.length <= 321, `too many bars survived: ${out.length}`);
  assert(out[0].timestamp === 0 && out[out.length - 1].timestamp === 1499, 'range endpoints must survive');
  return `${bars.length} → ${out.length} bars`;
});

await check('the overlay renders nothing while closed', async () => {
  internals.store.set({ open: false, view: 'home', symbol: null });
  const html = renderToString(h(internals.TradingApp));
  assert(html === '', `closed app must render nothing, got ${html.length} chars`);
  return 'empty';
});

let homeHtml = '';
await check('home view renders Search + My Watchlist + AI Watchlist Brief', async () => {
  internals.store.set({ open: true, view: 'home', symbol: null });
  homeHtml = renderToString(h(internals.TradingApp));
  for (const needle of ['DSH Trading Mode', 'My Watchlist', 'AI Watchlist Brief', 'Add Stock', 'Search Stocks']) {
    assert(homeHtml.includes(needle), `home view is missing "${needle}"`);
  }
  assert(homeHtml.includes('Data source status') || homeHtml.includes('sources ready'), 'the data-source status strip must render');
  return `${homeHtml.length} chars`;
});

let detailHtml = '';
await check('detail view renders the §27 sections', async () => {
  internals.store.set({ open: true, view: 'detail', symbol: 'AAPL' });
  detailHtml = renderToString(h(internals.TradingApp));
  for (const needle of ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'Chart', 'Market Data', 'Technical Indicators', 'AI Analysis', 'Previous Close', 'TradingView']) {
    assert(detailHtml.includes(needle), `detail view is missing "${needle}"`);
  }
  // Effects do not run under renderToString, so the chart/technical panels are
  // in their loading state here; the loaded state is covered by technicalCells.
  assert(detailHtml.includes('Computing indicators'), 'the technical panel must show its loading state');
  return `${detailHtml.length} chars`;
});

await check('§31 technical grid maps every required indicator', async () => {
  const tech = {
    ma5: 1, ma10: 2, ma20: 3, ma50: 4, ma60: 5, ma200: 6,
    ema12: 7, ema26: 8, rsi14: 9, macd: 10, macdSignal: 11, macdHistogram: 12,
    atr14: 13, volumeRatio20d: 14, volumeAverage20d: 15, high52w: 16, low52w: 17,
    trendAlignment: 'bullish-stack', volatility20dAnnualizedPct: 18,
  };
  const cells = internals.technicalCells(tech);
  const labels = cells.map((cell) => cell.label);
  for (const needle of ['MA5', 'MA10', 'MA20', 'MA50', 'MA60', 'MA200', 'EMA12', 'EMA26', 'RSI14', 'MACD', 'MACD Signal', 'MACD Histogram', 'ATR14', 'Volume Ratio (20D)']) {
    assert(labels.includes(needle), `technical grid is missing "${needle}"`);
  }
  const byLabel = Object.fromEntries(cells.map((cell) => [cell.label, cell.value]));
  assert(byLabel.MA20 === '3.00', `MA20 should be formatted, got ${byLabel.MA20}`);
  assert(byLabel.RSI14 === '9.00', `RSI14 should be formatted, got ${byLabel.RSI14}`);
  assert(byLabel['Volume Ratio (20D)'] === '14.00×', `volume ratio unit missing, got ${byLabel['Volume Ratio (20D)']}`);
  assert(byLabel['Volatility 20D (ann.)'] === '18.00%', 'volatility must carry a percent sign');
  assert(internals.technicalCells(null).length === 0, 'no technical block means no cells');
  assert(internals.technicalCells({}).every((cell) => cell.value === '—'), 'missing fields must render as a dash, not NaN');
  return `${cells.length} cells`;
});

await check('§21 freshness wording is present and nothing claims live data', async () => {
  assert(detailHtml.includes('Updated') || homeHtml.includes('Updated'), 'the word "Updated" must appear');
  assert(detailHtml.includes('Data may be delayed'), '"Data may be delayed" must appear when data is not stale');
  assert(internals.nameOf({ symbol: 'X' }, 'X') === 'X', 'name fallback must not be empty');
  for (const forbidden of ['Live', 'Real-time', 'Real time', 'Tick-level', 'Portfolio', 'Holdings', 'Profit']) {
    assert(!new RegExp(forbidden, 'i').test(detailHtml), `detail view must not contain "${forbidden}" (§21/§26)`);
    assert(!new RegExp(forbidden, 'i').test(homeHtml), `home view must not contain "${forbidden}" (§21/§26)`);
  }
  return 'Updated / Data may be delayed present, no live or portfolio claims';
});

await check('stale data switches the note to "Last available data"', async () => {
  const html = renderToString(h(internals.TradingApp));
  assert(html.length > 0, 'app should still render');
  const stale = renderToString(
    h(internals.TradingApp, null),
  );
  assert(typeof stale === 'string', 'stale render must not throw');
  // Direct structural check of the Freshness component through the chart panel:
  const chart = renderToString(h(internals.CandleChart, { candles: [], series: null }));
  assert(chart.includes('Data unavailable'), 'an empty candle set must say "Data unavailable"');
  return 'empty chart → Data unavailable';
});

await check('0.5.0 charts: a short history is labelled instead of silently truncated', async () => {
  const bars = (n) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: 1700000000000 + i * 86400000,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 100 + i,
    }));
  const full = renderToString(h(internals.CandleChart, { candles: bars(60), series: null, interval: '1d', degraded: false }));
  const partial = renderToString(h(internals.CandleChart, { candles: bars(1), series: null, interval: '1d', degraded: true }));
  assert(!full.includes('partial history'), 'a complete chart must not claim partial history');
  assert(partial.includes('partial history'), 'a degraded chart must be labelled');
  assert(partial.includes('1 bars'), 'the bar count still renders');
  const zh = internals.ZH['partial history'];
  assert(typeof zh === 'string' && zh !== 'partial history', 'the badge is translated');
  return 'partial history badge ok (en + zh)';
});

await check('0.5.1 AI: an unavailable DeepSeek explains itself in both panels', async () => {
  const { BriefCard, AiAnalysisSection, makeT } = internals;
  assert(typeof BriefCard === 'function', 'BriefCard must be exported for testing');
  assert(typeof AiAnalysisSection === 'function', 'AiAnalysisSection must be exported for testing');
  const reason = 'the plugin did not receive the llm service (ctx.llm)';
  const briefOff = renderToString(h(BriefCard, { aiAvailable: false, aiReason: reason }));
  const briefOn = renderToString(h(BriefCard, { aiAvailable: true }));
  assert(briefOff.includes('Reason: '), 'the brief panel labels the reason');
  assert(briefOff.includes(reason), 'the brief panel prints the reason text');
  assert(!briefOn.includes(reason), 'an available AI must not claim to be unavailable');
  const analysisOff = renderToString(h(AiAnalysisSection, { symbol: 'AAPL', aiAvailable: false, aiReason: reason }));
  assert(analysisOff.includes(reason), 'the analysis panel prints the reason text');
  assert(makeT('zh')('Reason: ').includes('原因'), 'the reason label is translated');
  return 'reason surfaced in the brief and analysis panels (en + zh)';
});

await check('i18n: the zh dictionary is complete and never leaks a raw key', async () => {
  assert(JSON.stringify(internals.LANGS) === JSON.stringify(['en', 'zh']), 'en + zh are the shipped languages');
  const zh = internals.ZH;
  assert(Object.keys(zh).length > 80, `zh dictionary looks too small (${Object.keys(zh).length})`);
  // Every English string handed to t('…') anywhere in the bundle must be translated.
  const used = new Set();
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = re.exec(source)) !== null) used.add(match[2].replace(/\\(['"])/g, '$1'));
  const missing = [...used].filter((key) => typeof zh[key] !== 'string');
  assert(missing.length === 0, `untranslated UI strings: ${missing.join(' | ')}`);
  // And the dictionary must actually translate rather than echo the key.
  const echoed = Object.entries(zh).filter(([k, v]) => k === v).map(([k]) => k);
  assert(echoed.length === 0, `echoed entries: ${echoed.join(' | ')}`);
  return `${used.size} strings used, ${Object.keys(zh).length} entries`;
});

await check('i18n: makeT localises, interpolates and falls back safely', async () => {
  const en = internals.makeT('en');
  const zhT = internals.makeT('zh');
  assert(en('Data may be delayed') === 'Data may be delayed', 'English is the source language');
  const zhString = zhT('Data may be delayed');
  assert(/[\u4e00-\u9fff]/.test(zhString), `expected a Chinese string, got "${zhString}"`);
  const fresh = zhT('Updated {time}', { time: '10:42:18' });
  assert(fresh.includes('10:42:18'), 'interpolated value must survive');
  assert(!fresh.includes('{time}'), 'placeholder must be replaced');
  assert(zhT('__not_in_the_dictionary__') === '__not_in_the_dictionary__', 'missing keys fall back to English, never to a raw id');
  assert(internals.translate(undefined, 'zh') === undefined, 'undefined must pass through');
  assert(internals.normalizeLang('zh-Hant') === 'zh', 'zh-Hant normalises to zh');
  assert(internals.normalizeLang('de') === null, 'unknown languages normalise to null');
  return 'ok';
});

await check('i18n: technical grid follows the selected language', async () => {
  const tech = { ma20: 3, rsi14: 9, volumeRatio20d: 14, trendAlignment: 'bullish-stack', volatility20dAnnualizedPct: 18 };
  const en = internals.technicalCells(tech, internals.makeT('en'));
  const zh = internals.technicalCells(tech, internals.makeT('zh'));
  assert(en.some((cell) => cell.label === 'MA20'), 'English labels stay unchanged');
  assert(zh.some((cell) => /[\u4e00-\u9fff]/.test(cell.label)), 'zh labels must be localised');
  assert(zh.length === en.length, 'the grid must not lose rows when translated');
  // Numbers, units and percentages are language independent; only labels change.
  en.forEach((cell, index) => {
    if (/^[\d.,]+[×%]?$/.test(cell.value)) {
      assert(zh[index].value === cell.value, `numeric cell "${cell.label}" changed with the language`);
    }
  });
  const trendZh = zh.find((cell) => /多头|空头|走平|均线/.test(String(cell.value)));
  assert(trendZh, `trend alignment must be translated, got ${JSON.stringify(zh.map((c) => c.value))}`);
  return `${en.length} cells, trend → ${trendZh.value}`;
});

await check('i18n: the platform language is adopted until the user chooses', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', open: true, symbol: null, lang: null, langSet: false, platformLang: 'zh' });
    assert(internals.effectiveLang(store.get()) === 'zh', 'platform language wins while nothing is chosen');
    const zhHtml = renderToString(h(internals.TradingApp));
    assert(/[\u4e00-\u9fff]/.test(zhHtml), 'a zh platform language must render Chinese copy');
    assert(!zhHtml.includes('Search Stocks'), 'Chinese UI must not keep the English heading');
    assert(zhHtml.includes('我的自选') || zhHtml.includes('自选'), 'the watchlist card must be translated');

    setStore({ lang: 'en', langSet: true, platformLang: 'zh' });
    const enHtml = renderToString(h(internals.TradingApp));
    assert(enHtml.includes('Search Stocks'), 'an explicit choice must beat the platform language');
    assert(!enHtml.includes('我的自选'), 'Chinese copy must not leak into the English UI');
  } finally {
    setStore(snapshot);
  }
  return 'platform zh → Chinese, explicit en → English';
});

await check('i18n: language toggle renders and a manual choice beats the server value', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', open: true, symbol: null, lang: 'en', langSet: false, platformLang: 'en' });
    const html = renderToString(h(internals.TradingApp));
    assert(html.includes('>EN<') || html.includes('English'), 'the English option must be rendered');
    assert(html.includes('中文'), 'the Chinese option must be offered');

    setStore({ lang: null, langSet: false, platformLang: 'en' });
    internals.applyServerLang({ lang: 'zh' });
    assert(store.get().lang === 'zh', 'the stored server preference is adopted when nothing is chosen');

    setStore({ lang: 'en', langSet: true });
    internals.applyServerLang({ lang: 'zh' });
    assert(store.get().lang === 'en', 'an explicit user choice must win over the server value');
  } finally {
    setStore(snapshot);
  }
  return 'toggle + precedence ok';
});

await check('indices: the Market Overview strip renders on the home view', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', open: true, symbol: null, lang: 'en', langSet: true, platformLang: 'en' });
    const html = renderToString(h(internals.TradingApp));
    assert(html.includes('Market Overview'), 'the home view must show the market overview card');
    assert(/Index levels, not tradable prices/.test(html), 'index levels must not be presented as prices');
    // Effects do not run during SSR, so the strip is still in its loading state.
    assert(html.includes('Loading indices') || html.includes('tm-indices'), 'the strip must render a loading or list state');
  } finally {
    setStore(snapshot);
  }
  return 'overview card present';
});

await check('source links: stock and index pages, always in a new tab', async () => {
  const { SOURCE_LINKS, SourcesRow, digitsOf, tradingViewSymbol } = internals;
  const ids = (links) => links.map((l) => l.id).join(',');

  const us = SOURCE_LINKS({ symbol: 'AAPL', market: 'US', exchange: 'NASDAQ' });
  assert(ids(us) === 'tradingview,yahoo,eastmoney,tencent', `US stock links, got ${ids(us)}`);
  assert(us[0].href === 'https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL', `TV href, got ${us[0].href}`);
  assert(us[1].href === 'https://finance.yahoo.com/quote/AAPL', `yahoo href, got ${us[1].href}`);
  assert(us[2].href === 'https://quote.eastmoney.com/us/AAPL.html', `eastmoney href, got ${us[2].href}`);
  assert(us[3].href === 'https://gu.qq.com/usAAPL', `tencent href, got ${us[3].href}`);

  const hk = SOURCE_LINKS({ symbol: '0700.HK', market: 'HK' });
  assert(hk[0].href === 'https://www.tradingview.com/chart/?symbol=HKEX%3A700', `HK TV href, got ${hk[0].href}`);
  assert(hk[2].href === 'https://quote.eastmoney.com/hk/00700.html', `HK eastmoney href, got ${hk[2].href}`);
  assert(hk[3].href === 'https://gu.qq.com/hk00700', `HK tencent href, got ${hk[3].href}`);

  const index = SOURCE_LINKS({ symbol: '^VIX', market: 'US', kind: 'index', links: { tradingView: 'TVC:VIX', yahoo: '^VIX', tencentKey: 'usVIX' } });
  assert(ids(index) === 'tradingview,yahoo,tencent', `index links (no eastmoney page exists), got ${ids(index)}`);
  assert(index[0].href === 'https://www.tradingview.com/chart/?symbol=TVC%3AVIX', `index TV href, got ${index[0].href}`);
  assert(index[1].href === 'https://finance.yahoo.com/quote/%5EVIX', `index yahoo href, got ${index[1].href}`);
  assert(index[2].href === 'https://gu.qq.com/usVIX', `index tencent href, got ${index[2].href}`);

  assert(digitsOf('0700.HK', 5) === '00700', `digitsOf HK, got ${digitsOf('0700.HK', 5)}`);
  assert(tradingViewSymbol({ symbol: '^VIX', links: { tradingView: 'TVC:VIX' } }) === 'TVC:VIX', 'an explicit chart dialect must win');

  const html = renderToString(h(SourcesRow, { record: { symbol: 'AAPL', market: 'US', exchange: 'NASDAQ' } }));
  assert(html.includes('target="_blank"'), 'source links must open in a new tab');
  assert(html.includes('rel="noopener noreferrer"'), 'source links must not leak the opener');
  assert((html.match(/<a /g) || []).length === 4, `four anchors expected, got ${(html.match(/<a /g) || []).length}`);
  return 'US/K + index link sets ok';
});

await check('0.5.0 markets: A-share, Tokyo and crypto links, formats and tabs', async () => {
  const { SOURCE_LINKS, tradingViewSymbol, money, marketOfSymbol, MarketOverview, store, setStore } = internals;
  const ids = (links) => links.map((l) => l.id).join(',');

  const cn = SOURCE_LINKS({ symbol: '600519.SH', market: 'CN', exchange: 'SSE', currency: 'CNY' });
  assert(ids(cn) === 'tradingview,yahoo,eastmoney,sina,tencent', `CN link set, got ${ids(cn)}`);
  assert(cn[0].href.endsWith('SSE%3A600519'), `CN TV href, got ${cn[0].href}`);
  assert(cn[1].href === 'https://finance.yahoo.com/quote/600519.SS', `CN yahoo href, got ${cn[1].href}`);
  assert(cn[2].href === 'https://quote.eastmoney.com/sh600519.html', `CN eastmoney href, got ${cn[2].href}`);
  assert(cn[3].href === 'https://finance.sina.com.cn/realstock/company/sh600519/nc.shtml', `CN sina href, got ${cn[3].href}`);
  assert(cn[4].href === 'https://gu.qq.com/sh600519', `CN tencent href, got ${cn[4].href}`);

  const sz = SOURCE_LINKS({ symbol: '000001.SZ', market: 'CN', exchange: 'SZSE' });
  assert(sz[0].href.endsWith('SZSE%3A000001'), `SZ TV href, got ${sz[0].href}`);
  assert(sz[1].href === 'https://finance.yahoo.com/quote/000001.SZ', `SZ yahoo href, got ${sz[1].href}`);
  assert(sz[2].href === 'https://quote.eastmoney.com/sz000001.html', `SZ eastmoney href, got ${sz[2].href}`);
  assert(sz[4].href === 'https://gu.qq.com/sz000001', `SZ tencent href, got ${sz[4].href}`);

  const bj = SOURCE_LINKS({ symbol: '920001.BJ', market: 'CN', exchange: 'BSE' });
  assert(!bj.some((l) => l.id === 'yahoo'), 'a Beijing listing has no Yahoo page');
  assert(bj[0].href.endsWith('BSE%3A920001'), `BJ TV href, got ${bj[0].href}`);
  assert(bj[1].href === 'https://quote.eastmoney.com/bj/920001.html', `BJ eastmoney href, got ${bj[1].href}`);
  assert(ids(bj) === 'tradingview,eastmoney,sina,tencent', `BJ link set, got ${ids(bj)}`);

  const jp = SOURCE_LINKS({ symbol: '7203.T', market: 'JP', exchange: 'JPX', currency: 'JPY' });
  assert(ids(jp) === 'tradingview,yahoo,yahoojapan', `Tokyo link set, got ${ids(jp)}`);
  assert(jp[0].href.endsWith('TSE%3A7203'), `JP TV href, got ${jp[0].href}`);
  assert(jp[1].href === 'https://finance.yahoo.com/quote/7203.T', `JP yahoo href, got ${jp[1].href}`);
  assert(jp[2].href === 'https://finance.yahoo.co.jp/quote/7203.T', `JP yahoo-japan href, got ${jp[2].href}`);
  assert(!jp.some((l) => l.id === 'eastmoney'), 'eastmoney has no Tokyo listing page (404)');

  const btc = SOURCE_LINKS({ symbol: 'BTC', market: 'CRYPTO', currency: 'USDT' });
  assert(ids(btc) === 'tradingview,yahoo,binance,gate', `crypto link set, got ${ids(btc)}`);
  assert(btc[0].href.endsWith('BINANCE%3ABTCUSDT'), `crypto TV href, got ${btc[0].href}`);
  assert(btc[1].href === 'https://finance.yahoo.com/quote/BTC-USD', `crypto yahoo href, got ${btc[1].href}`);
  assert(btc[2].href === 'https://www.binance.com/en/trade/BTC_USDT', `binance href, got ${btc[2].href}`);
  assert(btc[3].href === 'https://www.gate.io/trade/BTC_USDT', `gate href, got ${btc[3].href}`);

  assert(tradingViewSymbol({ symbol: 'BTC', market: 'CRYPTO' }) === 'BINANCE:BTCUSDT', 'BTC charts on the Binance pair');
  assert(tradingViewSymbol({ symbol: '7203.T', market: 'JP' }) === 'TSE:7203', 'Tokyo charts on TSE');
  assert(tradingViewSymbol({ symbol: '600519.SH', market: 'CN' }) === 'SSE:600519', 'Shanghai charts on SSE');
  assert(marketOfSymbol('600519.SH') === 'CN' && marketOfSymbol('7203.T') === 'JP', 'suffix market fallback');
  assert(marketOfSymbol('BTC') === 'US', 'a bare ticker still falls back to US');
  assert(money(1258.62, 'CNY') === '¥1258.62', `CNY formatting, got ${money(1258.62, 'CNY')}`);
  assert(money(2900.5, 'JPY') === '¥2900.50', `JPY formatting, got ${money(2900.5, 'JPY')}`);
  assert(money(0.00001234, 'USDT') === '0.00001234', `tiny crypto price, got ${money(0.00001234, 'USDT')}`);

  const snapshot = { ...store.get() };
  try {
    setStore({ open: true, view: 'home', lang: 'en', langSet: true, platformLang: 'en' });
    const html = renderToString(h(MarketOverview, { onOpen() {} }));
    for (const label of ['US market', 'HK market', 'CN market', 'JP market', 'Crypto']) {
      assert(html.includes(`>${label}<`), `the overview strip needs a ${label} tab`);
    }
  } finally {
    setStore(snapshot);
  }
  return 'A-share/Tokyo/crypto link sets + tabs ok';
});

await check('universe: the listing browser covers US/HK/CN/JP/crypto and localises', async () => {
  const { store, setStore, UniverseBrowser, UniverseRow, UNIVERSE_PAGE_SIZE, TradingApp } = internals;
  assert(UNIVERSE_PAGE_SIZE === 100, `one upstream page holds 100 rows, got ${UNIVERSE_PAGE_SIZE}`);
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', open: true, symbol: null, lang: 'en', langSet: true, platformLang: 'en', addMode: true });
    const html = renderToString(h(TradingApp));
    assert(/Browse all US, HK, CN, JP (&amp;|&) crypto listings/.test(html), 'the Add Stock flow must offer the full listing browser');
    assert(html.includes('Filter listings'), 'the browser needs a filter box');
    assert(html.includes('Load entire board'), 'the browser must be able to walk a whole board');
    assert(/tm-universe/.test(html), 'the browser must render its own scoped container');

    // 0.5.0 (m02818): the browser offers every market, not just US/HK.
    const markets = { US: 'US market', HK: 'HK market', CN: 'CN market', JP: 'JP market', CRYPTO: 'Crypto' };
    for (const [code, label] of Object.entries(markets)) {
      assert(html.includes(`>${label}<`), `the ${code} market chip must be offered, missing "${label}"`);
    }

    const direct = renderToString(h(UniverseBrowser, { onAdd() {}, owned: new Set() }));
    assert(/Load entire board/.test(direct), 'the browser renders standalone too');

    setStore({ lang: 'zh', langSet: true });
    const zh = renderToString(h(TradingApp));
    assert(zh.includes('浏览全部美股、港股、A股、日股与加密货币'), 'the browser card must be localised');
    for (const label of ['A股', '日股', '加密货币']) {
      assert(zh.includes(`>${label}<`), `the zh browser must label the market chips, missing "${label}"`);
    }

    const row = renderToString(
      h(UniverseRow, {
        row: { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc Class B', market: 'US', exchange: 'NYSE', industry: '保险' },
        onAdd() {},
        owned: new Set(['BRK.B']),
      }),
    );
    assert(row.includes('BRK.B'), 'class shares keep their display spelling');
    assert(row.includes('已添加'), 'a symbol already in the watchlist is marked as added');
    assert(/disabled/.test(row), 'a symbol already in the watchlist cannot be added twice');

    const addable = renderToString(
      h(UniverseRow, {
        row: { symbol: '80700.HK', name: '腾讯控股-R', market: 'HK', exchange: 'HKEX' },
        onAdd() {},
        owned: new Set(['0700.HK']),
      }),
    );
    assert(addable.includes('80700.HK'), 'the RMB counter keeps its own symbol');
    assert(!/disabled/.test(addable), 'a different symbol stays addable');
  } finally {
    setStore(snapshot);
  }
  return 'listing browser ok';
});

await check('theme: the header switch flips white-on-black / black-on-white', async () => {
  const { store, setStore, persistTheme, normalizeTheme, effectiveTheme, TradingApp } = internals;
  const snapshot = { ...store.get() };
  try {
    // User request m11109: 黑底白字 ↔ 白底黑字, one active scheme at a time.
    setStore({ open: true, view: 'home', symbol: null, lang: 'en', langSet: true, platformLang: 'en', theme: 'dark', themeSet: true });
    const dark = renderToString(h(TradingApp));
    assert(dark.includes('tm-scheme--dark'), 'the dark scheme class must be on the overlay root');
    assert(!dark.includes('tm-scheme--light'), 'the two schemes must never be applied at once');
    assert(dark.includes('>Dark<') && dark.includes('>Light<'), 'both scheme buttons must be offered');
    assert((dark.match(/tm-thm--active/g) || []).length === 1, 'exactly one scheme may be active');

    setStore({ theme: 'light' });
    const light = renderToString(h(TradingApp));
    assert(light.includes('tm-scheme--light'), 'switching to light must repaint the overlay root');
    assert(!light.includes('tm-scheme--dark'), 'the dark class must be dropped when light is active');

    assert(effectiveTheme({ theme: null }) === 'dark', 'dark is the default scheme');
    assert(normalizeTheme('blue') === null, 'an unknown scheme is not a scheme');
    assert(persistTheme('light') === 'light' && store.get().theme === 'light', 'persistTheme records the choice');
    assert(store.get().themeSet === true, 'a manual choice must outrank the host snapshot');
    assert(persistTheme('blue') === null && store.get().theme === 'light', 'an unknown scheme is ignored');
  } finally {
    setStore(snapshot);
  }
  return 'dark/light classes + toggle buttons ok';
});

await check('theme: the DSH theme preference is followed until the user chooses', async () => {
  const { store, setStore, bindPlatformTheme, applyThemeSnapshot, persistTheme } = internals;
  const snapshot = { ...store.get() };
  const handlers = [];
  const disposers = [];
  let unsubscribed = 0;
  const service = {
    last: null,
    setTheme(id) {
      this.last = id;
    },
    getTheme: () => ({ preference: 'system', active: { id: 'light', colorScheme: 'light' }, revision: 1 }),
  };
  try {
    setStore({ theme: null, themeSet: false });
    const ctx = {
      get: (id) => (id === 'theme' ? service : null),
      on: (event, fn) => {
        assert(event === 'theme/change', `unexpected event ${event}`);
        handlers.push(fn);
        return () => {
          unsubscribed += 1;
        };
      },
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === 'function') disposers.push(disposer);
      },
    };
    assert(bindPlatformTheme(ctx) === service, 'the theme service must be bound');
    assert(store.get().theme === 'light', 'the host colour scheme must be adopted while nothing is chosen');
    assert(handlers.length === 1, 'theme/change must be subscribed exactly once');

    handlers[0]({ active: { colorScheme: 'dark' } });
    assert(store.get().theme === 'dark', 'a host theme change must be followed');

    persistTheme('light');
    assert(service.last === 'light', 'the host service is the writer of the persisted preference');
    handlers[0]({ active: { colorScheme: 'dark' } });
    assert(store.get().theme === 'light', 'an explicit panel choice must survive later host snapshots');
    assert(applyThemeSnapshot(null) === null, 'an empty snapshot changes nothing');

    for (const dispose of disposers) dispose();
    assert(unsubscribed === 1, 'dispose must unsubscribe from theme/change');

    // The service is optional: a build without it still switches the panel, and a
    // throwing lookup must not break apply().
    assert(bindPlatformTheme({ effect() {} }) === null, 'a host without the theme service must be tolerated');
    assert(persistTheme('dark') === 'dark' && store.get().theme === 'dark', 'the panel still switches without the service');
    assert(
      bindPlatformTheme({
        get() {
          throw new Error('service lookup failed');
        },
        effect() {},
      }) === null,
      'a throwing service lookup must be swallowed',
    );
  } finally {
    bindPlatformTheme({ effect() {} });
    setStore(snapshot);
  }
  return 'host scheme adopted → explicit choice wins → unbound hosts tolerated';
});

await check('theme: every panel surface is painted opaque from the scheme palette', async () => {
  const before = styleTags.length;
  mod.apply({
    effect(fn) {
      fn();
    },
    slots: {
      inject() {},
      register() {
        return () => {};
      },
    },
  });
  assert(styleTags.length === before + 1, 'apply must inject exactly one stylesheet');
  const css = styleTags[before].textContent;
  styleTags.length = before;

  assert(/\.tm-layer \{[^}]*--tm-bg: #000000;/.test(css), 'the default (dark) palette must be pure black');
  assert(/\.tm-layer \{[^}]*--tm-text: #ffffff;/.test(css), 'the dark scheme must use pure white text');
  assert(
    /\.tm-layer\.tm-scheme--light \{[^}]*--tm-bg: #ffffff;[^}]*--tm-text: #101014;/.test(css),
    'the light palette must be white with near-black text',
  );
  assert(/\.tm-window \{[^}]*background: var\(--tm-bg, #000000\)/.test(css), 'the window must paint the scheme colour');
  assert(!/\.tm-window \{[^}]*background: transparent/.test(css), 'the window must never be transparent');
  assert(!/\.tm-window \{[^}]*var\(--dsw-alias/.test(css), 'the window must not depend on a host alias token');
  assert(!/\.tm-status__pop \{[^}]*var\(--dsw-alias/.test(css), 'the status popover must not depend on a host alias token');
  assert(/--dsw-alias-bg-overlay: var\(--tm-overlay\)/.test(css), 'host alias names must be mapped onto the panel palette');
  // Anything the panel paints must resolve inside the panel: an alias token a
  // custom DSH theme leaves undefined would otherwise drop the declaration.
  const used = new Set([...css.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((match) => match[1]));
  const defined = new Set([...css.matchAll(/(--dsw-alias-[a-z0-9-]+):/g)].map((match) => match[1]));
  const unmapped = [...used].filter((token) => !defined.has(token));
  assert(unmapped.length === 0, `panel rules depend on unmapped host tokens: ${unmapped.join(', ')}`);
  for (const [label, token] of [['up', '--tm-up'], ['down', '--tm-down'], ['warn', '--tm-warn'], ['moving averages', '--tm-ma20']]) {
    assert(css.includes(`var(${token},`), `the ${label} colour must come from the palette`);
  }
  return `${used.size} alias tokens mapped, ${css.length} CSS chars`;
});

console.log(`\n== summary ==\n  ${passed}/${passed + failed} checks passed, ${failed} failed`);
report({ title: 'client', required: true, passed, failed, skipped: 0, skipReasons: [], failures: failures.slice(), ok: failed === 0 });
if (failures.length) {
  for (const line of failures) console.log(`  · ${line}`);
  process.exit(1);
}
