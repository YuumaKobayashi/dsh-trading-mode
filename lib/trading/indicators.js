/**
 * Quant Engine (spec §29/§31/§71).
 *
 * Every technical indicator is computed here, in code. The DeepSeek layer only
 * receives these numbers and is forbidden from recalculating them.
 *
 * All functions are pure: `(candles|values, params) -> arrays|null`. Series
 * outputs are aligned 1:1 with the input so `series[i]` belongs to `candles[i]`;
 * positions with insufficient history are `null` rather than `NaN`.
 */

import { QUANT_CONFIG } from './config.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, digits = 4) => (isNum(v) ? Number(v.toFixed(digits)) : null);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/** Simple moving average series. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0)) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    sum += isNum(v) ? v : 0;
    if (i >= period) sum -= isNum(values[i - period]) ? values[i - period] : 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values (the convention used by TradingView / StockCharts).
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!(period > 0) || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI. Returns a series; the first defined value is at index `period`.
 * Guards the degenerate all-gains / all-losses cases instead of dividing by 0.
 */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD line, signal line and histogram. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) => (isNum(emaFast[i]) && isNum(emaSlow[i]) ? emaFast[i] - emaSlow[i] : null));
  const defined = line.filter(isNum);
  const signalCompact = ema(defined, signalPeriod);
  const signal = new Array(values.length).fill(null);
  let cursor = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (isNum(line[i])) {
      signal[i] = signalCompact[cursor];
      cursor += 1;
    }
  }
  const histogram = line.map((v, i) => (isNum(v) && isNum(signal[i]) ? v - signal[i] : null));
  return { macd: line, signal, histogram };
}

/** Wilder's Average True Range, in price units. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** True Range series (exposed for tests and diagnostics). */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function standardDeviation(values) {
  if (values.length < 2) return null;
  const m = avg(values);
  return Math.sqrt(avg(values.map((v) => (v - m) ** 2)));
}

/**
 * Support / resistance candidates from swing pivots (fractal highs and lows).
 * These are *candidates*: the AI layer explains them, it does not invent them.
 * @param {{high:number, low:number, close:number, timestamp:number}[]} candles
 */
export function pivots(candles, lookback = QUANT_CONFIG.pivotLookback, horizon = QUANT_CONFIG.pivotHorizon) {
  const window = candles.slice(-horizon);
  const highs = [];
  const lows = [];
  for (let i = lookback; i < window.length - lookback; i += 1) {
    const c = window[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue;
      if (window[j].high >= c.high) isHigh = false;
      if (window[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ price: c.high, timestamp: c.timestamp });
    if (isLow) lows.push({ price: c.low, timestamp: c.timestamp });
  }
  const last = window.length ? window[window.length - 1].close : null;
  /** Cluster levels that sit within 0.75% of each other and count touches. */
  const cluster = (levels) => {
    const sorted = levels.slice().sort((a, b) => a.price - b.price);
    const groups = [];
    for (const lv of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(lv.price - g.price) / g.price < 0.0075) {
        g.touches += 1;
        g.price = (g.price * (g.touches - 1) + lv.price) / g.touches;
        g.lastTimestamp = Math.max(g.lastTimestamp, lv.timestamp);
      } else {
        groups.push({ price: lv.price, touches: 1, lastTimestamp: lv.timestamp });
      }
    }
    return groups
      .map((g) => ({ price: round(g.price), touches: g.touches, lastTimestamp: g.lastTimestamp }))
      .sort((a, b) => b.touches - a.touches || b.price - a.price);
  };
  const resistance = isNum(last) ? cluster(highs.filter((h) => h.price > last)) : [];
  const support = isNum(last) ? cluster(lows.filter((l) => l.price < last)) : [];
  return { support: support.slice(0, 5), resistance: resistance.slice(0, 5) };
}

/**
 * Full technical snapshot for one symbol.
 * @param {{timestamp:number, open:number, high:number, low:number, close:number, volume:number}[]} candles
 * @param {{symbol?: string, interval?: string, range?: string}} [meta]
 */
export function computeTechnicals(candles, meta = {}) {
  const bars = Array.isArray(candles) ? candles.filter((c) => isNum(c.close)) : [];
  const closes = bars.map((c) => c.close);
  const volumes = bars.map((c) => (isNum(c.volume) ? c.volume : 0));
  const unavailable = [];
  const need = (key, count) => {
    if (bars.length < count) {
      unavailable.push(key);
      return false;
    }
    return true;
  };

  const ma = {};
  for (const p of QUANT_CONFIG.sma) {
    const series = sma(closes, p);
    ma[`ma${p}`] = need(`ma${p}`, p) ? round(series[series.length - 1]) : null;
    ma[`_ma${p}`] = series;
  }
  const emaFast = ema(closes, QUANT_CONFIG.ema[0]);
  const emaSlow = ema(closes, QUANT_CONFIG.ema[1]);
  const rsiSeries = rsi(closes, QUANT_CONFIG.rsiPeriod);
  const macdSeries = macd(closes, QUANT_CONFIG.macd.fast, QUANT_CONFIG.macd.slow, QUANT_CONFIG.macd.signal);
  const atrSeries = atr(bars, QUANT_CONFIG.atrPeriod);

  const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const volumeAvg20 = avg(volumes.slice(-QUANT_CONFIG.volumeAveragePeriod));
  const volumePrev20 = volumes.slice(-QUANT_CONFIG.volumeAveragePeriod - 1, -1);
  const volumeAvgPrev20 = avg(volumePrev20);
  const latestVolume = last(volumes);
  const volumeRatio20d =
    isNum(latestVolume) && isNum(volumeAvgPrev20) && volumeAvgPrev20 > 0 ? latestVolume / volumeAvgPrev20 : null;

  const yearBars = bars.slice(-252);
  const high52w = yearBars.length ? Math.max(...yearBars.map((c) => c.high)) : null;
  const low52w = yearBars.length ? Math.min(...yearBars.map((c) => c.low)) : null;
  const weekBars = bars.slice(-5);

  const changeOver = (n) => {
    if (bars.length <= n || !bars[bars.length - 1 - n]) return null;
    const past = bars[bars.length - 1 - n].close;
    const now = bars[bars.length - 1].close;
    return past > 0 ? ((now - past) / past) * 100 : null;
  };

  const technical = {
    ma5: need('ma5', QUANT_CONFIG.minBars.ma5) ? ma.ma5 : null,
    ma10: need('ma10', QUANT_CONFIG.minBars.ma10) ? ma.ma10 : null,
    ma20: need('ma20', QUANT_CONFIG.minBars.ma20) ? ma.ma20 : null,
    ma50: need('ma50', QUANT_CONFIG.minBars.ma50) ? ma.ma50 : null,
    ma60: need('ma60', QUANT_CONFIG.minBars.ma60) ? ma.ma60 : null,
    ma200: need('ma200', QUANT_CONFIG.minBars.ma200) ? ma.ma200 : null,
    ema12: need('ema12', QUANT_CONFIG.ema[0]) ? round(last(emaFast)) : null,
    ema26: need('ema26', QUANT_CONFIG.ema[1]) ? round(last(emaSlow)) : null,
    rsi14: bars.length >= QUANT_CONFIG.minBars.rsi14 ? round(last(rsiSeries), 2) : (unavailable.push('rsi14'), null),
    macd: bars.length >= QUANT_CONFIG.minBars.macd ? round(last(macdSeries.macd)) : (unavailable.push('macd'), null),
    macdSignal: bars.length >= QUANT_CONFIG.minBars.macd ? round(last(macdSeries.signal)) : null,
    macdHistogram: bars.length >= QUANT_CONFIG.minBars.macd ? round(last(macdSeries.histogram)) : null,
    atr14: bars.length >= QUANT_CONFIG.minBars.atr14 ? round(last(atrSeries)) : (unavailable.push('atr14'), null),
    volumeAverage20d: round(volumeAvg20, 0),
    volumeRatio20d: round(volumeRatio20d, 2),
    high52w: round(high52w),
    low52w: round(low52w),
    change5dPct: round(changeOver(5), 2),
    change1moPct: round(changeOver(21), 2),
    change3moPct: round(changeOver(63), 2),
    change1yPct: round(changeOver(252), 2),
    weeklyChangePct: weekBars.length >= 2 ? round(((weekBars[weekBars.length - 1].close - weekBars[0].open) / weekBars[0].open) * 100, 2) : null,
  };

  // Derived, code-side interpretation hints. The AI must not compute these.
  const price = bars.length ? bars[bars.length - 1].close : null;
  technical.priceVsMa20Pct = isNum(price) && isNum(technical.ma20) ? round(((price - technical.ma20) / technical.ma20) * 100, 2) : null;
  technical.priceVsMa50Pct = isNum(price) && isNum(technical.ma50) ? round(((price - technical.ma50) / technical.ma50) * 100, 2) : null;
  technical.priceVsMa200Pct = isNum(price) && isNum(technical.ma200) ? round(((price - technical.ma200) / technical.ma200) * 100, 2) : null;
  technical.distanceFrom52wHighPct =
    isNum(price) && isNum(technical.high52w) && technical.high52w > 0 ? round(((price - technical.high52w) / technical.high52w) * 100, 2) : null;
  technical.distanceFrom52wLowPct =
    isNum(price) && isNum(technical.low52w) && technical.low52w > 0 ? round(((price - technical.low52w) / technical.low52w) * 100, 2) : null;
  technical.atrPctOfPrice = isNum(technical.atr14) && isNum(price) && price > 0 ? round((technical.atr14 / price) * 100, 2) : null;
  technical.trendAlignment = maAlignment(technical);
  technical.volatility20dAnnualizedPct = annualizedVolatility(closes);

  const levels = pivots(bars);
  const lastTimestamp = bars.length ? bars[bars.length - 1].timestamp : null;
  const quality = technicalQuality(bars.length, unavailable);

  return {
    symbol: meta.symbol || null,
    interval: meta.interval || null,
    range: meta.range || null,
    asOf: lastTimestamp,
    bars: bars.length,
    /** How much history the numbers above rest on (0.7.0, spec: no silent gaps). */
    quality,
    price: round(price),
    technical,
    levels,
    unavailable: [...new Set(unavailable)],
    series: {
      timestamp: bars.map((c) => c.timestamp),
      close: closes,
      ma20: ma._ma20,
      ma50: ma._ma50,
      ma200: ma._ma200,
      rsi14: rsiSeries,
      macd: macdSeries.macd,
      macdSignal: macdSeries.signal,
      macdHistogram: macdSeries.histogram,
      volume: volumes,
    },
  };
}

/**
 * How complete a technical snapshot is (0.7.0). A market with a shallow history
 * (a newly listed stock, or a provider that only serves a short series) must not
 * present half-computed indicators as if they were full ones: the grade travels
 * with the data to the UI and to the AI prompt.
 */
export function technicalQuality(barCount, unavailable = []) {
  const bars = Number.isFinite(barCount) ? barCount : 0;
  const required = QUANT_CONFIG.minBars.ma20;
  const sufficient = bars >= required;
  const grade = bars >= QUANT_CONFIG.minBars.ma200 ? 'full' : bars >= QUANT_CONFIG.minBars.ma50 ? 'partial' : sufficient ? 'limited' : 'insufficient';
  let note;
  if (!sufficient) {
    note = `Only ${bars} history bars are available; technical indicators need at least ${required} and are not reported.`;
  } else if (grade === 'limited') {
    note = `Only ${bars} history bars are available: short-term indicators are computed, long-term ones (MA200, 52-week levels, 1-year change) are not.`;
  } else if (grade === 'partial') {
    note = `Only ${bars} history bars are available: MA200, 52-week levels and 1-year change are not reported.`;
  } else {
    note = `${bars} history bars available; every shipped indicator is computed.`;
  }
  return { bars, required, sufficient, grade, unavailable: [...new Set(unavailable)], note };
}

/** Describe MA stacking in words the AI can quote verbatim. */
export function maAlignment(technical) {
  const { ma5, ma20, ma50, ma200 } = technical;
  if (![ma20, ma50].every(isNum)) return 'insufficient-history';
  if (isNum(ma5) && isNum(ma20) && isNum(ma50) && isNum(ma200)) {
    if (ma5 > ma20 && ma20 > ma50 && ma50 > ma200) return 'bullish-stack';
    if (ma5 < ma20 && ma20 < ma50 && ma50 < ma200) return 'bearish-stack';
  }
  if (ma20 > ma50) return 'short-term-above-medium';
  if (ma20 < ma50) return 'short-term-below-medium';
  return 'flat';
}

/** Annualised close-to-close volatility over the last 20 sessions. */
export function annualizedVolatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = [];
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev > 0) rets.push((closes[i] - prev) / prev);
  }
  const sd = standardDeviation(rets);
  return isNum(sd) ? round(sd * Math.sqrt(252) * 100, 2) : null;
}

export const __internals = { avg, round, isNum };
