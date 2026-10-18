/**
 * Host-side HTTP helper with the resilience primitives the spec requires
 * (§13 rate limiting, §43 timeout / retry / provider health, §74 logging).
 *
 * Transport is `node:http(s)` with its own address-family policy instead of the
 * global `fetch`. Reason (measured on 2026-10-07, Node 24): the market-data hosts
 * publish both A and AAAA records and *either* family can be broken on the way
 * out while the other answers in tens of milliseconds. Sometimes the IPv6 path
 * accepted the TCP connection and then reset it, so every `fetch()` there failed
 * with `TypeError: fetch failed | cause=UND_ERR_SOCKET`; a few hours later the
 * IPv4 address of `push2.eastmoney.com` did exactly that (10/10 attempts, ~60 ms
 * each) while its IPv6 address returned 200 in 43 ms.
 *
 * Happy Eyeballs cannot save us in either direction: the broken family *accepts*
 * the connection, so no connect error is reported and no fallback is attempted.
 * So this module (a) remembers the family that last produced a response for a
 * host and offers it first, and (b) pins one family per retry attempt, flipping
 * between attempts — a broken family then costs one fast failed attempt instead
 * of breaking the plugin. A plugin must not call `dns.setDefaultResultOrder()`
 * and reconfigure its whole host process, so the policy stays in here.
 *
 * That workaround must not be the *default* for everyone (0.6.0, publication
 * task B2), so the transport is mode-driven: `standard` is plain `node:http(s)`
 * with the runtime's own DNS behaviour, `compatibility` is the policy described
 * above, and `auto` — the default — starts standard and escalates a host to
 * compatibility only after that host fails at the transport level. The mode is
 * `networkMode()` from `config.js` (plugin config `networkMode`), and what the
 * transport is doing is reported by `transportState()`.
 *
 * Never used from the browser: the client only ever talks to this host's API.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

import { HTTP_POLICY, networkMode } from './config.js';
import { CODES, TradingError, looksBlocked } from './errors.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Token bucket, one instance per provider. */
export class RateLimiter {
  constructor(perMinute = HTTP_POLICY.rateLimitPerMinute) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
    this.last = Date.now();
    this.waiters = [];
  }
  /** Resolves when a token is available. */
  acquire() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    return sleep(waitMs).then(() => this.acquire());
  }
}

/**
 * Health key for one provider *capability* (0.6.0, publication task B4).
 *
 * 0.5.x keyed health by provider id, so one flaky endpoint — in practice the
 * candle endpoint of a provider whose search works fine — took the whole
 * provider out for its cooldown. Recording per feature keeps the failure where
 * it happened: `eastmoney::candles` can be cooling down while `eastmoney::search`
 * keeps answering.
 */
export function healthScope(provider, feature) {
  return feature ? `${provider}::${feature}` : String(provider);
}

/** Consecutive-failure tracker that trips a cooldown, per provider capability. */
export class ProviderHealth {
  constructor({ failureThreshold = HTTP_POLICY.failureThreshold, cooldownMs = HTTP_POLICY.healthCooldownMs } = {}) {
    this.threshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = new Map();
  }
  record(id, ok, detail = {}) {
    const s = this.state.get(id) || { failures: 0, successes: 0, openUntil: 0, lastError: null, lastOkAt: 0, lastFailAt: 0, calls: 0 };
    s.calls += 1;
    if (ok) {
      s.failures = 0;
      s.successes += 1;
      s.openUntil = 0;
      s.lastOkAt = Date.now();
      s.lastError = null;
    } else {
      s.failures += 1;
      s.lastFailAt = Date.now();
      if (detail.message) s.lastError = String(detail.message).slice(0, 240);
      if (s.failures >= this.threshold) s.openUntil = Date.now() + this.cooldownMs;
    }
    this.state.set(id, s);
    return s;
  }
  isOpen(id) {
    const s = this.state.get(id);
    return !!s && s.openUntil > Date.now();
  }
  snapshot() {
    const out = {};
    for (const [id, s] of this.state) {
      const healthy = !this.isOpen(id);
      out[id] = {
        provider: id,
        healthy,
        calls: s.calls,
        successes: s.successes,
        failures: s.failures,
        consecutiveFailures: s.failures,
        lastOkAt: s.lastOkAt || null,
        lastFailAt: s.lastFailAt || null,
        lastError: s.lastError,
        cooldownRemainingMs: Math.max(0, s.openUntil - Date.now()),
      };
    }
    return out;
  }
  reset() {
    this.state.clear();
  }

  /** True when every capability of this provider is inside its cooldown. */
  providerDown(id) {
    const scopes = this.scopesFor(id);
    if (!scopes.length) return false;
    return scopes.every(([, s]) => s.openUntil > Date.now());
  }

  /** Scoped entries belonging to one provider id. */
  scopesFor(id) {
    const prefix = `${id}::`;
    const out = [];
    for (const [scope, s] of this.state) {
      if (scope === id || scope.startsWith(prefix)) out.push([scope, s]);
    }
    return out;
  }

  /**
   * Roll scoped entries up to one row per provider, keeping the per-capability
   * detail in `scopes`. Used by the status endpoint and the UI.
   */
  providers() {
    const rows = new Map();
    for (const [scope, s] of this.state) {
      const [id, feature = 'default'] = scope.split('::');
      const open = s.openUntil > Date.now();
      const row =
        rows.get(id) ||
        {
          provider: id,
          healthy: true,
          degraded: false,
          calls: 0,
          successes: 0,
          failures: 0,
          consecutiveFailures: 0,
          lastOkAt: null,
          lastFailAt: null,
          lastError: null,
          cooldownRemainingMs: 0,
          scopes: {},
        };
      row.calls += s.calls || 0;
      row.successes += s.successes || 0;
      row.failures += s.failures || 0;
      row.consecutiveFailures = Math.max(row.consecutiveFailures, s.failures || 0);
      if (s.lastOkAt && (!row.lastOkAt || s.lastOkAt > row.lastOkAt)) row.lastOkAt = s.lastOkAt;
      if (s.lastFailAt && (!row.lastFailAt || s.lastFailAt >= row.lastFailAt)) {
        row.lastFailAt = s.lastFailAt;
        if (s.lastError) row.lastError = s.lastError;
      }
      if (open) {
        row.degraded = true;
        row.cooldownRemainingMs = Math.max(row.cooldownRemainingMs, Math.max(0, s.openUntil - Date.now()));
      }
      row.scopes[feature] = {
        healthy: !open,
        calls: s.calls || 0,
        successes: s.successes || 0,
        failures: s.failures || 0,
        consecutiveFailures: s.failures || 0,
        lastOkAt: s.lastOkAt || null,
        lastFailAt: s.lastFailAt || null,
        lastError: s.lastError || null,
        cooldownRemainingMs: Math.max(0, s.openUntil - Date.now()),
      };
      rows.set(id, row);
    }
    // A provider is only "unhealthy" when no capability is left to try.
    for (const [id, row] of rows) row.healthy = !this.providerDown(id);
    return Object.fromEntries(rows);
  }
}

/** The address family that last produced a response, per host. */
const WORKING_FAMILY = new Map();

/**
 * Hosts that failed at the transport level and therefore run the address-family
 * compatibility policy even in `auto` mode (0.6.0, publication task B2).
 */
const COMPAT_HOSTS = new Set();

/**
 * A transport-level failure: the connection was accepted and then dropped, or
 * could not be established at all. Only these make `auto` switch a host to the
 * compatibility policy — an HTTP status, a parse error or our own timeout does
 * not (a 403 or a 429 is a server verdict, and flipping address families cannot
 * change it).
 */
const TRANSPORT_FAILURE = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|other side closed/i;

export function isTransportFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  const cause = error.cause || {};
  const text = [error.code, error.message, cause.code, cause.message].filter(Boolean).join(' ');
  return TRANSPORT_FAILURE.test(text);
}

/** Which family worked last for a host (4, 6, or undefined). */
export function workingFamily(hostname) {
  return WORKING_FAMILY.get(String(hostname)) || undefined;
}

/**
 * What the transport is doing right now: the configured mode, the hosts that
 * fell back to the compatibility policy, and the families that last answered.
 * Exposed through `GET /api/trading/status` so "why is this host slow" is
 * answerable without reading the log.
 */
export function transportState() {
  return {
    mode: networkMode(),
    compatibilityHosts: [...COMPAT_HOSTS].sort(),
    workingFamilies: Object.fromEntries([...WORKING_FAMILY].map(([host, family]) => [host, family])),
  };
}

/** Forget remembered families and compatibility hosts (tests, manual reset). */
export function resetTransportState() {
  COMPAT_HOSTS.clear();
  WORKING_FAMILY.clear();
  for (const agent of AGENTS.values()) {
    if (typeof agent.destroy === 'function') agent.destroy();
  }
  AGENTS.clear();
}

/** Mark a host as needing the compatibility policy (called on transport failure). */
function noteTransportFailure(url, mode) {
  // `compatibility` is already in force; `standard` means the user forbade the
  // fallback, so recording the host would only surprise them later.
  if (mode !== 'auto') return;
  try {
    const host = new URL(url).hostname;
    COMPAT_HOSTS.add(host);
  } catch (e) {
    /* a malformed URL is reported by the caller, not here */
  }
}

/** True when this host must use the compatibility policy under `mode`. */
function needsCompatibility(url, mode) {
  if (mode === 'compatibility') return true;
  if (mode === 'standard') return false;
  try {
    return COMPAT_HOSTS.has(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

/**
 * Put `preferred` (4 or 6) first, keep the resolver's order otherwise.
 * Pure so the address policy can be asserted without a network.
 */
export function orderAddresses(addresses, preferred) {
  const list = Array.isArray(addresses) ? addresses.slice() : [];
  if (preferred !== 4 && preferred !== 6) return list;
  const first = list.filter((entry) => entry.family === preferred);
  const rest = list.filter((entry) => entry.family !== preferred);
  return first.concat(rest);
}

function asCallback(options, ordered, callback) {
  if (!ordered.length) return callback(new Error('no address found'));
  if (options && options.all) return callback(null, ordered);
  callback(null, ordered[0].address, ordered[0].family);
}

/**
 * Lookup that offers the remembered working family first and otherwise keeps the
 * system's own order — the first attempt of every request uses this one.
 */
function stickyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: (options && options.family) || 0 }];
    asCallback(options, orderAddresses(list, WORKING_FAMILY.get(hostname)), callback);
  });
}

/**
 * Lookup pinned to one address family, used by the retry attempts: if the family
 * the first attempt used is broken, the next attempt must not use it again.
 */
export function familyLookup(family) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, family, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family }];
      asCallback(options, list, callback);
    });
  };
}

const AGENTS = new Map();

/**
 * `mode` picks the transport: `standard` is a plain keep-alive agent that lets
 * the runtime resolve and order addresses itself, `compatibility` adds the
 * sticky/family-pinned lookup described in the file header.
 */
function agentFor(protocol, family, mode = 'standard') {
  const pinned = mode === 'compatibility' && (family === 4 || family === 6);
  const key = `${mode}:${protocol}:${pinned ? family : 'auto'}`;
  if (!AGENTS.has(key)) {
    const Ctor = protocol === 'https:' ? https.Agent : http.Agent;
    const options = { keepAlive: true, maxSockets: 8 };
    if (mode === 'compatibility') options.lookup = pinned ? familyLookup(family) : stickyLookup;
    AGENTS.set(key, new Ctor(options));
  }
  return AGENTS.get(key);
}

/** `fetch` auto-decompresses; `node:http` does not. Providers send gzip and br. */
function decompress(response) {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

function headerBag(headers = {}) {
  const bag = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    try {
      bag.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    } catch {
      /* a header a `Headers` facade refuses (e.g. pseudo-headers) is not our concern */
    }
  }
  return bag;
}

/**
 * One request, redirects followed, result already decoded to text.
 * Rejects with `{name:'AbortError'}` on timeout/abort so the caller maps it to
 * `UPSTREAM_TIMEOUT`, exactly like the previous `fetch`-based implementation.
 */
function requestOnce(url, { headers, timeoutMs, signal, decode, family, mode = 'standard', redirects = 5 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      const error = new Error('aborted by caller');
      error.name = 'AbortError';
      if (req) req.destroy(error);
      else fail(error);
    };

    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const Ctor = target.protocol === 'https:' ? https : http;
    try {
      req = Ctor.request(target, { method: 'GET', agent: agentFor(target.protocol, family, mode), headers }, (res) => {
        const status = res.statusCode || 0;
        // Remember which family actually answered so later requests start there.
        const remote = res.socket && res.socket.remoteFamily ? Number(String(res.socket.remoteFamily).replace('IPv', '')) : 0;
        if (remote === 4 || remote === 6) WORKING_FAMILY.set(target.hostname, remote);
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          succeed({ redirect: new URL(location, target).toString() });
          return;
        }
        const stream = decompress(res);
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', fail);
        res.on('error', fail);
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          succeed({
            status,
            headers: headerBag(res.headers),
            address: (res.socket && res.socket.remoteAddress) || null,
            body: decode ? new TextDecoder(decode === true ? 'gbk' : decode).decode(buffer) : buffer.toString('utf8'),
          });
        });
      });
    } catch (e) {
      reject(e);
      return;
    }
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      error.name = 'AbortError';
      req.destroy(error);
    }, timeoutMs);
    req.on('error', fail);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  }).then((result) => {
    if (result && result.redirect) {
      return requestOnce(result.redirect, { headers, timeoutMs, signal, decode, family, mode, redirects: redirects - 1 });
    }
    return result;
  });
}

/**
 * @param {string} url
 * @param {{
 *   headers?: Record<string,string>,
 *   timeoutMs?: number,
 *   retries?: number,
 *   provider?: string,
 *   limiter?: RateLimiter,
 *   accept?: 'json'|'text',
 *   signal?: AbortSignal,
 *   allowErrorStatus?: boolean,
 *   decode?: 'utf-8'|'gbk'|false,
 *   preferredFamily?: 4|6,
 * }} [opts]
 * @returns {Promise<{status:number, body:string, json:any, headers:Headers}>}
 */
export async function httpGet(url, opts = {}) {
  const {
    headers = {},
    timeoutMs = HTTP_POLICY.timeoutMs,
    retries = HTTP_POLICY.retries,
    provider = 'unknown',
    limiter,
    accept = 'json',
    signal,
    allowErrorStatus = false,
    decode = false,
    preferredFamily = null,
  } = opts;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (limiter) await limiter.acquire();
    // Transport (0.6.0): `standard` uses the runtime's own address handling,
    // `compatibility` remembers/pins a family, and `auto` switches a host to the
    // compatibility policy as soon as it fails at the transport level. In
    // compatibility mode attempt 0 uses the remembered/system order and every
    // retry pins one family and flips, so a family that accepts the connection
    // and then resets it cannot keep the plugin offline.
    const mode = needsCompatibility(url, networkMode()) ? 'compatibility' : 'standard';
    const family =
      mode === 'compatibility'
        ? attempt === 0
          ? preferredFamily === 4 || preferredFamily === 6
            ? preferredFamily
            : null
          : attempt % 2 === 1
            ? 4
            : 6
        : null;
    try {
      const res = await requestOnce(url, {
        timeoutMs,
        signal,
        decode,
        family,
        mode,
        headers: {
          'User-Agent': HTTP_POLICY.userAgent,
          Accept: accept === 'json' ? 'application/json,text/plain,*/*' : 'text/plain,text/csv,*/*',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          ...headers,
        },
      });
      const body = res.body;
      const ok = res.status >= 200 && res.status < 300;
      if (!ok && allowErrorStatus) return { status: res.status, body, json: null, headers: res.headers };
      if (!ok) {
        const err = new TradingError(
          looksBlocked(res.status, body) ? CODES.UPSTREAM_BLOCKED : CODES.UPSTREAM_ERROR,
          `${provider} responded ${res.status}`,
          { status: res.status, provider, retryable: res.status >= 500 || res.status === 429 },
        );
        // 4xx other than 429 is not worth retrying; 403 means "stop hammering".
        if (res.status < 500 && res.status !== 429) throw Object.assign(err, { noRetry: true });
        lastErr = err;
      } else {
        let json = null;
        if (accept === 'json') {
          try {
            json = body ? JSON.parse(body) : null;
          } catch (e) {
            throw new TradingError(CODES.PARSE_ERROR, `${provider} returned non-JSON payload`, { provider, cause: e, noRetry: true });
          }
        }
        return { status: res.status, body, json, headers: res.headers };
      }
    } catch (e) {
      if (e instanceof TradingError && e.noRetry) throw e;
      // Only a transport-level failure justifies the compatibility policy for
      // this host; a status code or a parse error never does.
      if (isTransportFailure(e)) noteTransportFailure(url, networkMode());
      if (e && e.name === 'AbortError') {
        lastErr = new TradingError(CODES.UPSTREAM_TIMEOUT, `${provider} timed out after ${timeoutMs}ms`, {
          provider,
          retryable: true,
          cause: e,
        });
      } else if (e instanceof TradingError) {
        lastErr = e;
      } else {
        const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : '';
        lastErr = new TradingError(CODES.UPSTREAM_ERROR, `${provider} request failed: ${e && e.message}${cause}`, {
          provider,
          retryable: true,
          cause: e,
        });
      }
    }
    if (attempt < retries) {
      const delay = Math.min(HTTP_POLICY.retryMaxDelayMs, HTTP_POLICY.retryBaseDelayMs * 2 ** attempt);
      await sleep(delay + Math.random() * 120);
    }
  }
  throw lastErr || new TradingError(CODES.UPSTREAM_ERROR, `${provider} request failed`, { provider });
}

/** Coerce anything into a finite number, or null. */
export function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && v !== '-' && v !== 'null' && v !== 'N/A') {
    const n = Number(v.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Round to a sensible price precision (2 for prices >= 1, more below). */
export function pricePrecision(v) {
  if (!Number.isFinite(v)) return 2;
  const abs = Math.abs(v);
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function roundPrice(v, digits) {
  if (!Number.isFinite(v)) return null;
  const d = Number.isFinite(digits) ? digits : pricePrecision(v);
  return Number(v.toFixed(d));
}
