/**
 * dsh-trading-mode — centralised market data configuration.
 *
 * Spec §51: every provider choice / TTL / endpoint configuration must live here.
 * No other module may hard-code a third-party endpoint or provider name.
 */

/** @typedef {'US'|'HK'|'CN'|'JP'|'CRYPTO'} Market */

/**
 * Every market the panel can quote, in display order (0.5.0 added mainland
 * China, Japan and crypto). `STOCK_MARKETS` is the subset that trades on an
 * exchange with a session; the crypto market trades 24/7.
 */
export const MARKETS = ['US', 'HK', 'CN', 'JP', 'CRYPTO'];
export const STOCK_MARKETS = ['US', 'HK', 'CN', 'JP'];
export const CRYPTO_MARKET = 'CRYPTO';
/** Every crypto pair this plugin quotes is denominated in USDT (measured: 757 pairs on Binance). */
export const CRYPTO_QUOTE = 'USDT';
/**
 * The crypto "market overview" tiles. Unlike the equity indices these are not
 * indices but the largest coins by market capitalisation.
 */
export const CRYPTO_SPOTLIGHT = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX'];
/** Human labels shared by the client, the API payloads and log lines. */
export const MARKET_LABELS = {
  US: 'United States',
  HK: 'Hong Kong',
  CN: 'Mainland China',
  JP: 'Japan',
  CRYPTO: 'Crypto',
};

/**
 * Per-market provider chain.
 *
 * `primary` is the spec-mandated provider for the market. `historicalFallback`
 * is only used for historical candles. `chain` is the ordered list the
 * MarketDataService walks when a provider is unhealthy or fails.
 *
 * NOTE (documented deviation): the spec names Yahoo as primary and Stooq as the
 * historical fallback. On the machine this plugin was built for, Yahoo and Stooq
 * both answer HTTP 403 to every unauthenticated request (IP-level block), so a
 * CN-reachable provider is included in the chain. Provider selection is by
 * health + config only — no business code depends on which one answered.
 *
 * @type {Record<Market, {primary: string, historicalFallback: string, chain: string[]}>}
 */
export const MARKET_DATA_CONFIG = {
  US: { primary: 'yahoo', historicalFallback: 'stooq', chain: ['yahoo', 'eastmoney', 'tencent', 'sina', 'stooq'] },
  HK: { primary: 'yahoo', historicalFallback: 'stooq', chain: ['yahoo', 'eastmoney', 'tencent', 'stooq'] },
  /**
   * Mainland China (0.5.0). Yahoo answers 403 from this network, so the chain is
   * the three mainland feeds only: quote → eastmoney/tencent, history →
   * eastmoney, and Sina carries the full listing plus a second daily history.
   */
  CN: { primary: 'eastmoney', historicalFallback: 'sina', chain: ['eastmoney', 'tencent', 'sina'] },
  /** Japan (0.5.0). Quotes eastmoney(176)/tencent(`jp`), history eastmoney only. */
  JP: { primary: 'eastmoney', historicalFallback: 'eastmoney', chain: ['eastmoney', 'tencent'] },
  /**
   * Crypto (0.5.0): Binance 24h tickers + klines, Gate.io as the fallback feed.
   * CoinLore rides along in the chain because it is the only crypto provider that
   * serves `search`/`profile`/`universe`; the router filters candidates by
   * `supports(feature, market)`, so it never answers a quote or a candle.
   */
  CRYPTO: { primary: 'binance', historicalFallback: 'gate', chain: ['binance', 'gate', 'coinlore'] },
};

/**
 * Endpoint + protocol configuration for each provider implementation.
 * Provider modules read from here; nothing is inlined in provider logic.
 */
export const PROVIDER_CONFIG = {
  yahoo: {
    label: 'Yahoo Finance',
    quoteBase: 'https://query1.finance.yahoo.com',
    searchPath: '/v1/finance/search',
    chartPath: '/v8/finance/chart',
    quotePath: '/v7/finance/quote',
    profilePath: '/v10/finance/quoteSummary',
    crumbPath: '/v1/test/getcrumb',
    cookieUrl: 'https://fc.yahoo.com/',
    markets: ['US', 'HK'],
    intervals: ['5m', '15m', '30m', '1h', '1d', '1wk'],
    supportsSearch: true,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: true,
    delaySeconds: null,
  },
  stooq: {
    label: 'Stooq',
    base: 'https://stooq.com/q/d/l/',
    quoteUrl: 'https://stooq.com/q/l/',
    markets: ['US', 'HK'],
    /** Stooq publishes end-of-day history only. */
    intervals: ['1d', '1wk'],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: true,
    supportsProfile: false,
    /** Stooq is an end-of-day historical feed; quotes derived from it are stale by definition. */
    delaySeconds: null,
  },
  eastmoney: {
    label: '东方财富 Eastmoney',
    /**
     * The numbered mirrors of these hostnames answer *unequally*, and which one
     * works changes between runs: measured repeatedly, one probe had
     * `17.push2.eastmoney.com` quoting while every other name hung up, the next
     * had the reverse. Requests therefore walk a pool and remember the host that
     * last answered (0.5.0). The old single-shot `retries: 0` was also removed: a
     * one-shot eastmoney call measured 0/6 successes, with retries 6/6.
     */
    quoteBase: 'https://push2.eastmoney.com',
    /**
     * Interleaved on purpose: measured live, `push2his.eastmoney.com` serves
     * `stock/get` just as well as the `push2` family does, and whichever family is
     * answering changes between runs. The first six entries are tried per request.
     */
    quoteHosts: [
      'push2.eastmoney.com',
      'push2his.eastmoney.com',
      '17.push2.eastmoney.com',
      '1.push2his.eastmoney.com',
      '1.push2.eastmoney.com',
      '2.push2his.eastmoney.com',
      '2.push2.eastmoney.com',
      '7.push2his.eastmoney.com',
      '7.push2.eastmoney.com',
      '17.push2his.eastmoney.com',
      '48.push2.eastmoney.com',
      '48.push2his.eastmoney.com',
    ],
    quotePath: '/api/qt/stock/get',
    ulistPath: '/api/qt/ulist.np/get',
    historyBase: 'https://push2his.eastmoney.com',
    historyHosts: [
      'push2his.eastmoney.com',
      '1.push2his.eastmoney.com',
      '2.push2his.eastmoney.com',
      '7.push2his.eastmoney.com',
      '17.push2his.eastmoney.com',
      '48.push2his.eastmoney.com',
    ],
    klinePath: '/api/qt/stock/kline/get',
    searchUrl: 'https://searchapi.eastmoney.com/api/suggest/get',
    searchToken: 'D43BF722C8E33BDC906FB84D85E326E8',
    /** Full security list (`clist`) — the bulk universe feed, paged 100 rows at a time. */
    clistPath: '/api/qt/clist/get',
    clistToken: 'bd1d9ddb04089700cf9c27f6f7426281',
    /** At most this many mirrors are tried before the provider gives up. */
    maxHostsPerRequest: 6,
    /** A mirror that just failed is skipped again for this long. */
    hostCooldownMs: 45_000,
    markets: ['US', 'HK', 'CN', 'JP'],
    intervals: ['5m', '15m', '30m', '1h', '1d', '1wk'],
    supportsSearch: true,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: true,
    /** US venues as understood by eastmoney; used when resolving a bare ticker. */
    usMarketNumbers: [105, 106, 107],
    hkMarketNumber: 116,
    /** Verified live (0.5.0): `176.<4-digit code>` is Tokyo — Toyota `7203` → `176.7203`. */
    jpMarketNumber: 176,
    /** Shanghai = 1, Shenzhen = 0, Beijing = 0, by upstream convention. */
    cnMarketNumbers: { SH: 1, SZ: 0, BJ: 0 },
    /**
     * `fltt=2` asks the upstream to return real units. Measured equivalent across
     * CN/JP/US/HK and indices, so no local `10 ** f59` scaling happens any more —
     * that scaling double-counted on `fltt=2` and mis-scaled Japan.
     */
    flatFields: true,
    /** Eastmoney is a mainland realtime feed: the last print is reported live. */
    delaySeconds: null,
  },
  tencent: {
    label: '腾讯财经 Tencent',
    quoteBase: 'https://qt.gtimg.cn',
    /** `?q=usAAPL,hk00700` — the path prefix is fixed, the key list is built per request. */
    quotePath: '/q=',
    klineBase: 'https://web.ifzq.gtimg.cn',
    /** `app/kline/kline` honours the bar count for US/HK/CN, unlike `usfqkline`. */
    klinePath: '/appstock/app/kline/kline',
    markets: ['US', 'HK', 'CN', 'JP'],
    /** Every minute-level Tencent endpoint is dead (`Can't load controller`). */
    intervals: ['1d', '1wk'],
    supportsSearch: false,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: false,
    delaySeconds: null,
  },
  /**
   * Sina Finance — added in 0.4.1 as the fallback for the two bulk feeds the
   * upstream blocks intermittently (measured live: eastmoney `clist` and
   * `kline` answer a TCP reset for stretches of time while its single-quote
   * endpoints keep working).
   *
   *  - `getCandles`: `US_MinKService.getDailyK` returns the *entire* US daily
   *    history (AAPL back to 1984-09-07, 940 KB) as JSONP. US only: the HK twin
   *    answers `Service not valid`, and no minute series is published.
   *  - `listSecurities`: the HK board list, 60 rows per page.
   */
  sina: {
    label: '新浪财经 Sina Finance',
    base: 'https://stock.finance.sina.com.cn',
    /** `usstock/api/jsonp.php/var%20x/US_MinKService.getDailyK?symbol=AAPL&___qn=3` */
    dailyPath: '/usstock/api/jsonp.php/var%20x/US_MinKService.getDailyK',
    listBase: 'https://vip.stock.finance.sina.com.cn',
    hkListPath: '/quotes_service/api/json_v2.php/Market_Center.getHKStockData',
    /**
     * Mainland China (0.5.0). Sina is the *stable* CN feed on this network: its
     * bulk node lists answer while eastmoney's `clist` hangs up for stretches
     * (measured: `hs_a` 5,571 rows, `sh_a` 2,319, `sz_a` 2,904, `hs_bjs` 348,
     * `kcb` 618, `cyb` 1,409), and its daily kline covers Shanghai, Shenzhen and
     * Beijing — including the Beijing issues Tencent only ever answers one bar for.
     */
    cnBase: 'https://money.finance.sina.com.cn',
    cnListPath: '/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
    cnCountPath: '/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount',
    cnKlinePath: '/quotes_service/api/json_v2.php/CN_MarketData.getKLineData',
    /** Sina caps `num` at 100 and answers GBK. */
    cnListPageSize: 100,
    cnHeaders: { Referer: 'https://finance.sina.com.cn/' },
    markets: ['US', 'HK', 'CN'],
    listingMarkets: ['HK', 'CN'],
    /** Daily history only — the US minute endpoint answers `var x(null)`. */
    intervals: ['1d'],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: true,
    supportsProfile: false,
    /** Sina's HK board list hard-caps at 60 rows per page. */
    hkListPageSize: 60,
    delaySeconds: null,
  },
  /**
   * Nasdaq's own screener — the US fallback list. One request returns every
   * listed US stock (`limit=10000` → 7,017 rows in ~1.2 s), so it needs no
   * paging upstream; `listSecurities` slices the cached table instead.
   * Quotes/candles stay with the regular chain.
   */
  nasdaq: {
    label: 'Nasdaq',
    base: 'https://api.nasdaq.com',
    screenerPath: '/api/screener/stocks',
    limit: 10_000,
    headers: { Accept: 'application/json', Referer: 'https://www.nasdaq.com/' },
    markets: ['US'],
    intervals: [],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: false,
    supportsProfile: false,
    delaySeconds: null,
  },
  /**
   * Binance public market data (0.5.0). `data-api.binance.vision` is the only
   * Binance host reachable from this network — `api.binance.com` and its
   * mirrors reset the connection, OKX/Coinbase/CoinGecko time out, and
   * CryptoCompare answers 401 — so this is the crypto primary.
   *
   * Dialect notes, all measured: the pair has to be upper-case concatenated
   * (`BTCUSDT`; `BTC-USDT` → `-1121 Invalid symbol`), the interval token for a
   * weekly bar is `1w` (`1wk` is a 400), one klines call caps at 1,000 rows and
   * silently truncates above that, and `exchangeInfo` is 17.7 MB with no names
   * in it, so names come from the CoinLore/Gate directories instead.
   */
  binance: {
    label: 'Binance',
    base: 'https://data-api.binance.vision',
    tickerPath: '/api/v3/ticker/24hr',
    klinesPath: '/api/v3/klines',
    exchangeInfoPath: '/api/v3/exchangeInfo',
    quoteAsset: 'USDT',
    markets: ['CRYPTO'],
    intervals: ['5m', '15m', '30m', '1h', '1d', '1wk'],
    /** Our interval id → Binance interval token. */
    intervalMap: { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d', '1wk': '1w' },
    /** Hard upstream cap; longer ranges are assembled from several calls. */
    klineLimit: 1_000,
    /** How many upstream klines pages one range may cost. */
    klineMaxPages: 4,
    supportsSearch: true,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: false,
    delaySeconds: 0,
  },
  /**
   * Gate.io — the crypto fallback (0.5.0). Its `currency_pairs` directory is the
   * best English name source measured (2,203 pairs with `base_name`), and its
   * candlesticks array is ordered newest-first, the opposite of Binance, so the
   * adapter reverses it.
   */
  gate: {
    label: 'Gate.io',
    base: 'https://api.gateio.ws',
    tickersPath: '/api/v4/spot/tickers',
    candlesticksPath: '/api/v4/spot/candlesticks',
    pairsPath: '/api/v4/spot/currency_pairs',
    quoteAsset: 'USDT',
    markets: ['CRYPTO'],
    intervals: ['5m', '15m', '30m', '1h', '1d', '1wk'],
    intervalMap: { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d', '1wk': '7d' },
    maxCandles: 1_000,
    supportsSearch: false,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: false,
    delaySeconds: 0,
  },
  /**
   * CoinLore — the crypto *directory* (0.5.0): ranked coins with names, market
   * capitalisation and 24 h change, 100 per page. It is a listing/name source
   * only: its prices carry no timestamp and differ from the exchange quotes by
   * ~0.2 %, so it is never allowed to answer a quote.
   */
  coinlore: {
    label: 'CoinLore',
    base: 'https://api.coinlore.net',
    tickersPath: '/api/tickers/',
    pageSize: 100,
    markets: ['CRYPTO'],
    intervals: [],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: false,
    supportsProfile: false,
    delaySeconds: null,
  },
};

/** Cache key namespaces (spec §41). */
export const CACHE_KEYS = {
  quote: (symbol) => `quote:${symbol}`,
  candles: (symbol, interval, range) => `candles:${symbol}:${interval}:${range}`,
  profile: (symbol) => `profile:${symbol}`,
  technical: (symbol, interval, range) => `technical:${symbol}:${interval}:${range}`,
  search: (market, query) => `search:${market}:${query.toLowerCase()}`,
};

/**
 * TTL policy, milliseconds (spec §42: short TTL while the market is open, long
 * TTL while it is closed).
 */
export const CACHE_TTL = {
  /** Quotes: fast-moving, keep them short. */
  open: { quote: 20_000, candles: 60_000, profile: 24 * 3600_000, technical: 60_000, search: 10 * 60_000 },
  /** Market closed: the last print will not change, so hold it longer. */
  closed: { quote: 10 * 60_000, candles: 30 * 60_000, profile: 24 * 3600_000, technical: 30 * 60_000, search: 60 * 60_000 },
  /** Hard ceiling: cached data older than this is never served, not even as stale. */
  maxStaleAge: { quote: 72 * 3600_000, candles: 7 * 24 * 3600_000, profile: 30 * 24 * 3600_000, technical: 24 * 3600_000, search: 24 * 3600_000 },
};

/** Resilience policy for the Market Data Service (spec §43/§74). */
export const HTTP_POLICY = {
  timeoutMs: 12_000,
  retries: 2,
  retryBaseDelayMs: 350,
  retryMaxDelayMs: 2_000,
  /** Token-bucket limit applied per provider, requests per minute. */
  rateLimitPerMinute: 120,
  /** After this many consecutive failures a provider is marked unhealthy. */
  failureThreshold: 3,
  /** How long an unhealthy provider is skipped before it gets a probe again. */
  healthCooldownMs: 60_000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/**
 * ── Transport policy (0.6.0, publication task B2) ───────────────────────────
 * `http.js` implements two transports behind one interface:
 *
 *  - `standard` — plain `node:http(s)` with the runtime's own DNS order and no
 *    address-family pinning. This is what a generic network wants.
 *  - `compatibility` — remembers the family that last answered a host and pins
 *    one family per retry attempt, flipping between them. Needed on networks
 *    where one family accepts the TCP connection and then resets it (measured
 *    from a mainland-China home network, see `http.js`).
 *
 * `auto` (the default) starts on `standard` and switches *only the hosts that
 * actually fail* to `compatibility`, so nobody has to know which network they
 * are on. `compatibility` forces the old behaviour; `standard` forbids the
 * fallback entirely (useful to prove a network problem is not caused by it).
 */
export const NETWORK_MODES = ['auto', 'standard', 'compatibility'];

export const NETWORK_POLICY = {
  mode: 'auto',
};

let NETWORK_MODE_OVERRIDE = null;

/**
 * Set the transport mode. `undefined` / `null` / `''` clears the override and
 * restores the default. Throws a message that lists the accepted values.
 */
export function setNetworkMode(mode) {
  if (mode === undefined || mode === null || mode === '') {
    NETWORK_MODE_OVERRIDE = null;
    return networkMode();
  }
  if (!NETWORK_MODES.includes(mode)) {
    throw new Error(`networkMode must be one of ${NETWORK_MODES.join(', ')} (got ${JSON.stringify(mode)})`);
  }
  NETWORK_MODE_OVERRIDE = mode;
  return mode;
}

/** The transport mode in force: the user override, else `NETWORK_POLICY.mode`. */
export function networkMode() {
  return NETWORK_MODE_OVERRIDE || NETWORK_POLICY.mode;
}

/** Trading-session table used for TTL selection and staleness grading. */
export const MARKET_SESSIONS = {
  US: { timeZone: 'America/New_York', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  HK: { timeZone: 'Asia/Hong_Kong', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  /** Shanghai/Shenzhen: 09:30–11:30 and 13:00–15:00; the lunch break is not modelled. */
  CN: { timeZone: 'Asia/Shanghai', open: '09:30', close: '15:00', days: [1, 2, 3, 4, 5] },
  /** Tokyo: 09:00–11:30 and 12:30–15:00; the lunch break is not modelled. */
  JP: { timeZone: 'Asia/Tokyo', open: '09:00', close: '15:00', days: [1, 2, 3, 4, 5] },
  /** Crypto trades around the clock, every day. */
  CRYPTO: { timeZone: 'UTC', open: '00:00', close: '24:00', days: [0, 1, 2, 3, 4, 5, 6] },
};

/** Candle intervals and the ranges offered in the UI (spec §36). */
export const INTERVALS = ['5m', '15m', '30m', '1h', '1d', '1wk'];
export const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y', 'max'];

/** Range → provider-specific code maps. */
export const RANGE_CONFIG = {
  '1d': { days: 1, label: '1D', defaultInterval: '5m' },
  '5d': { days: 5, label: '5D', defaultInterval: '30m' },
  '1mo': { days: 22, label: '1M', defaultInterval: '1d' },
  '3mo': { days: 66, label: '3M', defaultInterval: '1d' },
  '6mo': { days: 132, label: '6M', defaultInterval: '1d' },
  '1y': { days: 252, label: '1Y', defaultInterval: '1d' },
  '5y': { days: 1260, label: '5Y', defaultInterval: '1wk' },
  max: { days: 6000, label: 'MAX', defaultInterval: '1wk' },
};

/**
 * How many bars a range/interval pair needs. Providers that take an explicit
 * bar count (eastmoney `lmt`, tencent `param=...,count`) read this so the
 * request size stays a configuration decision, not a provider decision.
 *
 * Crypto trades around the clock, so a range covers *calendar* days there and a
 * day holds 288 5-minute bars rather than an equity session's 78. Sizing crypto
 * with the equity table made `1mo/1h` cover barely a week (measured against
 * Binance: 164 bars ≈ 6.8 days), so the two tables are kept apart.
 */
export const CRYPTO_RANGE_DAYS = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365, '5y': 1826, max: 4000 };
const BARS_PER_DAY = {
  equity: { '5m': 78, '15m': 26, '30m': 13, '1h': 7, '1d': 1, '1wk': 0.2 },
  crypto: { '5m': 288, '15m': 96, '30m': 48, '1h': 24, '1d': 1, '1wk': 1 / 7 },
};

/** Calendar days a range covers on `market` (crypto counts every day). */
export function rangeDays(range, market) {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['6mo'];
  if (market === CRYPTO_MARKET) return CRYPTO_RANGE_DAYS[range] ?? cfg.days;
  return cfg.days;
}

export function candleLimit(range, interval, market) {
  const days = rangeDays(range, market);
  const table = market === CRYPTO_MARKET ? BARS_PER_DAY.crypto : BARS_PER_DAY.equity;
  const perDay = table[interval] ?? 1;
  return Math.max(30, Math.min(1_600, Math.round(days * perDay) + 10));
}

/** Quant engine parameters (spec §29/§71). */
export const QUANT_CONFIG = {
  sma: [5, 10, 20, 50, 60, 200],
  ema: [12, 26],
  rsiPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  atrPeriod: 14,
  volumeAveragePeriod: 20,
  /** Swing window used for support/resistance candidate pivots. */
  pivotLookback: 3,
  pivotHorizon: 120,
  /** Minimum bars required before an indicator is reported at all. */
  minBars: { ma5: 5, ma10: 10, ma20: 20, ma50: 50, ma60: 60, ma200: 200, rsi14: 15, macd: 35, atr14: 15 },
};

/** Pinned model for analysis (spec §32). `null` = use the user's current model. */
export const AI_CONFIG = {
  /** When set (e.g. 'deepseek-chat'), overrides agentDefaultModel. */
  model: null,
  provider: null,
  maxTokens: 2_400,
  temperature: 0.2,
  /** Abort budget for one analysis call. */
  timeoutMs: 120_000,
  /**
   * Recency policy (0.7.0, renamed in 0.8.0). The model is handed the age of the
   * data it reasons about and the system prompt forbids describing old data as
   * current. Round-3 renamed the youngest grade `live` → `fresh` so no code path
   * or label can claim a real-time feed that the plugin has no authorisation for:
   *   - younger than `freshMaxAgeMs`     → 'fresh'
   *   - younger than `staleWarnMs`       → 'delayed'
   *   - older than `staleHistoricalMs`   → 'historical'
   * Anything in between is 'delayed' + a stale warning.
   */
  freshMaxAgeMs: 5 * 60_000,
  staleWarnMs: 30 * 60_000,
  staleHistoricalMs: 24 * 3600_000,
};

/**
 * Inbound request policy (0.7.0). Counted per rolling window, per DSH user and
 * globally, before any upstream work starts. `expensive` buckets are the routes
 * that fan out to several upstreams or to the LLM.
 */
export const API_POLICY = {
  windowMs: 60_000,
  /** All routes, per user / globally, per window. */
  perUser: 240,
  global: 1_200,
  expensive: {
    analyze: { perUser: 20, global: 60 },
    brief: { perUser: 6, global: 30 },
    universeRefresh: { perUser: 2, global: 4 },
  },
  /** Concurrent expensive operations, per user / globally. */
  maxConcurrentAnalyses: 2,
  maxConcurrentAnalysesGlobal: 4,
  /**
   * Round-3 (P0-b): fail closed. Every `/api/trading/*` request must pass the
   * host's own request fence (`connection.requestRejection`). When that fence is
   * missing or throws, the route refuses with 503 `HOST_SECURITY_UNAVAILABLE`
   * instead of serving unauthenticated callers. Only `GET /health` still answers,
   * and it carries no user data and touches no upstream.
   */
  requireHostFence: true,
  /**
   * The single, explicit exception: a local operator debugging on this machine
   * may set `security.allowUnfencedLoopback: true`. It applies **only** to
   * loopback peers, logs loudly at start-up, and is off by default. It is never
   * switched on automatically — there is no "development mode".
   */
  allowUnfencedLoopback: false,
};

/**
 * The loopback debugging exception currently in force (0.8.0).
 *
 * `undefined` means "no operator override": the shipped default
 * (`API_POLICY.allowUnfencedLoopback === false`) applies. The override is a
 * module-level value written only by `setAllowUnfencedLoopback()` at start-up,
 * so `API_POLICY` itself stays a truthful description of the shipped default
 * and a test can still assert it.
 */
let ALLOW_UNFENCED_LOOPBACK_OVERRIDE;

/**
 * Enable or clear the loopback debugging exception. Accepts `true`/`false`
 * (and the usual string/number truthy spellings); `undefined`/`null`/`''`
 * clears it. Anything else throws, so a typo in plugin config is reported at
 * start-up instead of silently weakening the fence.
 */
export function setAllowUnfencedLoopback(value) {
  if (value === undefined || value === null || value === '') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = undefined;
    return allowUnfencedLoopback();
  }
  if (value === true || value === 'true' || value === 1 || value === '1') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = true;
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = false;
    return false;
  }
  throw new Error(`security.allowUnfencedLoopback must be true or false (got ${JSON.stringify(value)})`);
}

/** Is the loopback debugging exception in force? Defaults to the shipped `false`. */
export function allowUnfencedLoopback() {
  return ALLOW_UNFENCED_LOOPBACK_OVERRIDE === undefined
    ? API_POLICY.allowUnfencedLoopback
    : ALLOW_UNFENCED_LOOPBACK_OVERRIDE;
}

/**
 * Identity policy (0.8.0, round-3 P1⑦).
 *
 * Per-user data (watchlist, language preference) must never be filed under one
 * bucket that every browser of this DSH shares. The resolution order is:
 *
 *   1. the host's anonymous user id (`@deepseek-ai/dsh-anonymous-user-id`) —
 *      the same stable identity the harness itself persists;
 *   2. an operator-named local bucket (`identity.localBucket`), which is an
 *      explicit acknowledgement that this deployment is single-user;
 *   3. no identity at all.
 *
 * In case 3 market data still reads normally, but anything that writes per-user
 * data or is metered per user is refused with 503 `NO_IDENTITY`. The old silent
 * fallback to one shared `local` bucket is gone.
 */
export const IDENTITY_POLICY = {
  /** Operator-declared single-user bucket name, or null (not declared). */
  localBucket: null,
  /** Refuse per-user writes when the identity is unknown. */
  rejectWritesWithoutIdentity: true,
};

export const DISCLAIMER =
  'Market data and AI analysis are provided for informational purposes only and should not be considered financial advice.';

/**
 * Languages the UI (and therefore the AI output) can switch between. The
 * published spec carries no localisation section; this is the layer added in
 * 0.2.2 so the panel follows the DSH interface language and stays switchable.
 * All Chinese variants (`zh-CN`, `zh-TW`, `zh-Hans`, `zh_Hant`) normalise to the
 * single shipped `zh` dictionary.
 */
export const SUPPORTED_LANGS = ['en', 'zh'];
export const DEFAULT_LANG = 'en';

/** Anything locale-ish → a shipped language id, or `null` when unsupported. */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (primary === 'zh') return 'zh';
  if (primary === 'en') return 'en';
  return null;
}

/**
 * Last-resort *display* bucket only. Since 0.8.0 this is **not** used to file
 * per-user data: an unknown identity is reported as unknown and per-user writes
 * are refused (`IDENTITY_POLICY`), instead of silently sharing one bucket between
 * every browser that talks to this DSH.
 */
export const DEFAULT_USER = 'local';

/**
 * Full-universe browse configuration (added in 0.4.0).
 *
 * The remote search endpoint only ever answers a relevance slice of the whole
 * market, which left most US/HK listings unreachable from "Add Stock". The bulk
 * `clist` feed pages through every listed venue instead, so the browser and the
 * local search can cover the complete US/HK listing universe.
 *
 * `fs` values were measured live: US venues 105/106/107 (13,839 securities) and
 * the three HK equity boards (main 2,619 + GEM 315 + funds/REITs 490 = 3,424).
 * HK bonds (`t:2`), warrants (`t:6`) and callable bull/bear contracts (`t:5`)
 * are deliberately excluded: they are derivatives, not stocks, and would add
 * ~13,900 rows the assistant must never present as a company.
 */
export const UNIVERSE_BOARDS = {
  US: [
    { id: 'NASDAQ', label: 'NASDAQ', fs: 'm:105', exchange: 'NASDAQ' },
    { id: 'NYSE', label: 'NYSE', fs: 'm:106', exchange: 'NYSE' },
    { id: 'AMEX', label: 'AMEX', fs: 'm:107', exchange: 'AMEX' },
  ],
  HK: [
    { id: 'MAIN', label: '主板 Main Board', fs: 'm:116+t:3', exchange: 'HKEX' },
    { id: 'GEM', label: 'GEM', fs: 'm:116+t:4', exchange: 'HKEX' },
    { id: 'FUND', label: '基金/信托 Funds & REITs', fs: 'm:116+t:1', exchange: 'HKEX' },
  ],
  /**
   * Mainland China (0.5.0). `fs` is the eastmoney board filter; `sinaNode` is the
   * Sina node that serves the same list and answers when eastmoney refuses
   * (measured: `sh_a` 2,319 · `kcb` 618 · `sz_a` 2,904 · `cyb` 1,409 · `hs_bjs`
   * 348, versus eastmoney's 1,846 / 621 / 1,642 / 1,453 / 359). The Sina nodes
   * are supersets — `sh_a` also carries STAR issues — which is why they are the
   * fallback rather than the primary.
   */
  CN: [
    { id: 'SH-MAIN', label: '沪市主板 Shanghai Main Board', fs: 'm:1+t:2', exchange: 'SSE', sinaNode: 'sh_a' },
    { id: 'SH-STAR', label: '科创板 STAR Market', fs: 'm:1+t:23', exchange: 'SSE', sinaNode: 'kcb' },
    { id: 'SZ-MAIN', label: '深市主板 Shenzhen Main Board', fs: 'm:0+t:6', exchange: 'SZSE', sinaNode: 'sz_a' },
    { id: 'SZ-GEM', label: '创业板 ChiNext', fs: 'm:0+t:80', exchange: 'SZSE', sinaNode: 'cyb' },
    { id: 'BJ', label: '北交所 Beijing Stock Exchange', fs: 'm:0+t:81+s:2048', exchange: 'BSE', sinaNode: 'hs_bjs' },
  ],
  /**
   * Japan (0.5.0): eastmoney's Tokyo market number — `176.7203` is Toyota, and
   * Tokyo quotes/quotes-history are verified. The Tokyo *list* could not be
   * confirmed while eastmoney's `clist` was refusing connections; when the feed
   * refuses, the browser reports the feed as unavailable and falls back to
   * search instead of inventing rows.
   */
  JP: [{ id: 'JPX', label: '东京证券交易所 Tokyo Stock Exchange', fs: 'm:176', exchange: 'JPX' }],
  /**
   * Crypto (0.5.0): one board — the ranked coin directory (CoinLore
   * `/api/tickers/`, 100 per page), enriched with the exchange name dictionary
   * and the shipped Chinese names.
   */
  CRYPTO: [{ id: 'TOP', label: '市值排名 Top coins by market capitalisation', exchange: 'CRYPTO' }],
};

/** The bulk feed silently truncates anything above 100 rows per page. */
export const UNIVERSE_PAGE_SIZE = 100;
export const UNIVERSE_PAGE_LIMIT = 200;

/**
 * Wall-clock budget for one full universe refresh (0.7.0). A refresh walks every
 * board of every market page by page; on a bad network that can run for a long
 * time. When the budget is spent the run stops cleanly, keeps the rows already
 * absorbed, and reports `complete: false` plus a reason instead of hanging the
 * caller or the UI forever.
 */
export const UNIVERSE_POLICY = {
  budgetMs: 15 * 60_000,
  /** Minimum gap between two accepted refresh starts (in addition to the quota). */
  minRestartIntervalMs: 30_000,
};

/**
 * Listing-provider preference per market (0.4.1).
 *
 * Eastmoney's `clist` is the richest feed (Chinese names, board and industry per
 * row) but it is also the one most likely to be refused, so each market carries a
 * second feed that is verified reachable from the same network. The universe
 * layer walks this list in order and remembers which provider answered.
 */
export const UNIVERSE_PROVIDERS = {
  US: ['eastmoney', 'nasdaq'],
  HK: ['eastmoney', 'sina'],
  /** Sina's node lists keep answering while eastmoney's `clist` hangs up. */
  CN: ['sina', 'eastmoney'],
  JP: ['eastmoney'],
  CRYPTO: ['coinlore', 'binance'],
};

/** Boards of one market, in display order. */
export function universeBoards(market) {
  const boards = UNIVERSE_BOARDS[market];
  return boards ? boards.slice() : [];
}

/** Resolve a board id (`NASDAQ`, `m:105`) or fall back to the market's first board. */
export function universeBoard(market, board) {
  const boards = universeBoards(market);
  if (!boards.length) throw new Error(`unsupported universe market: ${market}`);
  if (board === undefined || board === null || board === '') return boards[0];
  const raw = String(board).trim();
  const hit = boards.find((b) => b.id.toUpperCase() === raw.toUpperCase() || b.fs === raw);
  if (!hit) throw new Error(`unknown board ${raw} for ${market}`);
  return hit;
}

/** Security classes the remote *search* endpoint may return (measured live). */
export const SEARCH_SECURITY_TYPES = new Set(['1', '3', '4', '5']);
export const SEARCH_RESULT_LIMIT = 100;

/**
 * Minimum bars a candle response must carry before the router treats it as
 * *serving the range*.
 *
 * Measured: with the eastmoney kline feed refused, the chain fell through to
 * Tencent, whose US kline endpoint ignores the bar count and answers two rows —
 * a "successful" answer that renders an empty chart. A response carrying a
 * token handful of bars is treated as a failed attempt so the next provider is
 * tried; if no provider clears the bar the best attempt is still returned, so a
 * genuinely young listing (which has few bars to give) never loses its data.
 */
export function minBars(range, interval, market) {
  const days = rangeDays(range, market);
  const limit = candleLimit(range, interval, market);
  return Math.max(5, Math.min(limit, Math.round(days / 10) + 4));
}

/** Persisted universe snapshots stay well under the storage budget. */
export const MAX_UNIVERSE_BYTES = 12 * 1024 * 1024;

/** Default watchlist shipped with the onboarding seed (spec §24/§56). */
export const SEED_WATCHLIST = {
  US: ['AAPL', 'NVDA', 'TSLA'],
  HK: ['0700.HK', '9988.HK'],
  CN: ['600519.SH', '000001.SZ'],
  JP: ['7203.T'],
  CRYPTO: ['BTC', 'ETH'],
  ALL: [
    'AAPL', 'NVDA', 'TSLA',
    '0700.HK', '9988.HK',
    '600519.SH', '000001.SZ',
    '7203.T',
    'BTC', 'ETH',
  ],
};

/**
 * Onboarding recommendation pool (spec §24). Offered as suggestions only — the
 * user must still add each one explicitly, so nothing is implied to be owned.
 */
export const RECOMMENDED_STARTERS = {
  US: ['AAPL', 'NVDA', 'TSLA', 'META', 'MSFT'],
  HK: ['0700.HK', '9988.HK', '3690.HK', '1810.HK'],
  CN: ['600519.SH', '000001.SZ', '300750.SZ', '601318.SH'],
  JP: ['7203.T', '6758.T', '9984.T', '8306.T'],
  CRYPTO: ['BTC', 'ETH', 'BNB', 'SOL'],
  ALL: [
    'AAPL', 'NVDA', 'TSLA', 'META', 'MSFT',
    '0700.HK', '9988.HK', '3690.HK', '1810.HK',
    '600519.SH', '000001.SZ', '300750.SZ', '601318.SH',
    '7203.T', '6758.T', '9984.T', '8306.T',
    'BTC', 'ETH', 'BNB', 'SOL',
  ],
};

/**
 * ── Provider chains (0.6.0, publication task B1) ────────────────────────────
 * `MARKET_DATA_CONFIG` above is the *conservative default*: the order that was
 * measured to work from a mainland-China home network on 2026-10-07. A user on a
 * different network can reorder or trim a market's chain from the plugin config
 * without patching source:
 *
 *   - id: trading-mode
 *     config:
 *       providers:
 *         US: ['nasdaq', 'stooq']
 *
 * Validation is strict and *reported*, never silent: an unknown market, an
 * unknown provider id, a duplicate or an empty chain is rejected with a message
 * that lists the accepted values, and the defaults stay in force.
 */
const CHAIN_OVERRIDES = new Map();
let CHAIN_OVERRIDE_PROBLEMS = [];

/** Every provider id the plugin ships. */
export function providerIds() {
  return Object.keys(PROVIDER_CONFIG);
}

/** Validate a `providers` config block. Returns `{ chains, problems }`. */
export function validateProviderChains(overrides) {
  const problems = [];
  const chains = {};
  if (overrides === undefined || overrides === null) return { chains, problems };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    problems.push(
      `providers must be an object that maps a market to an ordered provider list (got ${Array.isArray(overrides) ? 'array' : typeof overrides})`,
    );
    return { chains, problems };
  }
  for (const [market, value] of Object.entries(overrides)) {
    if (!MARKETS.includes(market)) {
      problems.push(`providers.${market}: unknown market (accepted: ${MARKETS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(value)) {
      problems.push(`providers.${market}: expected an array of provider ids (accepted: ${providerIds().join(', ')})`);
      continue;
    }
    if (!value.length) {
      problems.push(`providers.${market}: the chain must list at least one provider (accepted: ${providerIds().join(', ')})`);
      continue;
    }
    const seen = new Set();
    let bad = false;
    for (const id of value) {
      if (typeof id !== 'string' || !PROVIDER_CONFIG[id]) {
        problems.push(`providers.${market}: unknown provider ${JSON.stringify(id)} (accepted: ${providerIds().join(', ')})`);
        bad = true;
        continue;
      }
      if (seen.has(id)) {
        problems.push(`providers.${market}: provider ${id} is listed twice`);
        bad = true;
        continue;
      }
      seen.add(id);
    }
    if (!bad) chains[market] = value.slice();
  }
  return { chains, problems };
}

/**
 * Apply a `providers` config block. Valid markets replace their default chain;
 * invalid entries are reported through the returned `problems` and ignored.
 */
export function applyProviderChains(overrides) {
  const { chains, problems } = validateProviderChains(overrides);
  CHAIN_OVERRIDES.clear();
  for (const [market, chain] of Object.entries(chains)) CHAIN_OVERRIDES.set(market, chain);
  CHAIN_OVERRIDE_PROBLEMS = problems;
  return { applied: Object.keys(chains), problems };
}

/** Problems found by the last `applyProviderChains` call. */
export function providerChainProblems() {
  return CHAIN_OVERRIDE_PROBLEMS.slice();
}

/** The active overrides, as a plain object. */
export function chainOverrides() {
  return Object.fromEntries([...CHAIN_OVERRIDES].map(([market, chain]) => [market, chain.slice()]));
}

/** The active, ordered provider chain for a market. */
export function providerChain(market) {
  const defaults = MARKET_DATA_CONFIG[market];
  if (!defaults) throw new Error(`unsupported market: ${market}`);
  const override = CHAIN_OVERRIDES.get(market);
  return (override || defaults.chain).slice();
}

export function marketConfig(market) {
  const cfg = MARKET_DATA_CONFIG[market];
  if (!cfg) throw new Error(`unsupported market: ${market}`);
  return { ...cfg, chain: providerChain(market) };
}

export function providerConfig(id) {
  const cfg = PROVIDER_CONFIG[id];
  if (!cfg) throw new Error(`unknown market data provider: ${id}`);
  return cfg;
}
