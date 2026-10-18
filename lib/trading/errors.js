/**
 * Error taxonomy for the trading mode (spec §43/§74: no silent failure).
 * Every failure surfaced to the client carries a stable machine code plus a
 * short human message and, when relevant, the upstream HTTP status.
 */

export class TradingError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number, provider?: string, symbol?: string, cause?: unknown, retryable?: boolean, retryAfterMs?: number}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
    this.status = meta.status;
    this.provider = meta.provider;
    this.symbol = meta.symbol;
    this.cause = meta.cause;
    this.retryable = meta.retryable ?? false;
    this.retryAfterMs = Number.isFinite(meta.retryAfterMs) && meta.retryAfterMs > 0 ? Math.round(meta.retryAfterMs) : undefined;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.status ? { status: this.status } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.symbol ? { symbol: this.symbol } : {}),
      ...(this.retryAfterMs ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export const CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED_MARKET: 'UNSUPPORTED_MARKET',
  UNSUPPORTED_INTERVAL: 'UNSUPPORTED_INTERVAL',
  INVALID_SYMBOL: 'INVALID_SYMBOL',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_BLOCKED: 'UPSTREAM_BLOCKED',
  UPSTREAM_RATE_LIMIT: 'UPSTREAM_RATE_LIMIT',
  RATE_LIMITED: 'RATE_LIMITED',
  /** 0.8.0 (round-3 P0-b): the host security fence is unavailable, so we refuse. */
  HOST_SECURITY_UNAVAILABLE: 'HOST_SECURITY_UNAVAILABLE',
  /** 0.8.0 (round-3 P1⑦): no trustworthy per-user identity, so per-user data is refused. */
  NO_IDENTITY: 'NO_IDENTITY',
  PARSE_ERROR: 'PARSE_ERROR',
  NO_PROVIDER: 'NO_PROVIDER',
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_INVALID_OUTPUT: 'AI_INVALID_OUTPUT',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL: 'INTERNAL',
};

export const badRequest = (message) => new TradingError(CODES.BAD_REQUEST, message);
export const notFound = (message) => new TradingError(CODES.NOT_FOUND, message);
export const unavailable = (message, meta = {}) => new TradingError(CODES.DATA_UNAVAILABLE, message, meta);
export const aiUnavailable = (message, meta = {}) => new TradingError(CODES.AI_UNAVAILABLE, message, meta);

export function toTradingError(err, fallbackMessage = 'unexpected error') {
  if (err instanceof TradingError) return err;
  const message = err && typeof err.message === 'string' ? err.message : fallbackMessage;
  if (err && err.name === 'AbortError') return new TradingError(CODES.UPSTREAM_TIMEOUT, 'request timed out', { cause: err, retryable: true });
  return new TradingError(CODES.INTERNAL, message, { cause: err });
}

/** True when the message looks like a transport-level block rather than a data problem. */
export function looksBlocked(status, body) {
  if (status === 403 || status === 401 || status === 451) return true;
  if (typeof body !== 'string') return false;
  return /access denied|are you a robot|unusual traffic|captcha|sad-panda/i.test(body);
}
