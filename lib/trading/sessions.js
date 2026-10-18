/**
 * Market-session helpers.
 *
 * Used for two spec requirements:
 *  - §42: short cache TTL while a market is open, long TTL while it is closed.
 *  - §34/§35: freshness grading — a quote from the previous close is NOT stale
 *    just because it is hours old, while a quote from three days ago is.
 */

import { MARKET_SESSIONS } from './config.js';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of an instant in a given IANA zone. */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY.indexOf(parts.weekday),
  };
}

/** Minutes since local midnight in the market's time zone. */
export function localMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function parseHhMm(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * @param {'US'|'HK'} market
 * @param {Date} [at]
 * @returns {{open: boolean, reason: string, session: string}}
 */
export function marketStatus(market, at = new Date()) {
  const cfg = MARKET_SESSIONS[market];
  if (!cfg) return { open: false, reason: 'unknown market', session: 'unknown' };
  const p = zonedParts(at, cfg.timeZone);
  if (!cfg.days.includes(p.weekday)) return { open: false, reason: 'weekend', session: 'closed' };
  const minutes = p.hour * 60 + p.minute;
  const open = parseHhMm(cfg.open);
  const close = parseHhMm(cfg.close);
  if (minutes < open) return { open: false, reason: 'pre-market', session: 'pre' };
  if (minutes >= close) return { open: false, reason: 'after-hours', session: 'post' };
  return { open: true, reason: 'regular session', session: 'regular' };
}

/**
 * Grade how old a quote is, in trading terms.
 * @param {number} timestamp epoch ms of the upstream print
 * @param {'US'|'HK'} market
 * @param {Date} [now]
 * @returns {{ageMs: number, stale: boolean, note: 'fresh'|'delayed'|'closed-session'|'stale'|'unknown'}}
 */
export function gradeFreshness(timestamp, market, now = new Date()) {
  if (!Number.isFinite(timestamp)) return { ageMs: NaN, stale: true, note: 'unknown' };
  const ageMs = now.getTime() - timestamp;
  const status = marketStatus(market, now);
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  // Outside the regular session the newest print is the previous close, which
  // is expected: report it as a closed-session snapshot rather than stale.
  if (!status.open) {
    const limit = status.reason === 'weekend' ? 4 * DAY : 20 * HOUR;
    return { ageMs, stale: ageMs > limit, note: ageMs > limit ? 'stale' : 'closed-session' };
  }
  // During the session a print older than 20 minutes is not current any more.
  // 0.8.0: the youngest grade is `fresh`, never `live` — the plugin has no
  // real-time authorisation and must not label a delayed feed as live.
  if (ageMs <= 5 * 60_000) return { ageMs, stale: false, note: 'fresh' };
  if (ageMs <= 20 * 60_000) return { ageMs, stale: false, note: 'delayed' };
  return { ageMs, stale: true, note: 'stale' };
}

/** True when any of the given markets is in its regular session now. */
export function anyMarketOpen(markets, at = new Date()) {
  return markets.some((m) => marketStatus(m, at).open);
}

/**
 * Convert a wall-clock string that is expressed in a market's local time into
 * epoch milliseconds. Providers (eastmoney, Tencent) hand us "local exchange
 * time" strings; guessing UTC would shift every timestamp by the zone offset.
 *
 * @param {string} text e.g. "2026-10-02 16:00:01" or "2026-10-02"
 * @param {string} timeZone IANA zone of that wall clock
 * @returns {number} epoch ms, or NaN
 */
export function zonedWallClockToEpoch(text, timeZone) {
  if (typeof text !== 'string') return NaN;
  const m = text.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return NaN;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(asUtc)) return NaN;
  // Offset of the zone at that instant, in minutes east of UTC.
  const probe = new Date(asUtc);
  const p = zonedParts(probe, timeZone);
  const asZoned = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, probe.getUTCSeconds());
  const offsetMin = Math.round((asZoned - asUtc) / 60_000);
  return asUtc - offsetMin * 60_000;
}

export function formatClock(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatDate(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}
