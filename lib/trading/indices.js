/**
 * Market index directory (added in 0.3.0 at the user's request: the panel must be
 * able to show the VIX, the Nasdaq, the Hang Seng and friends).
 *
 * This is the single curated table that turns *any* spelling a user or a provider
 * may hand us — `^VIX`, `VIX`, `恐慌指数`, `usVIX`, `100.NDX` — into one canonical
 * symbol with every provider dialect attached, so no provider format leaks into
 * business code or the UI (spec §16) and the symbol directory stays unified
 * (spec §23).
 *
 * Everything here was verified against the live endpoints (2026-10):
 *  - Eastmoney serves global indices under market number 100 (`100.NDX`), but has
 *    **no VIX and no Hang Seng TECH** (`{"rc":100,"data":null}`). Those entries
 *    carry `eastmoneySecid: null` and are excluded from that provider up front
 *    instead of being asked and failing — a failed attempt would count towards
 *    Eastmoney's circuit breaker and degrade *every* other request.
 *  - Tencent serves `usVIX`, but its timestamp can be weeks old. That is fine:
 *    the service grades freshness and the UI says "Last available data" instead of
 *    pretending it is live (spec §21).
 *  - Tencent has no US index candles at all, so US entries can only be charted
 *    through Eastmoney (`candleFilter` below keeps it from being asked).
 *  - Yahoo and Stooq are named in the spec but unreachable from this network; the
 *    Yahoo spelling is still recorded so a future provider only has to read it.
 */

/**
 * @typedef {{
 *   symbol: string, name: string, nameZh: string, market: 'US'|'HK'|'CN'|'JP',
 *   currency: 'USD'|'HKD'|'CNY'|'JPY',
 *   exchange: string, group: 'US'|'HK'|'CN'|'JP', order: number,
 *   eastmoneySecid: string|null, tencentKey: string|null,
 *   tvSymbol: string, yahooSymbol: string, aliases: string[],
 * }} IndexRecord
 */

/** @type {IndexRecord[]} */
export const INDEX_DIRECTORY = [
  {
    symbol: '^IXIC',
    name: 'Nasdaq Composite',
    nameZh: '纳斯达克综合指数',
    market: 'US',
    currency: 'USD',
    exchange: 'NASDAQ',
    group: 'US',
    order: 10,
    eastmoneySecid: '100.NDX',
    tencentKey: 'usIXIC',
    sinaSymbol: '.IXIC',
    tvSymbol: 'NASDAQ:IXIC',
    yahooSymbol: '^IXIC',
    aliases: ['IXIC', 'NASDAQ', 'NASDAQ COMPOSITE', 'COMP', '纳斯达克', '纳指', '纳斯达克综合'],
  },
  {
    symbol: '^NDX',
    name: 'Nasdaq 100',
    nameZh: '纳斯达克100指数',
    market: 'US',
    currency: 'USD',
    exchange: 'NASDAQ',
    group: 'US',
    order: 20,
    eastmoneySecid: '100.NDX100',
    tencentKey: 'usNDX',
    sinaSymbol: '.NDX',
    tvSymbol: 'NASDAQ:NDX',
    yahooSymbol: '^NDX',
    aliases: ['NDX', 'NDX100', 'NASDAQ100', 'NASDAQ 100', '纳斯达克100', '纳指100'],
  },
  {
    symbol: '^GSPC',
    name: 'S&P 500',
    nameZh: '标普500指数',
    market: 'US',
    currency: 'USD',
    exchange: 'SP',
    group: 'US',
    order: 30,
    eastmoneySecid: '100.SPX',
    tencentKey: 'usINX',
    tvSymbol: 'SP:SPX',
    yahooSymbol: '^GSPC',
    aliases: ['GSPC', 'SPX', 'SP500', 'INX', 'SP 500', '标普500', '标普', '标准普尔500'],
  },
  {
    symbol: '^DJI',
    name: 'Dow Jones Industrial Average',
    nameZh: '道琼斯工业指数',
    market: 'US',
    currency: 'USD',
    exchange: 'DJ',
    group: 'US',
    order: 40,
    eastmoneySecid: '100.DJIA',
    tencentKey: 'usDJI',
    sinaSymbol: '.DJI',
    tvSymbol: 'TVC:DJI',
    yahooSymbol: '^DJI',
    // NOTE: the bare alias `DOW` is deliberately absent — `DOW` is a real,
    // tradable US ticker (Dow Inc.), so resolving it to this index would hijack
    // a stock lookup. `DOW JONES` (with the space) is unambiguous.
    aliases: ['DJI', 'DJIA', 'DOW JONES', '道琼斯', '道指'],
  },
  {
    symbol: '^VIX',
    name: 'CBOE Volatility Index',
    nameZh: '恐慌指数（VIX）',
    market: 'US',
    currency: 'USD',
    exchange: 'CBOE',
    group: 'US',
    order: 50,
    // Eastmoney has no VIX index at all; Tencent is the only source here.
    eastmoneySecid: null,
    tencentKey: 'usVIX',
    tvSymbol: 'TVC:VIX',
    yahooSymbol: '^VIX',
    aliases: ['VIX', 'VIX INDEX', 'CBOE VIX', 'VOLATILITY INDEX', '恐慌指数', '波动率指数'],
  },
  {
    symbol: '^HSI',
    name: 'Hang Seng Index',
    nameZh: '恒生指数',
    market: 'HK',
    currency: 'HKD',
    exchange: 'HKEX',
    group: 'HK',
    order: 60,
    eastmoneySecid: '100.HSI',
    tencentKey: 'hkHSI',
    tvSymbol: 'TVC:HSI',
    yahooSymbol: '^HSI',
    aliases: ['HSI', 'HANGSENG', 'HANG SENG', '恒指', '恒生'],
  },
  {
    symbol: '^HSCEI',
    name: 'Hang Seng China Enterprises Index',
    nameZh: '恒生中国企业指数（国企指数）',
    market: 'HK',
    currency: 'HKD',
    exchange: 'HKEX',
    group: 'HK',
    order: 70,
    eastmoneySecid: '100.HSCEI',
    tencentKey: 'hkHSCEI',
    tvSymbol: 'TVC:HSCEI',
    yahooSymbol: '^HSCE',
    aliases: ['HSCEI', 'HSCE', 'H-SHARE', '国企指数', 'H股指数', '恒生国企'],
  },
  {
    symbol: '^HSTECH',
    name: 'Hang Seng TECH Index',
    nameZh: '恒生科技指数',
    market: 'HK',
    currency: 'HKD',
    exchange: 'HKEX',
    group: 'HK',
    order: 80,
    // Eastmoney returns rc:100 for 100.HSTECH; Tencent (hkHSTECH) does serve it.
    eastmoneySecid: null,
    tencentKey: 'hkHSTECH',
    tvSymbol: 'TVC:HSTECH',
    yahooSymbol: '^HSTECH',
    aliases: ['HSTECH', 'HS TECH', 'HANGSENG TECH', '恒生科技', '恒生科技指数'],
  },
  /**
   * Mainland China (0.5.0). Bare `000001` is deliberately *not* an alias: it is
   * 平安银行 on Shenzhen, so only the suffixed spelling resolves to the index.
   */
  {
    symbol: '000001.SH',
    name: 'SSE Composite Index',
    nameZh: '上证综合指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'SSE',
    group: 'CN',
    order: 110,
    eastmoneySecid: '1.000001',
    tencentKey: 'sh000001',
    sinaSymbol: 'sh000001',
    tvSymbol: 'SSE:000001',
    yahooSymbol: '000001.SS',
    aliases: ['SHCOMP', 'SSEC', 'SSE COMPOSITE', '上证指数', '上证综指', '上证综合指数', '上证'],
  },
  {
    symbol: '399001.SZ',
    name: 'SZSE Component Index',
    nameZh: '深证成份指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'SZSE',
    group: 'CN',
    order: 120,
    eastmoneySecid: '0.399001',
    tencentKey: 'sz399001',
    sinaSymbol: 'sz399001',
    tvSymbol: 'SZSE:399001',
    yahooSymbol: '399001.SZ',
    aliases: ['SZCOMP', 'SZSE COMPONENT', '深证成指', '深成指', '深证'],
  },
  {
    symbol: '000300.SH',
    name: 'CSI 300 Index',
    nameZh: '沪深300指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'SSE',
    group: 'CN',
    order: 130,
    eastmoneySecid: '1.000300',
    tencentKey: 'sh000300',
    sinaSymbol: 'sh000300',
    tvSymbol: 'SSE:000300',
    yahooSymbol: '000300.SS',
    aliases: ['CSI300', 'HS300', '沪深300', '沪深三百', '沪深300指数'],
  },
  {
    symbol: '399006.SZ',
    name: 'ChiNext Index',
    nameZh: '创业板指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'SZSE',
    group: 'CN',
    order: 140,
    eastmoneySecid: '0.399006',
    tencentKey: 'sz399006',
    sinaSymbol: 'sz399006',
    tvSymbol: 'SZSE:399006',
    yahooSymbol: '399006.SZ',
    aliases: ['CHINEXT', '创业板指', '创业板指数', '创业板'],
  },
  {
    symbol: '000688.SH',
    name: 'STAR 50 Index',
    nameZh: '科创50指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'SSE',
    group: 'CN',
    order: 150,
    eastmoneySecid: '1.000688',
    tencentKey: 'sh000688',
    sinaSymbol: 'sh000688',
    tvSymbol: 'SSE:000688',
    yahooSymbol: '000688.SS',
    aliases: ['STAR50', 'STAR 50', '科创50', '科创板50'],
  },
  {
    symbol: '899050.BJ',
    name: 'BSE 50 Index',
    nameZh: '北证50指数',
    market: 'CN',
    currency: 'CNY',
    exchange: 'BSE',
    group: 'CN',
    order: 160,
    eastmoneySecid: '0.899050',
    tencentKey: 'bj899050',
    tvSymbol: 'BSE:899050',
    yahooSymbol: '899050.BJ',
    aliases: ['BSE50', '北证50', '北证50指数'],
  },
  /**
   * Japan (0.5.0): the Nikkei through eastmoney's market number 100. Tencent
   * answers an empty record for `jpN225`, so `tencentKey` stays null and that
   * provider is never asked (a doomed call would count towards its breaker).
   */
  {
    symbol: '^N225',
    name: 'Nikkei 225',
    nameZh: '日经225指数',
    market: 'JP',
    currency: 'JPY',
    exchange: 'JPX',
    group: 'JP',
    order: 170,
    eastmoneySecid: '100.N225',
    tencentKey: null,
    tvSymbol: 'TVC:NI225',
    yahooSymbol: '^N225',
    aliases: ['N225', 'NIKKEI', 'NIKKEI225', 'NIKKEI 225', 'JP225', '日经', '日经225', '日经指数'],
  },
];

const BY_SYMBOL = new Map(INDEX_DIRECTORY.map((entry) => [entry.symbol, entry]));

/** Alias → canonical symbol. Built once; keys are upper-cased and trimmed. */
const BY_ALIAS = new Map();
/** Provider dialect → canonical symbol (`usvix`, `hkhsi`, `100.ndx`). */
const BY_PROVIDER_KEY = new Map();
for (const entry of INDEX_DIRECTORY) {
  for (const alias of [entry.symbol, entry.symbol.replace(/^\^/, ''), ...entry.aliases]) {
    const key = normalizeIndexKey(alias);
    if (key && !BY_ALIAS.has(key)) BY_ALIAS.set(key, entry.symbol);
  }
  for (const key of [entry.tencentKey, entry.eastmoneySecid]) {
    if (key) BY_PROVIDER_KEY.set(normalizeIndexKey(key), entry.symbol);
  }
  for (const key of [entry.name, entry.nameZh, entry.yahooSymbol, entry.tvSymbol]) {
    const normalized = normalizeIndexKey(key);
    if (normalized && !BY_ALIAS.has(normalized)) BY_ALIAS.set(normalized, entry.symbol);
  }
}

/** The indices the Market Overview strip shows, in display order. */
export const DEFAULT_INDEX_SYMBOLS = INDEX_DIRECTORY.slice()
  .sort((a, b) => a.order - b.order)
  .map((entry) => entry.symbol);

export function normalizeIndexKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve any index spelling to its directory record.
 * @param {string} input
 * @returns {IndexRecord|null}
 */
export function lookupIndex(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  const upper = normalizeIndexKey(raw);
  const direct = BY_SYMBOL.get(upper);
  if (direct) return direct;
  const byAlias = BY_ALIAS.get(upper);
  if (byAlias) return BY_SYMBOL.get(byAlias) || null;
  const byProvider = BY_PROVIDER_KEY.get(normalizeIndexKey(raw));
  if (byProvider) return BY_SYMBOL.get(byProvider) || null;
  // A caret-prefixed spelling of an alias is still that index: `^SPX` is the
  // S&P 500 (whose canonical spelling here is `^GSPC`), not an unknown ticker.
  if (upper.startsWith('^')) {
    const bare = upper.slice(1);
    const aliased = BY_ALIAS.get(bare) || BY_PROVIDER_KEY.get(bare);
    if (aliased) return BY_SYMBOL.get(aliased) || null;
  }
  return null;
}

export function isIndexSymbol(value) {
  return Boolean(lookupIndex(value));
}

/**
 * Soft matching for the search box: a query such as `纳斯达克`, `vix` or `恒生`
 * must surface the index itself, not only the leveraged products that track it.
 * @param {string} query
 * @param {'US'|'HK'} [market]
 * @param {number} [limit]
 */
export function searchIndices(query, market, limit = 4) {
  const needle = normalizeIndexKey(query);
  if (!needle) return [];
  const matches = [];
  for (const entry of INDEX_DIRECTORY) {
    if (market && entry.market !== market) continue;
    const haystack = [entry.symbol, entry.symbol.replace(/^\^/, ''), entry.name, entry.nameZh, ...entry.aliases].map(normalizeIndexKey);
    const exact = haystack.some((h) => h === needle);
    // Reverse containment ("SPX500" contains "SPX") only for real words, never
    // for a one-character haystack that would match almost any query.
    const partial = !exact && haystack.some((h) => h.includes(needle) || (h.length >= 2 && needle.includes(h)));
    if (!exact && !partial) continue;
    matches.push({ entry, exact });
  }
  // An exact alias always outranks a fuzzy hit, no matter where the record sits
  // in the directory: "纳斯达克100" is ^NDX, not ^IXIC's prefix match.
  matches.sort((a, b) => (a.exact === b.exact ? a.entry.order - b.entry.order : a.exact ? -1 : 1));
  return matches.slice(0, Math.max(0, limit)).map(({ entry, exact }) => ({
    symbol: entry.symbol,
    exchangeSymbol: entry.symbol,
    name: entry.name,
    nameZh: entry.nameZh,
    market: entry.market,
    exchange: entry.exchange,
    currency: entry.currency,
    kind: 'index',
    quoteType: 'INDEX',
    aliases: [...entry.aliases],
    ...(exact ? { exact: true } : {}),
  }));
}

/**
 * Provider filters. Declared here (next to the data that justifies them) and used
 * by the providers, so the router simply never offers a provider that cannot
 * serve a given index — no business-logic `if (symbol.startsWith('^'))`.
 * @param {string} symbol canonical index symbol
 * @param {'search'|'quote'|'candles'|'profile'} feature
 */
export function indexSupportFor(providerId, symbol, feature) {
  const entry = lookupIndex(symbol);
  if (!entry) return true;
  switch (providerId) {
    case 'eastmoney':
      if (feature === 'profile') return false;
      return Boolean(entry.eastmoneySecid);
    case 'tencent':
      if (feature === 'profile') return false;
      // Tencent answers 0 rows for every US index candle request. Mainland index
      // candles go through its ordinary CN kline endpoint; a bad answer there is
      // caught by the router's minimum-bar validation, which does not count as a
      // health failure, so asking is safe.
      if (feature === 'candles') return entry.market === 'HK' || (entry.market === 'CN' && Boolean(entry.tencentKey));
      return Boolean(entry.tencentKey);
    case 'yahoo':
      return true;
    case 'sina':
      if (feature !== 'candles') return false;
      // Sina's US daily series uses a leading dot (`.IXIC`, `.NDX`, `.DJI`); the
      // S&P 500 and VIX are simply not published there, so they are left out
      // instead of spending a doomed call. Mainland indices are published and use
      // the same `sh000001` spelling as the CN kline feed.
      return Boolean(entry.sinaSymbol);
    case 'stooq':
      // No verified index mapping on Stooq; keeping it out avoids a doomed call.
      return false;
    default:
      return true;
  }
}

/** Public shape used by `GET /api/trading/indices` (code + label + external dialects). */
export function publicIndex(entry) {
  return {
    symbol: entry.symbol,
    name: entry.name,
    nameZh: entry.nameZh,
    market: entry.market,
    currency: entry.currency,
    exchange: entry.exchange,
    kind: 'index',
    group: entry.group,
    order: entry.order,
    // Dialect strings the UI needs to build "open the source page" links. These
    // are chart-site tickers (TradingView/Yahoo/腾讯财经 page ids), not our market
    // data provider keys, so they leak no upstream payload (§16).
    links: {
      tradingView: entry.tvSymbol,
      yahoo: entry.yahooSymbol,
      tencentKey: entry.tencentKey || null,
    },
  };
}
