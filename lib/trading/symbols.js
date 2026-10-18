/**
 * Canonical symbol handling.
 *
 * Canonical form (spec §14/§18): US tickers are bare upper-case (`AAPL`,
 * `BRK.B`); HK tickers are zero-padded to four digits with the `.HK` suffix
 * (`0700.HK`, `9988.HK`); mainland China codes carry their exchange suffix
 * (`600519.SH`, `000001.SZ`, `920001.BJ`); Tokyo codes carry `.T` (`7203.T`);
 * crypto pairs are the bare base asset, always quoted in USDT (`BTC`, `ETH`).
 * This is the form the API and UI exchange.
 *
 * Each provider needs its own dialect; translating canonical → provider keys
 * lives here so no provider leaks its format upward (spec §16).
 */

import { CRYPTO_QUOTE, MARKETS, PROVIDER_CONFIG } from './config.js';
import { CODES, TradingError } from './errors.js';
import { lookupIndex } from './indices.js';

const US_TICKER = /^[A-Z][A-Z0-9._\-]{0,9}$/;
const HK_DIGITS = /^0*(\d{1,5})$/;
/** Mainland codes are six digits; Tokyo codes are four. */
const CN_CODE = /^\d{6}$/;
const JP_CODE = /^\d{4}$/;
/** Crypto bases are short alphanumerics (`BTC`, `PEPE`, `1INCH`). */
const CRYPTO_BASE = /^[A-Z0-9]{2,15}$/;
/**
 * Quote assets a crypto pair may be written against. Longest first so the
 * back-tracking in `cryptoPairOf` lands on `USDT` rather than `USD`.
 */
const CRYPTO_QUOTES = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'USD', 'BTC', 'ETH'];

/** Eastmoney spells class shares / units with `_` (`BRK_B`, `AAC_U`); we show `BRK.B`. */
export function usDisplayCode(code) {
  return String(code || '').trim().toUpperCase().replace(/_/g, '.');
}

/** The inverse: `BRK.B` / `BRK-B` → the spelling eastmoney's `secid` expects. */
export function usProviderCode(code) {
  return usDisplayCode(code).replace(/[.\-]/g, '_');
}

/**
 * Eastmoney lists HK codes as zero-padded five-digit strings (`00001`, `08003`,
 * `80700`). The canonical four-digit form drops the leading zeros (`0001.HK`),
 * but the five-digit RMB counter series (`80700` = 0700's off-shore counter)
 * must keep every digit or it would collide with the HKD counter of the same
 * company.
 */
export function hkTickerFromCode(code) {
  const digits = String(Number(String(code || '').replace(/^0*/, '') || '0'));
  return digits.length > 4 ? digits : digits.padStart(4, '0');
}

export function isMarket(value) {
  return MARKETS.includes(value);
}

/**
 * Which mainland exchange owns a six-digit code. The prefix ranges are the ones
 * the upstream feeds use: `6xx`/`9xx` Shanghai (including `688` STAR), `0xx`/
 * `2xx`/`3xx` Shenzhen (including `300`/`301` ChiNext), and `920`/`43`/`83`/
 * `87`/`88` Beijing.
 */
export function cnBoardOf(code) {
  const c = String(code || '').padStart(6, '0');
  if (!CN_CODE.test(c)) return null;
  if (/^(920|43|83|87|88)/.test(c)) return 'BJ';
  if (/^[569]/.test(c)) return 'SH';
  if (/^[0123]/.test(c)) return 'SZ';
  return null;
}

/** `BTCUSDT` / `BTC-USDT` / `BTC/USDT` → `{base, quote}`; a bare base returns `null`. */
export function cryptoPairOf(raw) {
  const value = String(raw || '').toUpperCase().replace(/[\s_]/g, '');
  if (!value) return null;
  for (const quote of CRYPTO_QUOTES) {
    if (value.length > quote.length && value.endsWith(quote)) {
      const base = value.slice(0, value.length - quote.length);
      if (CRYPTO_BASE.test(base)) return { base, quote };
    }
  }
  if (/-|\//.test(raw)) {
    const [base, quote] = String(raw).toUpperCase().split(/[-/]/);
    if (CRYPTO_BASE.test(base) && quote && CRYPTO_QUOTES.includes(quote)) return { base, quote };
  }
  return null;
}

/**
 * Parse any user/provider-supplied identifier into the canonical symbol.
 * Accepts `aapl`, `AAPL`, `105.AAPL`, `00700`, `700.hk`, `0700.HK`, `HK:0700`,
 * `600519`, `600519.SH`, `CN:000001`, `7203.T`, `JP:7203`, `BTC`, `BTCUSDT`,
 * `BTC-USDT`, and the market indices (`^VIX`, `VIX`, `恐慌指数`, `usVIX`,
 * `100.NDX`, `N225`).
 *
 * A bare crypto base (e.g. `BTC`) is only read as crypto when the caller passes
 * the market hint — `SOL`, `LINK`, `ADA` and friends are also listed US tickers,
 * so guessing would silently quote the wrong instrument. Explicit pairs
 * (`BTCUSDT`, `BTC-USDT`) are unambiguous and need no hint.
 *
 * @param {string} input
 * @param {'US'|'HK'|'CN'|'JP'|'CRYPTO'} [hint]
 * @returns {{symbol: string, market: string, code: string, ticker: string, board?: string, quote?: string, kind?: 'index', index?: object}}
 */
export function parseSymbol(input, hint) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new TradingError(CODES.INVALID_SYMBOL, 'symbol is required');
  }
  // Indices are resolved before any stock dialect handling: `^VIX` is not a
  // ticker, and a bare `VIX`/`恐慌指数` must mean the index rather than a
  // leveraged ETF that merely contains the string (spec §23).
  const index = lookupIndex(input);
  if (index) {
    // Indices carry their own market; a mainland index also carries its exchange
    // in the suffix (`000001.SH` is Shanghai, `399001.SZ` is Shenzhen), which is
    // what downstream exchange labels and provider dialects key off.
    const suffix = index.market === 'CN' && index.symbol.includes('.') ? index.symbol.split('.').pop() : null;
    return {
      symbol: index.symbol,
      market: index.market,
      code: index.symbol,
      ticker: index.symbol,
      kind: 'index',
      index,
      ...(suffix ? { board: suffix } : {}),
    };
  }
  let raw = input.trim().replace(/\s+/g, '').toUpperCase();
  let market = isMarket(hint) ? hint : null;
  /** Exchange/board stated by an explicit prefix or suffix, used to pick CN/JP spelling. */
  let board = null;

  // Strip a market prefix such as HK: or US: or CN: / JP: / CRYPTO:
  const pref = raw.match(/^(CRYPTO|US|HK|CN|JP)([:.])/);
  if (pref) {
    market = pref[1];
    raw = raw.slice(pref[1].length + 1);
  }
  // Strip an eastmoney-style market number prefix (105.AAPL / 116.00700 /
  // 176.7203 / 1.600519 / 0.000001).
  const em = raw.match(/^(\d{1,3})\.(.+)$/);
  if (em && !/\.(HK|SH|SS|SZ|BJ|T)$/.test(raw)) {
    const num = Number(em[1]);
    const cfg = PROVIDER_CONFIG.eastmoney;
    if (cfg.usMarketNumbers.includes(num)) market = 'US';
    else if (num === cfg.hkMarketNumber) market = 'HK';
    else if (num === cfg.jpMarketNumber) market = 'JP';
    else if (num === cfg.cnMarketNumbers.SH) {
      market = 'CN';
      board = 'SH';
    } else if (num === cfg.cnMarketNumbers.SZ) {
      market = 'CN';
      board = 'SZ';
    }
    raw = em[2];
  }
  // Explicit suffixes always win over the hint.
  if (/\.HK$/.test(raw)) {
    market = 'HK';
    raw = raw.replace(/\.HK$/, '');
  } else if (/^\d{6}\.(SH|SS)$/.test(raw)) {
    market = 'CN';
    board = 'SH';
    raw = raw.replace(/\.(SH|SS)$/, '');
  } else if (/^\d{6}\.SZ$/.test(raw)) {
    market = 'CN';
    board = 'SZ';
    raw = raw.replace(/\.SZ$/, '');
  } else if (/^\d{6}\.BJ$/.test(raw)) {
    market = 'CN';
    board = 'BJ';
    raw = raw.replace(/\.BJ$/, '');
  } else if (/^\d{3,4}\.T$/.test(raw)) {
    market = 'JP';
    raw = raw.replace(/\.T$/, '');
  }
  // Crypto: the hint, or an explicit pair.
  const pair = cryptoPairOf(raw);
  if (market === 'CRYPTO' || (!market && pair)) {
    const resolved = pair || { base: raw, quote: CRYPTO_QUOTE };
    if (!CRYPTO_BASE.test(resolved.base)) {
      throw new TradingError(CODES.INVALID_SYMBOL, `invalid crypto symbol: ${input}`);
    }
    return {
      symbol: resolved.base,
      market: 'CRYPTO',
      code: resolved.base,
      ticker: resolved.base,
      quote: resolved.quote,
    };
  }
  // A six-digit numeric form is unambiguously mainland China.
  if (!market && CN_CODE.test(raw)) market = 'CN';
  // A leading-zero numeric form (00700) is Hong Kong.
  if (!market && /^\d+$/.test(raw) && raw.length >= 3) market = 'HK';
  if (!market) market = 'US';

  if (market === 'HK') {
    const m = raw.replace(/^HK/, '').match(HK_DIGITS);
    if (!m) throw new TradingError(CODES.INVALID_SYMBOL, `invalid HK symbol: ${input}`);
    const digits = String(Number(m[1]));
    const code5 = digits.padStart(5, '0');
    const ticker = hkTickerFromCode(code5);
    return { symbol: `${ticker}.HK`, market: 'HK', code: code5, ticker };
  }

  if (market === 'CN') {
    const code = raw.replace(/^(SH|SZ|BJ)/, '');
    if (!CN_CODE.test(code)) {
      throw new TradingError(CODES.INVALID_SYMBOL, `invalid CN symbol: ${input} (expected a six-digit code, e.g. 600519.SH)`);
    }
    const resolved = board || cnBoardOf(code);
    if (!resolved) throw new TradingError(CODES.INVALID_SYMBOL, `unknown CN exchange for ${input}`);
    return { symbol: `${code}.${resolved}`, market: 'CN', code, ticker: code, board: resolved };
  }

  if (market === 'JP') {
    const code = raw.replace(/^JP/, '');
    if (!JP_CODE.test(code)) {
      throw new TradingError(CODES.INVALID_SYMBOL, `invalid JP symbol: ${input} (expected a four-digit TSE code, e.g. 7203.T)`);
    }
    return { symbol: `${code}.T`, market: 'JP', code, ticker: code };
  }

  const ticker = usDisplayCode(raw.replace(/^US/, ''));
  if (!US_TICKER.test(ticker)) throw new TradingError(CODES.INVALID_SYMBOL, `invalid US symbol: ${input}`);
  return { symbol: ticker, market: 'US', code: usProviderCode(ticker), ticker };
}

/** @param {string} symbol */
export function marketOf(symbol) {
  return parseSymbol(symbol).market;
}

/** The currency a market quotes in (spec §18). Crypto is quoted in USDT. */
export function currencyOf(market) {
  switch (market) {
    case 'HK':
      return 'HKD';
    case 'CN':
      return 'CNY';
    case 'JP':
      return 'JPY';
    case 'CRYPTO':
      return CRYPTO_QUOTE;
    default:
      return 'USD';
  }
}

/** The venue an instrument trades on when no provider told us otherwise. */
export function exchangeOf(market, board) {
  switch (market) {
    case 'HK':
      return 'HKEX';
    case 'CN':
      if (board === 'SH') return 'SSE';
      if (board === 'BJ') return 'BSE';
      return 'SZSE';
    case 'JP':
      return 'JPX';
    case 'CRYPTO':
      return 'CRYPTO';
    default:
      return 'NASDAQ';
  }
}

const US_VENUES = { 105: 'NASDAQ', 106: 'NYSE', 107: 'AMEX' };

export function venueName(marketNumber) {
  if (US_VENUES[marketNumber]) return US_VENUES[marketNumber];
  const cfg = PROVIDER_CONFIG.eastmoney;
  if (marketNumber === cfg.hkMarketNumber) return 'HKEX';
  if (marketNumber === cfg.jpMarketNumber) return 'JPX';
  if (marketNumber === cfg.cnMarketNumbers.SH) return 'SSE';
  if (marketNumber === cfg.cnMarketNumbers.SZ) return 'SZSE';
  return '';
}

/** Tencent spells a mainland key with its exchange prefix (`sh600519`). */
export function tencentCnKey(parsed) {
  const board = parsed.board || 'SH';
  return `${board.toLowerCase()}${parsed.code}`;
}

/**
 * Provider dialect translation.
 * @param {string} id provider id
 * @param {string} symbol canonical symbol or any accepted form
 * @param {{marketNumber?: number}} [opts]
 */
export function providerKey(id, symbol, opts = {}) {
  const parsed = parseSymbol(symbol);
  if (parsed.kind === 'index') {
    const index = parsed.index || lookupIndex(parsed.symbol);
    if (!index) throw new TradingError(CODES.NOT_FOUND, `${id} has no mapping for index ${parsed.symbol}`, { provider: id, symbol: parsed.symbol });
    switch (id) {
      case 'yahoo':
        return index.yahooSymbol || index.symbol;
      case 'eastmoney':
        if (!index.eastmoneySecid) {
          throw new TradingError(CODES.NOT_FOUND, `eastmoney has no listing for ${index.symbol}`, { provider: id, symbol: index.symbol });
        }
        return index.eastmoneySecid;
      case 'tencent':
        if (!index.tencentKey) {
          throw new TradingError(CODES.NOT_FOUND, `tencent has no listing for ${index.symbol}`, { provider: id, symbol: index.symbol });
        }
        return index.tencentKey;
      case 'sina':
        if (!index.sinaSymbol) {
          throw new TradingError(CODES.NOT_FOUND, `sina has no listing for ${index.symbol}`, { provider: id, symbol: index.symbol });
        }
        return index.sinaSymbol;
      case 'stooq':
        throw new TradingError(CODES.NOT_FOUND, `stooq has no index mapping for ${index.symbol}`, { provider: id, symbol: index.symbol });
      default:
        return index.symbol;
    }
  }
  switch (id) {
    case 'yahoo':
      if (parsed.market === 'HK') return parsed.symbol;
      if (parsed.market === 'CN') return parsed.board === 'SH' ? `${parsed.code}.SS` : parsed.board === 'BJ' ? `${parsed.code}.BJ` : `${parsed.code}.SZ`;
      if (parsed.market === 'JP') return parsed.symbol;
      if (parsed.market === 'CRYPTO') return `${parsed.ticker}-USD`;
      return parsed.ticker.replace(/\./g, '-');
    case 'stooq':
      if (parsed.market === 'HK') return `${parsed.ticker}.hk`;
      if (parsed.market !== 'US') {
        throw new TradingError(CODES.NOT_FOUND, `stooq has no listing for ${parsed.symbol}`, { provider: id, symbol: parsed.symbol });
      }
      return `${parsed.ticker.toLowerCase().replace(/\./g, '-')}.us`;
    case 'eastmoney': {
      const cfg = PROVIDER_CONFIG.eastmoney;
      if (parsed.market === 'HK') return `${cfg.hkMarketNumber}.${parsed.code}`;
      if (parsed.market === 'JP') return `${cfg.jpMarketNumber}.${parsed.code}`;
      if (parsed.market === 'CN') return `${cfg.cnMarketNumbers[parsed.board] ?? cfg.cnMarketNumbers.SH}.${parsed.code}`;
      const num = opts.marketNumber || cfg.usMarketNumbers[0];
      return `${num}.${parsed.code}`;
    }
    case 'tencent':
      if (parsed.market === 'HK') return `hk${parsed.code}`;
      if (parsed.market === 'CN') return tencentCnKey(parsed);
      if (parsed.market === 'JP') return `jp${parsed.code}`;
      return `us${parsed.ticker}`;
    case 'sina':
      if (parsed.market === 'HK') return `hk${parsed.code}`;
      if (parsed.market === 'CN') return tencentCnKey(parsed);
      return parsed.ticker;
    case 'binance':
      return `${parsed.ticker}${parsed.quote || CRYPTO_QUOTE}`;
    case 'gate':
      return `${parsed.ticker}_${parsed.quote || CRYPTO_QUOTE}`;
    default:
      return parsed.symbol;
  }
}

/** All eastmoney venues to probe when a ticker's venue is unknown. */
export function eastmoneyCandidates(symbol) {
  const parsed = parseSymbol(symbol);
  const cfg = PROVIDER_CONFIG.eastmoney;
  if (parsed.market === 'HK') return [`${cfg.hkMarketNumber}.${parsed.code}`];
  if (parsed.market === 'JP') return [`${cfg.jpMarketNumber}.${parsed.code}`];
  if (parsed.market === 'CN') return [`${cfg.cnMarketNumbers[parsed.board] ?? cfg.cnMarketNumbers.SH}.${parsed.code}`];
  if (parsed.market === 'CRYPTO') return [];
  return cfg.usMarketNumbers.map((n) => `${n}.${parsed.code}`);
}

/** Stooq spelling used by the historical fallback (aapl.us / 700.hk). */
export function stooqKey(symbol) {
  return providerKey('stooq', symbol);
}

/** Build the canonical unified symbol record (spec §18). */
export function stockSymbol({ symbol, name, nameZh, market, exchange, currency }) {
  const parsed = parseSymbol(symbol, market);
  return {
    symbol: parsed.symbol,
    exchangeSymbol: parsed.symbol,
    name: name || parsed.symbol,
    ...(nameZh ? { nameZh } : {}),
    market: parsed.market,
    exchange: exchange || exchangeOf(parsed.market, parsed.board),
    currency: currency || currencyOf(parsed.market),
  };
}

/** Human label used in AI prompts and UI. */
export function displayName(record) {
  if (!record) return '';
  const zh = record.nameZh || (record.name && /[\u4e00-\u9fff]/.test(record.name) ? record.name : '');
  const en = record.name && record.name !== zh ? record.name : '';
  return [en, zh].filter(Boolean).join(' / ') || record.symbol;
}
