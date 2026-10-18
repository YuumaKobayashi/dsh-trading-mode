/**
 * CoinLore provider — the crypto *directory* (added in 0.5.0).
 *
 * CoinLore is not a price source for this plugin and never will be: its prices
 * carry no observation timestamp and differ from the exchange quotes by roughly
 * 0.2 %, so a quote taken from here could not be graded for staleness and would
 * silently disagree with the chart beside it. What it does publish, better than
 * anything else reachable, is the ranked coin table — symbol, English name, rank,
 * market capitalisation and 24 h turnover, 100 rows per page.
 *
 * So this provider carries exactly three capabilities: `search` (a *local* filter
 * over the cached table, because CoinLore has no search endpoint), `profile`
 * (rank / market cap / a generic crypto description) and `universe` (the listing
 * browser).
 *
 * **Chinese names.** No reachable feed publishes them, and inventing a translation
 * for a ticker nobody recognises would put a fabricated name in front of the user,
 * so `CRYPTO_ZH` below is a hand-written table of the coins whose Chinese names are
 * established and unambiguous. A coin missing from the table simply gets no
 * `nameZh` — never a transliteration of its ticker (§14/§16).
 */

import { PROVIDER_CONFIG, providerConfig, universeBoards } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { MarketDataProvider, makeProfile } from '../schema.js';
import { parseSymbol } from '../symbols.js';

/**
 * Established Chinese names for the coins a user is most likely to hold.
 * Deliberately short and conservative: if a name is not certain, it is absent.
 * @type {Record<string, string>}
 */
export const CRYPTO_ZH = {
  BTC: '比特币',
  ETH: '以太坊',
  USDT: '泰达币',
  BNB: '币安币',
  SOL: '索拉纳',
  XRP: '瑞波币',
  USDC: '美元币',
  ADA: '艾达币',
  DOGE: '狗狗币',
  TRX: '波场',
  AVAX: '雪崩',
  LINK: '链环',
  DOT: '波卡',
  MATIC: '马蹄',
  POL: '马蹄',
  SHIB: '柴犬币',
  LTC: '莱特币',
  BCH: '比特现金',
  TON: '开放网络',
  XLM: '恒星币',
  UNI: '独角兽',
  ATOM: '宇宙币',
  ETC: '以太经典',
  FIL: '文件币',
  APT: '阿普托斯',
  ARB: '阿比特龙',
  OP: '乐观币',
  NEAR: '近协议',
  ICP: '互联网计算机',
  VET: '唯链',
  HBAR: '哈希图',
  ALGO: '阿尔戈兰德',
  XMR: '门罗币',
  EOS: '柚子币',
  AAVE: '阿维',
  MKR: 'Maker',
  CRO: '克罗诺斯',
  OKB: '欧易币',
  BSV: '比特聪',
  XTZ: '泰卓斯',
  SAND: '沙盒',
  MANA: '去中心化之地',
  GRT: '图协议',
  THETA: '西塔',
  EGLD: '埃格罗德',
  FTM: '幻影',
  AXS: '阿蟹',
  RNDR: '渲染网络',
  IMX: '不可变X',
  INJ: '英杰蒂夫',
  STX: '斯塔克斯',
  SUI: '隋',
  SEI: '赛',
  TIA: '天界',
  PEPE: '佩佩蛙',
  WIF: '戴帽狗',
  BONK: '邦克',
  LDO: '丽都',
  QNT: '量网',
  KAS: '卡斯帕',
  RUNE: '雷神',
  GALA: '加拉',
  CHZ: '啾币',
  ZEC: '零币',
  DASH: '达世币',
  NEO: '小蚁',
  QTUM: '量子链',
  IOTA: '埃欧塔',
  WAVES: '波浪',
  KSM: '草间',
  ONE: '和谐',
  CAKE: '薄饼',
  APE: '猿币',
  CRV: '曲线',
  SNX: '合成资产',
  COMP: '复合',
  ENJ: '恩金',
  BAT: '基本注意力代币',
  ZIL: '齐利卡',
  HOT: '霍洛',
  DCR: '德雷德',
  RVN: '渡鸦币',
  XEC: '电子现金',
  FLOW: '流',
  CFX: '树图',
  ROSE: '绿洲',
  FET: '费奇',
  AR: '阿维弗',
  HNT: '氦网络',
  JUP: '木星',
  PYTH: '皮提亚',
  WLD: '世界币',
  ORDI: '奥迪',
  MEME: '迷因币',
  FLOKI: '弗洛基',
  TWT: '信任钱包',
  GT: '盖特币',
  HT: '火币',
  KCS: '库币',
};

/** Alias so other modules can import the map under the provider's own name. */
export const COINLORE_ZH = CRYPTO_ZH;

/** How long the cached coin table is served before it is re-fetched. */
const TABLE_TTL_MS = 10 * 60_000;
/** CoinLore silently caps a page at 100 rows. */
const UPSTREAM_PAGE_SIZE = 100;
/** Rows collected before the directory is considered complete enough. */
const MAX_ROWS = 1_000;
/** Upper bound on upstream paging, so a feed that ignores `start` cannot loop. */
const MAX_PAGES = 12;
/** Fallback board if the shared crypto board config is ever emptied. */
const LISTING_BOARD = { id: 'TOP', label: 'Crypto — all spot pairs', exchange: 'CRYPTO' };

/** CoinLore embeds markup in some names (`<a href=…>BTC</a>`); keep the text only. */
function cleanName(value) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export class CoinLoreProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'coinlore', label: PROVIDER_CONFIG.coinlore.label, ...opts });
    this.capabilities = { search: true, quote: false, candles: false, profile: true, universe: true };
    this.markets = ['CRYPTO'];
    this.listingMarkets = ['CRYPTO'];
    /** It answers no candle request at all. */
    this.intervals = PROVIDER_CONFIG.coinlore.intervals;
    /** `{rows, fetchedAt}` — refreshed when the TTL lapses. */
    this.table = null;
    /** In-flight fetch, so concurrent searches share one upstream walk. */
    this.loading = null;
  }

  /**
   * Coin names only. `name` stays the English name and `nameZh` is present only
   * when the shipped table knows the coin.
   */
  static nameOf(symbol) {
    const code = String(symbol || '').toUpperCase();
    return CRYPTO_ZH[code];
  }

  supportsSymbol(symbol, feature) {
    let parsed;
    try {
      parsed = parseSymbol(symbol, 'CRYPTO');
    } catch {
      return false;
    }
    return parsed.market === 'CRYPTO';
  }

  /**
   * The coin table, one upstream request per 100 rows until `MAX_ROWS` or the
   * feed runs out. Cached under a TTL because search, profile and the listing
   * browser all want the same rows.
   */
  async fetchTable() {
    const cfg = providerConfig('coinlore');
    const rows = [];
    for (let page = 0; page < MAX_PAGES && rows.length < MAX_ROWS; page += 1) {
      const start = page * UPSTREAM_PAGE_SIZE;
      const url = `${cfg.base}${cfg.tickersPath}?start=${start}&limit=${UPSTREAM_PAGE_SIZE}`;
      const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
      const payload = res.json;
      const data = payload && Array.isArray(payload.data) ? payload.data : null;
      if (!data) {
        throw new TradingError(CODES.DATA_UNAVAILABLE, `coinlore returned no coin table at start=${start}`, {
          provider: this.id,
        });
      }
      for (const item of data) {
        const code = String((item && item.symbol) || '').trim().toUpperCase();
        if (!code) continue;
        let parsed;
        try {
          parsed = parseSymbol(code, 'CRYPTO');
        } catch {
          continue;
        }
        if (parsed.market !== 'CRYPTO') continue;
        const rank = num(item.rank);
        const name = cleanName(item.name) || parsed.symbol;
        const nameZh = CRYPTO_ZH[parsed.symbol];
        rows.push({
          symbol: parsed.symbol,
          code: parsed.code,
          name,
          ...(nameZh ? { nameZh } : {}),
          rank: rank === null ? Number.MAX_SAFE_INTEGER : Math.trunc(rank),
          priceUsd: num(item.price_usd),
          changePct24h: num(item.percent_change_24h),
          marketCap: num(item.market_cap_usd),
          volume24: num(item.volume24),
        });
      }
      if (data.length < UPSTREAM_PAGE_SIZE) break;
    }
    if (!rows.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, 'coinlore returned an empty coin table', { provider: this.id });
    }
    rows.sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
    this.table = { rows, fetchedAt: Date.now() };
    return this.table;
  }

  /** The cached table, re-fetched once its TTL lapses. */
  async getTable() {
    const fresh = this.table && Date.now() - this.table.fetchedAt < TABLE_TTL_MS;
    if (fresh) return this.table;
    if (!this.loading) {
      this.loading = this.fetchTable().finally(() => {
        this.loading = null;
      });
    }
    try {
      return await this.loading;
    } catch (err) {
      // A stale table still answers search and the listing browser; only say so
      // when there is nothing cached at all.
      if (this.table) return this.table;
      throw err;
    }
  }

  /** One cached row per canonical symbol, for the listing browser and profiles. */
  async rowsBySymbol() {
    const table = await this.getTable();
    const map = new Map();
    for (const row of table.rows) if (!map.has(row.symbol)) map.set(row.symbol, row);
    return { map, fetchedAt: table.fetchedAt };
  }

  /** Listing row shape shared by `listSecurities` and `searchStocks`. */
  listingRow(row) {
    return {
      symbol: row.symbol,
      code: row.code,
      name: row.name,
      ...(row.nameZh ? { nameZh: row.nameZh } : {}),
      market: 'CRYPTO',
      exchange: 'CRYPTO',
      board: LISTING_BOARD.id,
      kind: 'crypto',
    };
  }

  /**
   * Local, rank-ordered search. CoinLore publishes no search endpoint and no
   * Chinese names, so the query is matched against the cached symbol, the English
   * name and the shipped Chinese table; exact symbol matches come first.
   */
  async searchStocks(query, market) {
    if (market && market !== 'CRYPTO') return [];
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const { map } = await this.rowsBySymbol();
    const exact = [];
    const prefix = [];
    const contains = [];
    for (const row of map.values()) {
      const symbol = row.symbol.toLowerCase();
      const name = String(row.name || '').toLowerCase();
      const nameZh = String(row.nameZh || '');
      const zhHit = nameZh && nameZh.includes(String(query).trim());
      if (symbol === needle) {
        exact.push(row);
        continue;
      }
      if (symbol.startsWith(needle) || name.startsWith(needle) || (nameZh && nameZh.startsWith(String(query).trim()))) {
        prefix.push(row);
        continue;
      }
      if (symbol.includes(needle) || name.includes(needle) || zhHit) contains.push(row);
    }
    return exact.concat(prefix, contains).slice(0, 30).map((row) => this.listingRow(row));
  }

  /**
   * Crypto profile. There is no issuer to describe: the entry explains what the
   * asset is and reports the directory's rank and market capitalisation, with the
   * price deliberately omitted because CoinLore's price is not the quoted one.
   */
  async getProfile(symbol) {
    const parsed = parseSymbol(symbol, 'CRYPTO');
    if (parsed.market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `coinlore profiles crypto assets only (got ${parsed.symbol})`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const { map, fetchedAt } = await this.rowsBySymbol();
    const row = map.get(parsed.symbol);
    const known = map.get(parsed.ticker || parsed.symbol);
    const record = row || known || null;
    if (!record) {
      throw new TradingError(CODES.NOT_FOUND, `coinlore does not list ${parsed.symbol}`, {
        provider: this.id,
        symbol: parsed.symbol,
      });
    }
    const quote = parsed.quote || 'USDT';
    const rankText = Number.isFinite(record.rank) && record.rank !== Number.MAX_SAFE_INTEGER ? `ranked #${record.rank} by market capitalisation` : 'listed without a published rank';
    const capText =
      Number.isFinite(record.marketCap) && record.marketCap > 0
        ? `a market capitalisation of about ${Math.round(record.marketCap).toLocaleString('en-US')} USD`
        : 'no published market capitalisation';
    return makeProfile({
      symbol: parsed.symbol,
      name: record.name,
      nameZh: record.nameZh,
      market: 'CRYPTO',
      exchange: 'CRYPTO',
      currency: quote,
      description:
        `${record.name} (${parsed.symbol}) is a crypto asset quoted against ${quote} on the spot market, ` +
        `${rankText} and ${capText}. It has no issuer, no earnings and no trading session: the price is set by ` +
        'continuous 24/7 trading across exchanges, and this entry carries no price of its own.',
      marketCap: Number.isFinite(record.marketCap) ? record.marketCap : null,
      source: this.id,
      timestamp: fetchedAt,
    });
  }

  /** The service calls `getCompanyProfile` (schema contract); this is the same answer. */
  async getCompanyProfile(symbol) {
    return this.getProfile(symbol);
  }

  /** The coin directory is one board: the ranked whole-market table, paged locally. */
  boards(market) {
    if (market !== 'CRYPTO') return [];
    // The board id must be the shared one (`TOP`), otherwise the universe index
    // flags a board fallback and the client shows a board the config never named.
    const shared = universeBoards('CRYPTO');
    return (shared.length ? shared : [LISTING_BOARD]).map((b) => ({ ...b }));
  }

  async listSecurities({ market, page = 1, size = 100 } = {}) {
    if (market && market !== 'CRYPTO') {
      throw new TradingError(CODES.UNSUPPORTED_MARKET, `coinlore lists the crypto market only (got ${market})`);
    }
    const { map, fetchedAt } = await this.rowsBySymbol();
    const pz = Math.max(1, Math.trunc(Number(size)) || 100);
    const pn = Math.max(1, Math.trunc(Number(page)) || 1);
    const total = map.size;
    const offset = (pn - 1) * pz;
    const rows = [...map.values()].slice(offset, offset + pz).map((row) => this.listingRow(row));
    if (!rows.length && pn > 1) {
      throw new TradingError(CODES.NOT_FOUND, `coinlore listing page ${pn} is past the end of the table`, {
        provider: this.id,
      });
    }
    return {
      market: 'CRYPTO',
      board: LISTING_BOARD.id,
      label: LISTING_BOARD.label,
      exchange: 'CRYPTO',
      page: pn,
      size: pz,
      total,
      pages: Math.max(1, Math.ceil(total / pz)),
      hasMore: offset + pz < total,
      fetchedAt,
      rows,
    };
  }
}

export default CoinLoreProvider;
