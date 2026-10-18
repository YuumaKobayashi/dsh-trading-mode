/**
 * Symbol Directory (spec §23).
 *
 * A single place that maps whatever the user typed — a ticker, an English name,
 * a Chinese name, or a bare HK number — onto the canonical unified symbol
 * (§17/§22), and that enriches the display with names the market data providers
 * may not return.
 *
 * The seed table covers the acceptance list of §22/§24 so search keeps working
 * even when the upstream suggest endpoint is unreachable; live search results are
 * merged in at runtime and take precedence.
 */

import { currencyOf, exchangeOf, parseSymbol } from './symbols.js';

/** True when a string contains Han characters. */
export function hasCjk(value) {
  return typeof value === 'string' && /[\u3400-\u9fff\uf900-\ufaff]/.test(value);
}

/**
 * Keep `name` English and `nameZh` Chinese (§17). US quotes from the upstream
 * providers arrive with the Chinese name only, so without this the detail page
 * would show "苹果" as the company name and lose the English one entirely.
 *
 * @param {{name?: string, nameZh?: string}} record
 * @param {{symbol?: string, name?: string, nameZh?: string}} known
 */
export function splitNames(record = {}, known = {}) {
  let name = record.name && record.name !== record.symbol ? record.name : null;
  let nameZh = record.nameZh || null;
  if (hasCjk(name)) {
    if (!nameZh) nameZh = name;
    const english = known.name && known.name !== known.symbol && !hasCjk(known.name) ? known.name : null;
    if (english) name = english;
  }
  if (!name && known.name && known.name !== known.symbol) name = known.name;
  if (!nameZh && known.nameZh) nameZh = known.nameZh;
  const out = { name: name || record.name || known.name || null };
  // Never emit an empty key: `nameZh: undefined` would survive into JSON.
  if (nameZh) out.nameZh = nameZh;
  return out;
}

/**
 * @typedef {{symbol: string, name: string, nameZh?: string, exchange: string, aliases?: string[]}} DirectoryEntry
 */

/** @type {DirectoryEntry[]} */
export const SEED_DIRECTORY = [
  { symbol: 'AAPL', name: 'Apple Inc.', nameZh: '苹果', exchange: 'NASDAQ', aliases: ['apple'] },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', nameZh: '英伟达', exchange: 'NASDAQ', aliases: ['nvidia'] },
  { symbol: 'TSLA', name: 'Tesla, Inc.', nameZh: '特斯拉', exchange: 'NASDAQ', aliases: ['tesla'] },
  { symbol: 'META', name: 'Meta Platforms, Inc.', nameZh: 'Meta', exchange: 'NASDAQ', aliases: ['facebook'] },
  { symbol: 'MSFT', name: 'Microsoft Corporation', nameZh: '微软', exchange: 'NASDAQ', aliases: ['microsoft'] },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', nameZh: '谷歌', exchange: 'NASDAQ', aliases: ['google', 'alphabet'] },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', nameZh: '亚马逊', exchange: 'NASDAQ', aliases: ['amazon'] },
  { symbol: 'BABA', name: 'Alibaba Group Holding Limited', nameZh: '阿里巴巴', exchange: 'NYSE', aliases: ['alibaba'] },
  { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.', nameZh: '超威半导体', exchange: 'NASDAQ' },
  { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing', nameZh: '台积电', exchange: 'NYSE' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', nameZh: '博通', exchange: 'NASDAQ' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', nameZh: '好市多', exchange: 'NASDAQ' },
  { symbol: '0700.HK', name: 'Tencent Holdings Ltd', nameZh: '腾讯控股', exchange: 'HKEX', aliases: ['tencent', '腾讯'] },
  { symbol: '9988.HK', name: 'Alibaba Group Holding Ltd', nameZh: '阿里巴巴-W', exchange: 'HKEX', aliases: ['alibaba', '阿里'] },
  { symbol: '3690.HK', name: 'Meituan', nameZh: '美团-W', exchange: 'HKEX', aliases: ['meituan', '美团'] },
  { symbol: '1810.HK', name: 'Xiaomi Corporation', nameZh: '小米集团-W', exchange: 'HKEX', aliases: ['xiaomi', '小米'] },
  { symbol: '0941.HK', name: 'China Mobile Limited', nameZh: '中国移动', exchange: 'HKEX' },
  { symbol: '0005.HK', name: 'HSBC Holdings plc', nameZh: '汇丰控股', exchange: 'HKEX' },
  { symbol: '1299.HK', name: 'AIA Group Limited', nameZh: '友邦保险', exchange: 'HKEX' },
  { symbol: '0388.HK', name: 'Hong Kong Exchanges and Clearing', nameZh: '香港交易所', exchange: 'HKEX' },
  { symbol: '2318.HK', name: 'Ping An Insurance', nameZh: '中国平安', exchange: 'HKEX' },
  { symbol: '1211.HK', name: 'BYD Company Limited', nameZh: '比亚迪股份', exchange: 'HKEX' },
  // A-share leaders. The upstream suggest feed only answers a Chinese name or the
  // six-digit code, so seeding the names keeps A-share search working in both
  // languages (and offline) the way the US/HK entries do.
  { symbol: '600519.SH', name: 'Kweichow Moutai Co., Ltd.', nameZh: '贵州茅台', exchange: 'SSE', aliases: ['moutai', '茅台'] },
  { symbol: '000001.SZ', name: 'Ping An Bank Co., Ltd.', nameZh: '平安银行', exchange: 'SZSE', aliases: ['ping an bank'] },
  { symbol: '601318.SH', name: 'Ping An Insurance (Group) Company of China', nameZh: '中国平安', exchange: 'SSE', aliases: ['ping an insurance'] },
  { symbol: '600036.SH', name: 'China Merchants Bank Co., Ltd.', nameZh: '招商银行', exchange: 'SSE', aliases: ['china merchants bank'] },
  { symbol: '000858.SZ', name: 'Wuliangye Yibin Co., Ltd.', nameZh: '五粮液', exchange: 'SZSE', aliases: ['wuliangye'] },
  { symbol: '300750.SZ', name: 'Contemporary Amperex Technology Co., Limited', nameZh: '宁德时代', exchange: 'SZSE', aliases: ['catl', '宁德时代'] },
  // TSE heavyweights. Eastmoney's suggest feed answers a Tokyo code (`7203`) or a
  // Chinese name (`丰田`) but **nothing** for the kana spelling (`トヨタ` → 0 rows),
  // which is the natural way to search in Japanese. Those rows are seeded locally,
  // with the kana and rōmaji spellings as aliases, so `トヨタ` / `トヨタ自動車` /
  // `ソニー` resolve without depending on a feed that cannot answer them.
  { symbol: '7203.T', name: 'Toyota Motor Corporation', nameZh: '丰田汽车', exchange: 'JPX', aliases: ['toyota', 'トヨタ', 'トヨタ自動車', '丰田'] },
  { symbol: '6758.T', name: 'Sony Group Corporation', nameZh: '索尼', exchange: 'JPX', aliases: ['sony', 'ソニー', 'ソニーグループ'] },
  { symbol: '6861.T', name: 'Keyence Corporation', nameZh: '基恩士', exchange: 'JPX', aliases: ['keyence', 'キーエンス'] },
  { symbol: '9984.T', name: 'SoftBank Group Corp.', nameZh: '软银集团', exchange: 'JPX', aliases: ['softbank', 'ソフトバンク'] },
  { symbol: '8306.T', name: 'Mitsubishi UFJ Financial Group, Inc.', nameZh: '三菱日联金融', exchange: 'JPX', aliases: ['mufg', 'mitsubishi ufj', '三菱ufjフィナンシャル・グループ', '三菱ufj'] },
  { symbol: '9432.T', name: 'Nippon Telegraph and Telephone Corporation', nameZh: '日本电信电话', exchange: 'JPX', aliases: ['ntt', '日本電信電話'] },
  { symbol: '6098.T', name: 'Recruit Holdings Co., Ltd.', nameZh: '瑞可利', exchange: 'JPX', aliases: ['recruit', 'リクルート'] },
  { symbol: '4063.T', name: 'Shin-Etsu Chemical Co., Ltd.', nameZh: '信越化学', exchange: 'JPX', aliases: ['shin-etsu', '信越化学工業'] },
  { symbol: '8035.T', name: 'Tokyo Electron Limited', nameZh: '东京电子', exchange: 'JPX', aliases: ['tokyo electron', '東京エレクトロン'] },
  { symbol: '9983.T', name: 'Fast Retailing Co., Ltd.', nameZh: '迅销', exchange: 'JPX', aliases: ['fast retailing', 'ファーストリテイリング', 'ユニクロ', '优衣库'] },
  { symbol: '7974.T', name: 'Nintendo Co., Ltd.', nameZh: '任天堂', exchange: 'JPX', aliases: ['nintendo', '任天堂'] },
  { symbol: '6501.T', name: 'Hitachi, Ltd.', nameZh: '日立', exchange: 'JPX', aliases: ['hitachi', '日立製作所'] },
  { symbol: '7267.T', name: 'Honda Motor Co., Ltd.', nameZh: '本田汽车', exchange: 'JPX', aliases: ['honda', 'ホンダ', '本田技研工業'] },
  { symbol: '4502.T', name: 'Takeda Pharmaceutical Company Limited', nameZh: '武田药品', exchange: 'JPX', aliases: ['takeda', '武田薬品工業'] },
  { symbol: '6981.T', name: 'Murata Manufacturing Co., Ltd.', nameZh: '村田制作所', exchange: 'JPX', aliases: ['murata', '村田製作所'] },
  { symbol: '8316.T', name: 'Sumitomo Mitsui Financial Group, Inc.', nameZh: '三井住友金融', exchange: 'JPX', aliases: ['smfg', '三井住友フィナンシャルグループ'] },
  { symbol: '8058.T', name: 'Mitsubishi Corporation', nameZh: '三菱商事', exchange: 'JPX', aliases: ['mitsubishi corp', '三菱商事'] },
  { symbol: '8031.T', name: 'Mitsui & Co., Ltd.', nameZh: '三井物产', exchange: 'JPX', aliases: ['mitsui', '三井物産'] },
  { symbol: '9433.T', name: 'KDDI Corporation', nameZh: 'KDDI', exchange: 'JPX', aliases: ['kddi'] },
  { symbol: '4661.T', name: 'Oriental Land Co., Ltd.', nameZh: '东方乐园', exchange: 'JPX', aliases: ['oriental land', 'オリエンタルランド'] },
  { symbol: '6367.T', name: 'Daikin Industries, Ltd.', nameZh: '大金工业', exchange: 'JPX', aliases: ['daikin', 'ダイキン工業'] },
  { symbol: '6702.T', name: 'Fujitsu Limited', nameZh: '富士通', exchange: 'JPX', aliases: ['fujitsu', '富士通'] },
  { symbol: '5108.T', name: 'Bridgestone Corporation', nameZh: '普利司通', exchange: 'JPX', aliases: ['bridgestone', 'ブリヂストン'] },
  { symbol: '2914.T', name: 'Japan Tobacco Inc.', nameZh: '日本烟草', exchange: 'JPX', aliases: ['japan tobacco', '日本たばこ産業'] },
  { symbol: '6954.T', name: 'Fanuc Corporation', nameZh: '发那科', exchange: 'JPX', aliases: ['fanuc', 'ファナック'] },
  { symbol: '4901.T', name: 'Fujifilm Holdings Corporation', nameZh: '富士胶片', exchange: 'JPX', aliases: ['fujifilm', '富士フイルム'] },
  { symbol: '8766.T', name: 'Tokio Marine Holdings, Inc.', nameZh: '东京海上', exchange: 'JPX', aliases: ['tokio marine', '東京海上ホールディングス'] },
];

export class SymbolDirectory {
  /**
   * @param {{entries?: DirectoryEntry[], logger?: any}} [opts]
   */
  constructor(opts = {}) {
    this.logger = opts.logger || null;
    this.bySymbol = new Map();
    /** Free-text index: lowercase alias/name → symbol. */
    this.index = new Map();
    for (const entry of opts.entries || SEED_DIRECTORY) this.put(entry);
  }

  /** Insert or enrich an entry (live provider results win over the seed). */
  put(entry) {
    if (!entry || !entry.symbol) return null;
    let parsed;
    try {
      parsed = parseSymbol(entry.symbol, entry.market);
    } catch {
      return null;
    }
    const existing = this.bySymbol.get(parsed.symbol);
    const merged = {
      symbol: parsed.symbol,
      name: entry.name || (existing && existing.name) || parsed.symbol,
      ...(entry.nameZh || (existing && existing.nameZh) ? { nameZh: entry.nameZh || existing.nameZh } : {}),
      market: parsed.market,
      exchange: entry.exchange || (existing && existing.exchange) || exchangeOf(parsed.market, parsed.board),
      currency: entry.currency || (existing && existing.currency) || currencyOf(parsed.market),
      aliases: [...new Set([...(existing?.aliases || []), ...(entry.aliases || [])])],
    };
    this.bySymbol.set(parsed.symbol, merged);
    for (const key of this.keysOf(merged)) if (!this.index.has(key)) this.index.set(key, parsed.symbol);
    return merged;
  }

  keysOf(entry) {
    const keys = new Set();
    const add = (v) => {
      if (typeof v === 'string' && v.trim()) keys.add(v.trim().toLowerCase());
    };
    add(entry.symbol);
    add(entry.symbol.replace(/\.HK$/i, ''));
    add(entry.name);
    add(entry.nameZh);
    for (const alias of entry.aliases || []) add(alias);
    // The first word of an English company name ("Apple" from "Apple Inc.").
    if (entry.name && /^[A-Za-z]/.test(entry.name)) add(entry.name.split(/[\s,.]+/)[0]);
    return keys;
  }

  /**
   * Canonical record for a symbol, or a minimal synthesised one.
   *
   * `market` is an optional hint: a bare `BTC` or `SOL` is indistinguishable from
   * a US ticker, so callers that already know the market must say so or the record
   * comes back as a NASDAQ/USD listing.
   */
  lookup(symbol, market) {
    let parsed;
    try {
      parsed = parseSymbol(symbol, market);
    } catch {
      return null;
    }
    const found = this.bySymbol.get(parsed.symbol);
    if (found) return { ...found };
    return {
      symbol: parsed.symbol,
      name: parsed.symbol,
      market: parsed.market,
      exchange: exchangeOf(parsed.market, parsed.board),
      currency: currencyOf(parsed.market),
      aliases: [],
    };
  }

  /** Enrich an arbitrary result set with directory names. */
  enrich(records) {
    return (records || []).map((record) => {
      const known = this.lookup(record.symbol, record.market);
      if (!known) return record;
      // A US default currency on a non-US row (providers often send none) is a bug,
      // not information: fall back to the currency of the record's own market.
      const marketCurrency = currencyOf(record.market || known.market);
      const currency = record.currency && record.currency !== 'USD' ? record.currency : marketCurrency;
      const merged = { ...record, ...splitNames(record, known), exchange: record.exchange || known.exchange, currency };
      this.put(merged);
      return merged;
    });
  }

  /**
   * Offline/local search across the directory. Providers are still asked first;
   * this exists so the §22 acceptance queries (Chinese names, bare HK numbers)
   * resolve even without a reachable suggest endpoint.
   */
  search(query, market, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const exact = this.index.get(q);
    const hits = [];
    const seen = new Set();
    if (exact) {
      const record = this.lookup(exact);
      if (record && (!market || record.market === market)) {
        hits.push(record);
        seen.add(record.symbol);
      }
    }
    for (const entry of this.bySymbol.values()) {
      if (hits.length >= limit) break;
      if (seen.has(entry.symbol)) continue;
      if (market && entry.market !== market) continue;
      const haystack = [entry.symbol, entry.symbol.replace(/\.HK$/i, ''), entry.name, entry.nameZh, ...(entry.aliases || [])]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      if (haystack.some((v) => v.startsWith(q) || v.includes(q))) {
        hits.push({ ...entry });
        seen.add(entry.symbol);
      }
    }
    return hits.slice(0, limit);
  }

  get size() {
    return this.bySymbol.size;
  }

  toJSON() {
    return [...this.bySymbol.values()];
  }
}
