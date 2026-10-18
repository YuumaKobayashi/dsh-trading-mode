/**
 * dsh-trading-mode / lib/client.js
 *
 * 客户端半侧。必须是一个「普通副作用脚本」：加载时调用
 * window.__ModuleLoader__.load({ id, factory })，factory 通过 require 取模块。
 * 不能有顶层 ESM export/import（react 由 factory 的 require 取得）。
 *
 * 注册内容：
 *   - 「Trading Mode」按钮 → 会话标题栏按钮行（conversation.session.header.actions）
 *   - 点击后在页面内浮层打开整个 Trading Mode 应用（shell.overlay）
 *
 * 应用结构（策划案 §25/§27）：
 *   Home  = Search Stocks + My Watchlist（价格/涨跌%）+ [ + Add Stock ] + AI Watchlist Brief
 *   Detail= 公司名/symbol/交易所/价格/涨跌幅/Updated + 区间切换 + K 线 + Market Data
 *           + Technical Indicators + AI Analysis + Ask DeepSeek + TradingView（保留原功能）
 *
 * 所有行情一律来自 /api/trading（§50：前端不直连任何数据源，不解析第三方字段）。
 * 行情新鲜度只说 "Updated …" / "Data may be delayed" / "Last available data"，
 * 绝不宣称 Live / Real-time（§21）。
 *
 * 语言：英文是源语言，字典以「英文字面量」为 key，缺翻译时回落到英文而不是裸露 key。
 * 默认跟随 DSH 的 locale（ctx.get('locale')），也可在面板右上角手动切换 EN / 中文；
 * 手动选择通过 PATCH /api/trading/settings 持久化，并同时决定 AI 分析输出语言。
 */

window.__ModuleLoader__.load({
  id: 'dsh-trading-mode',
  factory: (require) => {
    const react = require('react')
    const { createElement: h, useState, useEffect, useMemo, useRef, useCallback } = react

    // ------------------------------------------------------------------ config
    const API_BASE = '/api/trading'
    const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y']
    const RANGE_LABEL = { '1d': '1D', '5d': '5D', '1mo': '1M', '3mo': '3M', '6mo': '6M', '1y': '1Y', '5y': '5Y' }
    // Range → bar interval. Sent explicitly so the server never has to guess.
    const RANGE_INTERVAL = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' }
    const DISCLAIMER_FALLBACK =
      'This is not financial advice. Trading Mode only restates and interprets the market data supplied by configured data providers. Market data may be delayed.'

    const ICON = {
      chart: ['M3 3v18h18', 'M7 14l3-4 4 3 6-7'],
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-3.5-3.5'],
      star: ['M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      back: ['M15 18l-6-6 6-6'],
      plus: ['M12 5v14', 'M5 12h14'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
      grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
      trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
      up: ['M12 19V5', 'M6 11l6-6 6 6'],
      down: ['M12 5v14', 'M6 13l6 6 6-6'],
      globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      download: ['M12 4v11', 'M7 11l5 5 5-5', 'M4 20h16'],
    }

    function Icon({ name, size }) {
      const paths = ICON[name] || ICON.chart
      return h(
        'svg',
        {
          width: size || 15,
          height: size || 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths.map((d, i) => h('path', { key: i, d })),
      )
    }

    // -------------------------------------------------------------------- i18n
    /** Languages the panel can switch between. */
    const LANGS = ['en', 'zh']
    const LANG_LABEL = { en: 'English', zh: '中文（简体）' }
    const LANG_SHORT = { en: 'EN', zh: '中文' }

    /**
     * Panel colour schemes (user request m11109): the window is either
     * white-on-black (`dark`) or black-on-white (`light`), and every surface it
     * paints is opaque, so the conversation behind it can never show through.
     * `dark`/`light` are also the DSH theme service's built-in ids, which is why
     * the switch doubles as the surrounding interface's theme switch.
     */
    const THEME_SCHEMES = ['dark', 'light']

    /** Normalise any locale id (`en`, `en-US`, `zh`, `zh-CN`, `zh_Hant`) to a shipped language. */
    function normalizeLang(value) {
      if (typeof value !== 'string') return null
      const primary = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0]
      if (primary === 'zh') return 'zh'
      if (primary === 'en') return 'en'
      return null
    }

    /**
     * Simplified-Chinese dictionary. English is the source language, so the key
     * IS the English sentence: the code stays readable and an untranslated
     * string degrades to English instead of to a raw key.
     * `{name}` placeholders are substituted by the translate function.
     */
    const ZH = {
      'Loading…': '加载中…',
      'Retry': '重试',
      'Refresh': '刷新',
      'Refresh quotes': '刷新行情',
      'Back': '返回',
      'Close': '关闭',
      'Language': '语言',
      'Follow the DSH interface language': '跟随 DSH 界面语言',
      'Data unavailable': '暂无数据',
      'Unavailable.': '暂无数据。',
      'loading bars…': '正在加载 K 线…',
      'searching…': '搜索中…',
      'Computing indicators…': '正在计算指标…',
      'Updated {time}': '更新于 {time}',
      'Data may be delayed': '数据可能延迟',
      'Last available data': '最后可用数据',
      'Too many requests; the panel is protecting the upstream data sources.': '请求过于频繁；面板正在保护上游数据源。',
      'Try again in about {n} seconds.': '请在约 {n} 秒后重试。',
      'Not enough history for reliable indicators: only {n} daily bars are available (need {m}).':
        '历史数据不足，技术指标不可靠：仅有 {n} 根日 K 线（需要 {m} 根）。',
      'Limited history: {n} daily bars — long-term indicators (MA200, 52-week levels, 1-year change) are not reported.':
        '历史数据有限：仅 {n} 根日 K 线，长期指标（MA200、52 周高低点、一年涨跌幅）不提供。',
      'This analysis is based on the last available data, not a live quote.': '本简报基于最后可用数据，并非实时行情。',
      'This analysis is based on delayed data.': '本简报基于延迟数据。',
      'The age of the data behind this analysis could not be established.': '无法确认本简报所用数据的时间，请以行情卡片上的时间戳为准。',
      'This deployment has no host security fence, so the panel refuses to answer rather than serve an unverifiable caller.':
        '当前部署缺少宿主安全围栏，面板拒绝应答，以免向无法验证来源的调用方提供数据。',
      'This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.':
        '当前 DSH profile 没有可信的用户身份，因此自选与偏好设置为不可用；行情数据仍可使用。',
      'This request did not pass the DSH host/origin check.': '该请求未通过 DSH 的 Host/Origin 校验。',
      'No authenticated DSH browser session for this request.': '该请求没有已认证的 DSH 浏览器会话。',
      'Source: {source}': '数据源：{source}',
      'cached': '缓存',
      'High {value}': '最高 {value}',
      'Low {value}': '最低 {value}',
      '{count} bars': '{count} 根 K 线',
      'partial history': '历史数据不完整',
      'The feed returned fewer bars than this range asks for; no reachable source publishes the rest.': '数据源返回的 K 线少于该区间应有的数量，当前可访问的来源没有更多历史。',
      'Interval {interval}': '周期 {interval}',
      'Last close {value}': '最新收盘 {value}',
      'Search Stocks — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988': '搜索股票 — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988',
      'Pick a result to add it to your watchlist.': '点选搜索结果即可加入自选。',
      'No matching stock found.': '没有找到匹配的股票。',
      'Add to watchlist': '加入自选',
      'Mark as favourite': '标记为关注',
      'Move up': '上移',
      'Move down': '下移',
      'Remove from watchlist': '从自选中移除',
      'My Watchlist': '我的自选',
      'Add Stock': '添加股票',
      'Loading watchlist…': '正在加载自选…',
      'Your watchlist is empty. Use Search Stocks or the starter list below to add a stock.':
        '自选为空。用上面的搜索框或下面的初始清单添加股票。',
      'Starter list': '初始清单',
      'AI Watchlist Brief': 'AI 自选简报',
      'View Full Analysis': '查看完整分析',
      'Generate Brief': '生成简报',
      'Analysing…': '分析中…',
      'DeepSeek is not available in this DSH session, so the brief cannot be generated. Market data above is unaffected.':
        '当前 DSH 会话中 DeepSeek 不可用，因此无法生成简报。上方行情数据不受影响。',
      'DeepSeek is reading your watchlist…': 'DeepSeek 正在阅读你的自选…',
      'Stocks tracked': '跟踪股票数',
      'Up': '上涨',
      'Down': '下跌',
      'Strongest mover: ': '涨幅最大：',
      'Largest decline: ': '跌幅最大：',
      'Unusual volume: ': '异常成交量：',
      'These are watchlist stocks, not portfolio holdings. Not financial advice.': '这些是自选股，不代表你的持仓。不构成投资建议。',
      'Generate a brief to summarise the movers, volume anomalies and technical changes in your watchlist.':
        '生成简报，汇总自选中的涨跌、成交量异常与技术面变化。',
      'Data source status': '数据源状态',
      '{ready}/{total} sources ready': '{ready}/{total} 个数据源可用',
      'cache: {cache} · watchlist: {watchlist} · AI: {ai}': '缓存：{cache} · 自选：{watchlist} · AI：{ai}',
      'ready': '就绪',
      'unavailable': '不可用',
      'ok {ok} / fail {fail}': '成功 {ok} / 失败 {fail}',
      ' · cooling {seconds}s': ' · 冷却 {seconds}s',
      'Chains': '数据源链路',
      'AI Analysis': 'AI 分析',
      'Ask DeepSeek': '询问 DeepSeek',
      'DeepSeek is not available in this DSH session.': '当前 DSH 会话中 DeepSeek 不可用。',
      'Reason: ': '原因：',
      'Optional question — context (price, candles, indicators, timestamp) is attached automatically':
        '可选提问 —— 系统会自动附加上下文（价格、K 线、指标、时间戳）',
      'DeepSeek is analysing {symbol}…': 'DeepSeek 正在分析 {symbol}…',
      'Trend · short term': '趋势 · 短期',
      'Trend · medium term': '趋势 · 中期',
      'Trend · long term': '趋势 · 长期',
      'Momentum': '动能',
      'Volume': '成交量',
      'Support': '支撑位',
      'Resistance': '压力位',
      'Risk Factors': '风险因素',
      'Key Observations': '关键观察',
      'Ask DeepSeek for a structured read of the trend, momentum, volume, support/resistance and risk of this stock. Values are supplied by the system; DeepSeek never fetches market data.':
        '让 DeepSeek 按结构解读该股的趋势、动能、成交量、支撑/压力与风险。所有数值由系统提供，DeepSeek 不抓取行情数据。',
      'No summary was returned.': '未返回摘要。',
      'Chart': '图表',
      'TradingView (external embed)': 'TradingView（外部嵌入）',
      "Embedded third-party chart. Values shown here are TradingView's own and are not used by Trading Mode analytics.":
        '嵌入式第三方图表。此处显示的数值来自 TradingView，不参与 Trading Mode 的分析。',
      'Market Data': '行情数据',
      'Open': '开盘',
      'High': '最高',
      'Low': '最低',
      'Previous Close': '昨收',
      'Timestamp': '时间戳',
      'Data source': '数据源',
      'Freshness': '数据状态',
      'Market cap': '市值',
      'P/E': '市盈率',
      'Technical Indicators': '技术指标',
      'Reference levels (system-computed)': '参考价位（系统计算）',
      'Market data providers: {chains}': '行情数据源：{chains}',
      'Home': '首页',
      'Market research only — no order routing, no brokerage connection. Market data may be delayed.':
        '仅用于市场研究 —— 不接券商、不下单。行情数据可能延迟。',
      'AI output is generated from system-supplied structured data; it is not financial advice.':
        'AI 结论基于系统提供的结构化数据生成，不构成投资建议。',
      'Trading Mode': '交易模式',
      // Market Overview strip + external source links (m01395)
      'Market Overview': '市场指数',
      'Index levels, not tradable prices': '指数点位，不可直接交易',
      'Loading indices…': '正在加载指数…',
      'Data unavailable for {symbols}': '{symbols} 暂无数据',
      'Data source pages': '数据来源页面',
      'Open {name} in a new tab': '在新标签页打开 {name}',
      'Open {name}': '打开 {name}',
      // §31 technical grid
      'MACD Signal': 'MACD 信号线',
      'MACD Histogram': 'MACD 柱',
      'Volume Ratio (20D)': '量比（20 日）',
      'Trend alignment': '均线排列',
      '52W High': '52 周最高',
      '52W Low': '52 周最低',
      'Avg volume 20D': '20 日均量',
      'Volatility 20D (ann.)': '20 日波动率（年化）',
      '20-day simple moving average': '20 日简单移动平均线',
      'Relative Strength Index, 14 periods': '相对强弱指标（14 周期）',
      'Average True Range, 14 periods': '平均真实波幅（14 周期）',
      // server-computed trendAlignment vocabulary
      'bullish-stack': '多头排列',
      'bearish-stack': '空头排列',
      'short-term-above-medium': '短期在中期均线之上',
      'short-term-below-medium': '短期在中期均线之下',
      'flat': '走平',
      'insufficient-history': '历史数据不足',
      // full US/HK listing browser (m01842)
      'Browse all US, HK, CN, JP & crypto listings': '浏览全部美股、港股、A股、日股与加密货币',
      'Everything listed on NASDAQ, NYSE, AMEX, HKEX, SSE, SZSE, BSE, JPX and the top coins': '涵盖 NASDAQ、NYSE、AMEX、港交所、上交所、深交所、北交所、东京交易所与主流加密货币',
      'Market': '市场',
      'Board': '板块',
      'US market': '美股',
      'HK market': '港股',
      'CN market': 'A股',
      'JP market': '日股',
      'Crypto': '加密货币',
      'Spot prices, 24/7 market': '现货价格，7×24 小时交易',
      'Loading crypto prices…': '正在加载加密货币行情…',
      'Board fully loaded': '该板块已全量载入',
      'Board not fully loaded yet': '该板块尚未全量载入',
      'Filter listings — code or company name': '筛选列表 — 代码或公司名',
      'loading…': '加载中…',
      '{loaded} listings loaded · {board} page {page} of {pages} · {total} listed': '已载入 {loaded} 条 · {board} 第 {page} / {pages} 页 · 共 {total} 只',
      'Prev': '上一页',
      'Next': '下一页',
      'Load entire board': '载入整个板块',
      'Loading the whole board…': '正在载入整个板块…',
      'Nothing loaded matches this filter. Results from the live search below cover the whole market.': '已载入的数据里没有匹配项。下方的实时搜索结果覆盖全市场。',
      'The listing feed is temporarily unavailable. Use the search box above — it covers the whole market — or press Load entire board to retry.': '上市清单数据源暂时不可用。可直接使用上方的搜索框（覆盖全市场），或稍后点「载入整个板块」重试。',
      'Loading listings…': '正在载入列表…',
      'Already in your watchlist': '已在自选列表中',
      'Added': '已添加',
      'Add': '添加',
      'from the live search': '来自实时搜索',
      'Theme': '主题',
      'Dark theme': '深色主题（黑底白字）',
      'Light theme': '浅色主题（白底黑字）',
      'Dark': '深色',
      'Light': '浅色',
    }

    /** Translate one English source string; unknown strings fall back to English. */
    function translate(text, lang) {
      if (lang === 'zh' && Object.prototype.hasOwnProperty.call(ZH, text)) return ZH[text]
      return text
    }

    /** Bound translator: `t('Updated {time}', { time: '10:42:18' })`. */
    function makeT(lang) {
      const target = LANGS.indexOf(lang) >= 0 ? lang : 'en'
      return function t(text, vars) {
        let out = translate(text, target)
        if (vars) {
          out = out.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined || vars[key] === null ? match : String(vars[key])))
        }
        return out
      }
    }

    // ------------------------------------------------------------------- store
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : patch
          state = Object.assign({}, state, next)
          listeners.forEach((fn) => fn())
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    }

    // 跨 slot 组件共享的开关状态（按钮和浮层分别挂在不同 slot）。
    // lang      = 用户在本面板里显式选择的语言（null = 跟随平台）
    // langSet   = 本次会话是否已由用户手动选择（避免被服务端旧值覆盖）
    // platformLang = DSH locale / 浏览器语言的归一化结果
    // theme     = 面板配色，'dark'（黑底白字）| 'light'（白底黑字）
    // themeSet  = 本次会话是否已由用户在面板里手动选择（避免被宿主主题快照覆盖）
    const store = createStore({
      open: false,
      view: 'home',
      symbol: null,
      range: '6mo',
      tv: false,
      addMode: false,
      lang: null,
      langSet: false,
      platformLang: 'en',
      theme: null,
      themeSet: false,
    })
    const setStore = (patch) => store.set(patch)

    function useStore() {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store.get()
    }

    /** Effective UI language: explicit choice → platform locale → English. */
    function effectiveLang(ui) {
      return normalizeLang(ui && ui.lang) || normalizeLang(ui && ui.platformLang) || 'en'
    }

    /** Normalise `dark`/`light`; anything else (including null) means "not chosen". */
    function normalizeTheme(value) {
      return THEME_SCHEMES.indexOf(value) >= 0 ? value : null
    }

    /**
     * Effective panel scheme: the choice made here (or the host scheme adopted
     * while nothing was chosen) → dark. Dark is the shipped default and matches
     * the `#000`/`#fff` palette the stylesheet declares for `.tm-layer`.
     */
    function effectiveTheme(ui) {
      return normalizeTheme(ui && ui.theme) || 'dark'
    }

    // The DSH theme service (`ctx.get('theme')`), when this build exposes one.
    let hostTheme = null

    /**
     * Adopt a DSH theme snapshot — but never override a scheme the user picked
     * in this panel (that choice is what produced the host preference anyway).
     */
    function applyThemeSnapshot(snapshot) {
      const scheme = normalizeTheme(snapshot && snapshot.active && snapshot.active.colorScheme)
      if (!scheme) return null
      if (!store.get().themeSet) setStore({ theme: scheme })
      return scheme
    }

    /**
     * Follow the DSH theme unless the user picked a scheme here. The service is
     * optional: without it the panel still switches, it just does not mirror the
     * surrounding interface. `theme/change` is the only continuous sync point
     * (it also fires when the OS scheme flips while the host preference is
     * `system`).
     */
    function bindPlatformTheme(ctx) {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('theme') : null
        // Authoritative: re-binding without a service un-binds the previous one.
        hostTheme = service && typeof service.getTheme === 'function' ? service : null
        if (!hostTheme) return null
        try {
          applyThemeSnapshot(hostTheme.getTheme())
        } catch (_) {
          /* no snapshot yet — the stylesheet default still applies */
        }
        if (typeof ctx.on === 'function') {
          const off = ctx.on('theme/change', (snapshot) => applyThemeSnapshot(snapshot))
          ctx.effect(
            () => () => {
              try {
                if (typeof off === 'function') off()
              } catch (_) {
                /* the service is already gone */
              }
            },
            'dsh-trading-mode: theme',
          )
        }
        return service
      } catch (_) {
        return null
      }
    }

    /**
     * Switch the panel scheme. The DSH theme service is the only writer of the
     * stored preference (it persists through the host settings scope), so the
     * choice survives a reload; without the service it lasts for this session.
     */
    function persistTheme(scheme) {
      const next = normalizeTheme(scheme)
      if (!next) return null
      setStore({ theme: next, themeSet: true })
      try {
        if (hostTheme && typeof hostTheme.setTheme === 'function') hostTheme.setTheme(next)
      } catch (_) {
        /* unregistered scheme or no settings scope — the panel still switches */
      }
      return next
    }

    /** Subscribe to the store and get the bound translator for the active language. */
    function useT() {
      const ui = useStore()
      return { ui, lang: effectiveLang(ui), t: makeT(effectiveLang(ui)) }
    }

    /**
     * Adopt the language persisted on the host — but never override a choice the
     * user made in this session (that choice is what produced the stored value).
     */
    function applyServerLang(settings) {
      const lang = settings ? normalizeLang(settings.lang) : null
      if (lang && !store.get().langSet) setStore({ lang })
      return lang
    }

    /** Persist the language choice (best effort: the UI switches either way). */
    function persistLang(lang) {
      const next = normalizeLang(lang)
      if (!next) return
      setStore({ lang: next, langSet: true })
      request('/settings', { method: 'PATCH', body: { lang: next } }).catch(() => {})
    }

    // -------------------------------------------------------------- formatting
    const CURRENCY_SIGN = { USD: '$', HKD: 'HK$', CNY: '¥', JPY: '¥' }

    /**
     * Market vocabulary (0.5.0, user request m02818).
     *
     * `CRYPTO` is a market like any other: the server resolves `BTC` only when it
     * is told the market (bare `BTC` is also a plausible US ticker), so every
     * navigation and request carries the market along with the symbol.
     */
    const MARKET_ORDER = ['US', 'HK', 'CN', 'JP', 'CRYPTO']
    const MARKET_LABEL_KEY = {
      US: 'US market',
      HK: 'HK market',
      CN: 'CN market',
      JP: 'JP market',
      CRYPTO: 'Crypto',
    }

    /** Fallback market of a symbol whose record carried none. */
    function marketOfSymbol(symbol) {
      const raw = String(symbol == null ? '' : symbol).toUpperCase()
      if (/\.HK$/.test(raw)) return 'HK'
      if (/\.(SH|SZ|BJ)$/.test(raw)) return 'CN'
      if (/\.T$/.test(raw)) return 'JP'
      return 'US'
    }

    function isNum(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    function digitsFor(value) {
      if (!isNum(value)) return 2
      const abs = Math.abs(value)
      if (abs >= 1) return 2
      if (abs === 0) return 2
      // Sub-dollar assets (crypto especially) need enough decimals to be readable.
      if (abs >= 0.1) return 3
      return Math.min(8, Math.max(4, Math.ceil(-Math.log10(abs)) + 3))
    }

    function money(value, currency) {
      if (!isNum(value)) return '—'
      const sign = CURRENCY_SIGN[currency] || ''
      return `${sign}${value.toFixed(digitsFor(value))}`
    }

    function plain(value, digits) {
      if (!isNum(value)) return '—'
      return value.toFixed(typeof digits === 'number' ? digits : digitsFor(value))
    }

    function signed(value, digits) {
      if (!isNum(value)) return '—'
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(typeof digits === 'number' ? digits : digitsFor(value))}`
    }

    function percent(value) {
      if (!isNum(value)) return '—'
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`
    }

    function volumeText(value) {
      if (!isNum(value)) return '—'
      const abs = Math.abs(value)
      if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(Math.round(value))
    }

    function clockOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function dateTimeOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function dateOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }

    function epochOf(value) {
      if (isNum(value)) return value > 1e12 ? value : value > 1e9 ? value * 1000 : null
      if (typeof value === 'string' && value) {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    function nameOf(record, fallback) {
      if (!record) return fallback || '—'
      return record.name || record.nameZh || record.symbol || fallback || '—'
    }

    function trendClass(value) {
      if (!isNum(value)) return ''
      return value > 0 ? 'tm-up' : value < 0 ? 'tm-down' : 'tm-flat'
    }

    function toneOf(price, previousClose) {
      if (!isNum(price) || !isNum(previousClose) || price === previousClose) return ''
      return price > previousClose ? 'tm-up' : 'tm-down'
    }

    // -------------------------------------------------------------------- http
    async function request(path, options) {
      const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {})
      if (opts.body !== undefined && typeof opts.body !== 'string') {
        opts.body = JSON.stringify(opts.body)
        opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers)
      }
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers)
      const response = await fetch(API_BASE + path, opts)
      let payload = null
      try {
        payload = await response.json()
      } catch (_) {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const info = (payload && payload.error) || {}
        const error = new Error(info.message || `request failed with status ${response.status}`)
        error.code = info.code || `HTTP_${response.status}`
        error.status = response.status
        // 0.7.0: surface the server's own retry hint so the panel can say "wait N s".
        const headerRetry = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('retry-after')) : NaN
        error.retryAfterMs = info.retryAfterMs || (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry * 1000 : null)
        throw error
      }
      return payload.value
    }

    const apiGet = (path, signal) => request(path, { signal })
    const apiPost = (path, body, signal) => request(path, { method: 'POST', body: body || {}, signal })

    function useAsync(loader, deps, options) {
      const opts = options || {}
      const [state, setState] = useState({ loading: Boolean(opts.immediate !== false), error: null, data: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => setNonce((n) => n + 1), [])
      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setState((prev) => ({ loading: true, error: null, data: prev.data }))
        Promise.resolve()
          .then(() => loader(controller.signal))
          .then((data) => {
            if (alive) setState({ loading: false, error: null, data })
          })
          .catch((error) => {
            if (alive && error && error.name !== 'AbortError') setState({ loading: false, error, data: null })
          })
        return () => {
          alive = false
          controller.abort()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps.concat([nonce]))
      return Object.assign({ reload }, state)
    }

    // ------------------------------------------------------------------- atoms
    function Spinner({ label }) {
      const { t } = useT()
      return h('div', { className: 'tm-spinner' }, h('span', { className: 'tm-spinner__dot' }), h('span', null, label || t('Loading…')))
    }

    function ErrorNote({ error, onRetry }) {
      const { t } = useT()
      if (!error) return null
      const rateLimited = error.code === 'RATE_LIMITED'
      const waitSeconds = error.retryAfterMs ? Math.max(1, Math.ceil(error.retryAfterMs / 1000)) : null
      // 0.8.0 (round-3 P0-b/P1⑦): say plainly why a whole panel is refused
      // instead of leaking the raw host message at the user.
      const explanation = (() => {
        if (rateLimited)
          return (
            t('Too many requests; the panel is protecting the upstream data sources.') +
            (waitSeconds ? ' ' + t('Try again in about {n} seconds.').replace('{n}', String(waitSeconds)) : '')
          )
        if (error.code === 'HOST_SECURITY_UNAVAILABLE')
          return t('This deployment has no host security fence, so the panel refuses to answer rather than serve an unverifiable caller.')
        if (error.code === 'NO_IDENTITY')
          return t('This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.')
        if (error.code === 'FORBIDDEN') return t('This request did not pass the DSH host/origin check.')
        if (error.code === 'UNAUTHENTICATED') return t('No authenticated DSH browser session for this request.')
        return error.message || String(error)
      })()
      return h(
        'div',
        { className: 'tm-error' },
        h('div', { className: 'tm-error__msg' }, h('strong', null, (error.code || 'ERROR') + ' '), explanation),
        onRetry ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: onRetry }, t('Retry')) : null,
      )
    }

    function Empty({ children }) {
      return h('div', { className: 'tm-empty' }, children)
    }

    function Card({ title, right, children, className }) {
      return h(
        'section',
        { className: 'tm-card' + (className ? ' ' + className : '') },
        title ? h('header', { className: 'tm-card__head' }, h('h3', { className: 'tm-card__title' }, title), right || null) : null,
        h('div', { className: 'tm-card__body' }, children),
      )
    }

    function Cell({ label, value, tone, title }) {
      return h(
        'div',
        { className: 'tm-cell', title: title || undefined },
        h('span', { className: 'tm-cell__k' }, label),
        h('span', { className: 'tm-cell__v' + (tone ? ' ' + tone : '') }, value),
      )
    }

    /** EN / 中文 switch. Lives in the panel header. */
    function LangToggle() {
      const ui = useStore()
      const active = effectiveLang(ui)
      const { t } = useT()
      return h(
        'div',
        { className: 'tm-langs', role: 'group', 'aria-label': t('Language'), title: t('Language') },
        LANGS.map((lang) =>
          h(
            'button',
            {
              key: lang,
              className: 'tm-lang' + (lang === active ? ' tm-lang--active' : ''),
              title: LANG_LABEL[lang] || lang,
              'aria-pressed': lang === active,
              onClick: () => persistLang(lang),
            },
            LANG_SHORT[lang] || lang.toUpperCase(),
          ),
        ),
      )
    }

    /**
     * White-on-black / black-on-white switch. Lives in the panel header next to
     * the language switch; the visible label stays short, the tooltip spells the
     * scheme out.
     */
    function ThemeToggle() {
      const { ui, t } = useT()
      const active = effectiveTheme(ui)
      return h(
        'div',
        { className: 'tm-themes', role: 'group', 'aria-label': t('Theme'), title: t('Theme') },
        THEME_SCHEMES.map((scheme) =>
          h(
            'button',
            {
              key: scheme,
              className: 'tm-thm' + (scheme === active ? ' tm-thm--active' : ''),
              title: scheme === 'dark' ? t('Dark theme') : t('Light theme'),
              'aria-pressed': scheme === active,
              onClick: () => persistTheme(scheme),
            },
            scheme === 'dark' ? t('Dark') : t('Light'),
          ),
        ),
      )
    }

    /**
     * §21: always show the provider timestamp, never claim the data is live.
     * "Last available data" only when we are knowingly serving something stale.
     */
    function Freshness({ meta, data, compact }) {
      const { t } = useT()
      const stale = Boolean((meta && meta.stale) || (data && data.stale))
      const timestamp = (meta && meta.timestamp) || (data && data.timestamp)
      return h(
        'div',
        { className: 'tm-fresh' + (stale ? ' tm-fresh--stale' : '') + (compact ? ' tm-fresh--compact' : '') },
        h('span', { className: 'tm-fresh__time' }, t('Updated {time}', { time: clockOf(timestamp) })),
        h('span', { className: 'tm-fresh__note' }, stale ? t('Last available data') : t('Data may be delayed')),
        data && data.source ? h('span', { className: 'tm-fresh__src' }, t('Source: {source}', { source: data.source })) : null,
        stale && meta && meta.staleReason ? h('span', { className: 'tm-fresh__why', title: meta.staleReason }, t('cached')) : null,
      )
    }

    // ---------------------------------------------------------------- charting
    function downsample(bars, max) {
      if (!Array.isArray(bars)) return []
      if (bars.length <= max) return bars
      const step = Math.ceil(bars.length / max)
      const out = []
      for (let i = 0; i < bars.length; i += step) out.push(bars[i])
      if (out[out.length - 1] !== bars[bars.length - 1]) out.push(bars[bars.length - 1])
      return out
    }

    function buildGeometry(bars, series, width, height) {
      const highs = bars.map((b) => b.high).filter(isNum)
      const lows = bars.map((b) => b.low).filter(isNum)
      const max = highs.length ? Math.max.apply(null, highs) : 0
      const min = lows.length ? Math.min.apply(null, lows) : 0
      const span = max - min || Math.max(max * 0.01, 1)
      const padTop = 10
      const padBottom = 6
      const priceH = height * 0.72 - padTop - padBottom
      const volumeTop = height * 0.74
      const volumeH = height - volumeTop - 14
      const slot = width / bars.length
      const bodyW = Math.max(1, Math.min(slot * 0.62, 14))
      const yOf = (price) => padTop + (1 - (price - min) / span) * priceH
      const volumeMax = Math.max.apply(null, bars.map((b) => (isNum(b.volume) ? b.volume : 0)).concat([1]))
      const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => padTop + t * priceH)
      const wicks = []
      const bodies = []
      const volumes = []
      bars.forEach((bar, i) => {
        const x = i * slot + slot / 2
        const up = (bar.close ?? 0) >= (bar.open ?? 0)
        wicks.push({ key: 'w' + i, x1: x, x2: x, y1: yOf(bar.high), y2: yOf(bar.low), up })
        const openY = yOf(bar.open)
        const closeY = yOf(bar.close)
        bodies.push({ key: 'b' + i, x: x - bodyW / 2, y: Math.min(openY, closeY), w: bodyW, h: Math.max(1, Math.abs(closeY - openY)), up })
        const volume = isNum(bar.volume) ? bar.volume : 0
        const barH = Math.max(0.5, (volume / volumeMax) * volumeH)
        volumes.push({ key: 'v' + i, x: x - bodyW / 2, y: volumeTop + (volumeH - barH), w: bodyW, h: barH, up })
      })
      const lines = []
      if (series && Array.isArray(series.timestamp)) {
        const lookup = { ma20: new Map(), ma50: new Map(), ma200: new Map() }
        series.timestamp.forEach((ts, i) => {
          ;['ma20', 'ma50', 'ma200'].forEach((key) => {
            const value = series[key] && series[key][i]
            if (isNum(value)) lookup[key].set(epochOf(ts), value)
          })
        })
        ;['ma20', 'ma50', 'ma200'].forEach((key) => {
          const points = []
          bars.forEach((bar, i) => {
            const value = lookup[key].get(epochOf(bar.timestamp))
            if (isNum(value)) points.push(`${(i * slot + slot / 2).toFixed(1)},${yOf(value).toFixed(1)}`)
          })
          if (points.length > 1) lines.push({ key, points: points.join(' ') })
        })
      }
      return { grid, wicks, bodies, volumes, lines, min, max, first: bars[0], last: bars[bars.length - 1] }
    }

    function CandleChart({ candles, series, interval, degraded }) {
      const { t } = useT()
      const bars = useMemo(() => downsample(candles || [], 320), [candles])
      const geo = useMemo(() => buildGeometry(bars, series, 1000, 340), [bars, series])
      if (!bars.length) return h(Empty, null, t('Data unavailable'))
      return h(
        'div',
        { className: 'tm-chart' },
        h(
          'svg',
          { className: 'tm-chart__svg', viewBox: '0 0 1000 340', preserveAspectRatio: 'none', role: 'img' },
          geo.grid.map((y, i) => h('line', { key: 'g' + i, className: 'tm-chart__grid', x1: 0, x2: 1000, y1: y, y2: y })),
          geo.volumes.map((v) => h('rect', { key: v.key, className: 'tm-chart__vol' + (v.up ? ' tm-chart__vol--up' : ''), x: v.x, y: v.y, width: v.w, height: v.h })),
          geo.wicks.map((w) => h('line', { key: w.key, className: 'tm-chart__wick' + (w.up ? ' tm-up-stroke' : ' tm-down-stroke'), x1: w.x1, x2: w.x2, y1: w.y1, y2: w.y2 })),
          geo.bodies.map((b) => h('rect', { key: b.key, className: 'tm-chart__body' + (b.up ? ' tm-up-fill' : ' tm-down-fill'), x: b.x, y: b.y, width: b.w, height: b.h })),
          geo.lines.map((l) => h('polyline', { key: l.key, className: 'tm-chart__ma tm-chart__ma--' + l.key, points: l.points, fill: 'none' })),
        ),
        h(
          'div',
          { className: 'tm-chart__legend' },
          h('span', null, t('High {value}', { value: plain(geo.max) })),
          h('span', null, t('Low {value}', { value: plain(geo.min) })),
          h('span', null, t('{count} bars', { count: bars.length })),
          degraded
            ? h(
                'span',
                {
                  className: 'tm-chart__partial',
                  title: t('The feed returned fewer bars than this range asks for; no reachable source publishes the rest.'),
                },
                t('partial history'),
              )
            : null,
          interval ? h('span', null, t('Interval {interval}', { interval })) : null,
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma20' }, 'MA20'),
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma50' }, 'MA50'),
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma200' }, 'MA200'),
        ),
        h(
          'div',
          { className: 'tm-chart__footer' },
          h('span', null, `${dateOf(geo.first && geo.first.timestamp)} → ${dateOf(geo.last && geo.last.timestamp)}`),
          h('span', null, t('Last close {value}', { value: plain(geo.last && geo.last.close) })),
        ),
      )
    }

    // ------------------------------------------------------------------ search
    function SearchBox({ onPick, addMode, onAdd, autoFocus }) {
      const { t } = useT()
      const [query, setQuery] = useState('')
      const [results, setResults] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)

      useEffect(() => {
        if (autoFocus && inputRef.current) {
          try {
            inputRef.current.focus()
          } catch (_) {}
        }
      }, [autoFocus])

      useEffect(() => {
        const text = query.trim()
        if (text.length < 1) {
          setResults([])
          setError(null)
          return undefined
        }
        const controller = new AbortController()
        const timer = setTimeout(() => {
          setLoading(true)
          apiGet(`/search?q=${encodeURIComponent(text)}`, controller.signal)
            .then((value) => {
              setResults((value && value.results) || [])
              setError(null)
            })
            .catch((err) => {
              if (err && err.name !== 'AbortError') setError(err)
            })
            .then(() => setLoading(false))
        }, 260)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [query])

      return h(
        'div',
        { className: 'tm-search' },
        h(
          'div',
          { className: 'tm-search__field' },
          h(Icon, { name: 'search' }),
          h('input', {
            ref: inputRef,
            className: 'tm-input',
            value: query,
            placeholder: t('Search Stocks — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988'),
            onChange: (event) => setQuery(event.target.value),
            spellCheck: false,
          }),
          loading ? h('span', { className: 'tm-search__hint' }, t('searching…')) : null,
        ),
        addMode ? h('div', { className: 'tm-hint' }, t('Pick a result to add it to your watchlist.')) : null,
        error ? h(ErrorNote, { error }) : null,
        results.length
          ? h(
              'ul',
              { className: 'tm-results' },
              results.map((row) =>
                h(
                  'li',
                  { key: row.symbol, className: 'tm-result' },
                  h(
                    'button',
                    { className: 'tm-result__main', onClick: () => onPick(row) },
                    h('span', { className: 'tm-result__sym' }, row.symbol),
                    h('span', { className: 'tm-result__name' }, nameOf(row) + (row.nameZh && row.name ? ` · ${row.nameZh}` : '')),
                    h('span', { className: 'tm-result__meta' }, [row.market, row.exchange, row.currency].filter(Boolean).join(' · ')),
                  ),
                  onAdd
                    ? h(
                        'button',
                        { className: 'tm-iconbtn', title: t('Add to watchlist'), onClick: () => onAdd(row) },
                        h(Icon, { name: 'plus' }),
                      )
                    : null,
                ),
              ),
            )
          : query.trim().length >= 1 && !loading
            ? h('div', { className: 'tm-hint' }, t('No matching stock found.'))
            : null,
      )
    }

    // --------------------------------------------------------------- watchlist
    function WatchRow({ item, onOpen, onRemove, onFavorite, onMove, index, count, quoteMode }) {
      const { t } = useT()
      const quote = item.quote
      const change = quote ? (isNum(quote.changePct) ? quote.changePct : null) : null
      return h(
        'li',
        { className: 'tm-row' },
        h(
          'div',
          { className: 'tm-row__main', role: 'button', tabIndex: 0, onClick: () => onOpen(item) },
          h('span', { className: 'tm-row__sym' }, item.symbol),
          h('span', { className: 'tm-row__name' }, nameOf(item, item.symbol) + (item.nameZh && item.name && item.nameZh !== item.name ? ` · ${item.nameZh}` : '')),
          quote ? h(Freshness, { meta: item.quoteMeta, data: quote, compact: true }) : null,
          item.error ? h('span', { className: 'tm-row__err' }, item.error.code || 'error') : null,
        ),
        h(
          'div',
          { className: 'tm-row__quote' },
          h('span', { className: 'tm-row__price' }, quote ? money(quote.price, quote.currency) : '—'),
          h('span', { className: 'tm-row__chg ' + trendClass(change) }, quote ? `${signed(quote.change, 2)}  ${percent(change)}` : t('Data unavailable')),
          quote ? h('span', { className: 'tm-row__ts' }, clockOf(quote.timestamp)) : null,
        ),
        h(
          'div',
          { className: 'tm-row__tools' },
          h(
            'button',
            { className: 'tm-iconbtn' + (item.isFavorite ? ' tm-iconbtn--on' : ''), title: t('Mark as favourite'), onClick: () => onFavorite(item.symbol, !item.isFavorite) },
            h(Icon, { name: 'star' }),
          ),
          index > 0 ? h('button', { className: 'tm-iconbtn', title: t('Move up'), onClick: () => onMove(index, index - 1) }, h(Icon, { name: 'up' })) : null,
          index < count - 1 ? h('button', { className: 'tm-iconbtn', title: t('Move down'), onClick: () => onMove(index, index + 1) }, h(Icon, { name: 'down' })) : null,
          h('button', { className: 'tm-iconbtn', title: t('Remove from watchlist'), onClick: () => onRemove(item.symbol) }, h(Icon, { name: 'trash' })),
        ),
      )
    }

    function WatchlistCard({ rows, onOpen, onRemove, onFavorite, onMove, onRefresh, loading, error, addMode, onToggleAdd, identity }) {
      const { t } = useT()
      // 0.8.0: never pretend a watchlist was stored when the deployment has no
      // trustworthy per-user identity (the API refuses those writes with 503).
      const noIdentity = Boolean(identity && identity.storesPerUserData === false)
      return h(
        Card,
        {
          title: t('My Watchlist'),
          right: h(
            'div',
            { className: 'tm-card__tools' },
            h('button', { className: 'tm-btn tm-btn--ghost', onClick: onRefresh, title: t('Refresh quotes') }, h(Icon, { name: 'refresh' }), t('Refresh')),
            h('button', { className: 'tm-btn' + (addMode ? ' tm-btn--active' : ''), onClick: onToggleAdd }, h(Icon, { name: 'plus' }), t('Add Stock')),
          ),
        },
        error ? h(ErrorNote, { error, onRetry: onRefresh }) : null,
        noIdentity
          ? h(
              'div',
              { className: 'tm-note tm-note--warn' },
              t('This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.'),
            )
          : null,
        loading && !rows.length ? h(Spinner, { label: t('Loading watchlist…') }) : null,
        rows.length
          ? h(
              'ul',
              { className: 'tm-list' },
              rows.map((item, index) =>
                h(WatchRow, {
                  key: item.symbol,
                  item,
                  index,
                  count: rows.length,
                  onOpen,
                  onRemove,
                  onFavorite,
                  onMove,
                }),
              ),
            )
          : h(Empty, null, t('Your watchlist is empty. Use Search Stocks or the starter list below to add a stock.')),
      )
    }

    function StarterPool({ recommendations, onAdd }) {
      const { t } = useT()
      if (!recommendations || !recommendations.ALL || !recommendations.ALL.length) return null
      return h(
        Card,
        { title: t('Starter list') },
        h(
          'div',
          { className: 'tm-chips' },
          recommendations.ALL.map((symbol) =>
            h('button', { key: symbol, className: 'tm-chip', onClick: () => onAdd({ symbol }) }, symbol),
          ),
        ),
      )
    }

    // -------------------------------------------------- browse the whole market
    /**
     * Every US/HK listing is reachable here. The host walks the provider's bulk
     * listing feed page by page and folds the rows into a searchable index, so
     * the filter box works over what has already been fetched, while a symbol on
     * a page that has not been fetched yet is still one click away through the
     * full-market search endpoint.
     */
    const UNIVERSE_PAGE_SIZE = 100

    function UniverseBrowser({ onAdd, owned }) {
      const { t } = useT()
      const [market, setMarket] = useState('US')
      const [board, setBoard] = useState(null)
      const [page, setPage] = useState(1)
      const [query, setQuery] = useState('')
      const [boards, setBoards] = useState([])
      const [status, setStatus] = useState(null)
      const [result, setResult] = useState(null)
      const [fallback, setFallback] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const text = query.trim()

      useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        const timer = setTimeout(
          () => {
            setLoading(true)
            const qs = text
              ? `?market=${market}&q=${encodeURIComponent(text)}`
              : `?market=${market}${board ? `&board=${encodeURIComponent(board)}` : ''}&page=${page}&size=${UNIVERSE_PAGE_SIZE}`
            apiGet(`/universe${qs}`, controller.signal)
              .then((value) => {
                if (cancelled || !value) return
                setResult(value)
                if (Array.isArray(value.boards) && value.boards.length) setBoards(value.boards)
                if (value.status) setStatus(value.status)
                setError(null)
              })
              .catch((err) => {
                if (!cancelled && err && err.name !== 'AbortError') setError(err)
              })
              .then(() => {
                if (!cancelled) setLoading(false)
              })
          },
          text ? 280 : 0,
        )
        return () => {
          cancelled = true
          clearTimeout(timer)
          controller.abort()
        }
      }, [market, board, page, text])

      // The local index only knows the pages that have been fetched, so a filter
      // that matches nothing there also asks the full-market search endpoint.
      useEffect(() => {
        if (!text) {
          setFallback([])
          return undefined
        }
        if (loading) return undefined
        if (result && result.rows && result.rows.length) {
          setFallback([])
          return undefined
        }
        const controller = new AbortController()
        apiGet(`/search?q=${encodeURIComponent(text)}&market=${market}`, controller.signal)
          .then((value) => setFallback((value && value.results) || []))
          .catch(() => setFallback([]))
        return () => controller.abort()
      }, [text, loading, result, market])

      const walkBoard = useCallback(() => {
        setBusy(true)
        setError(null)
        apiPost('/universe', { market, board })
          .then((value) => {
            if (value && value.status) setStatus(value.status)
          })
          .catch((err) => setError(err))
          .then(() => setBusy(false))
      }, [market, board])

      // A background walk reports progress through the status block only.
      const running = Boolean(status && status.refreshing)
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => {
          apiGet(`/universe?market=${market}&page=1&size=1`)
            .then((value) => {
              if (value && value.status) setStatus(value.status)
            })
            .catch(() => {})
        }, 4000)
        return () => clearInterval(timer)
      }, [running, market])

      const rows = (result && result.rows) || []
      const pages = result && isNum(result.pages) ? result.pages : null
      const shown = pages ? Math.min(page, pages) : page
      // A feed without a published row count (the HK fallback list) pages until a
      // short page arrives, so "next" is offered while the page came back full.
      const pageSize = (result && isNum(result.size) && result.size) || UNIVERSE_PAGE_SIZE
      const canNext = pages ? shown < pages : rows.length >= pageSize
      const boardRows = boards.filter((b) => b.market === market)
      const loaded = status && status.counts ? status.counts[market] || 0 : 0
      const activeBoard = board || (boardRows[0] && boardRows[0].id) || null
      const boardMeta = boardRows.find((b) => b.id === activeBoard) || null

      return h(
        'div',
        { className: 'tm-universe' },
        h(
          'div',
          { className: 'tm-universe__bar' },
          h(
            'div',
            { className: 'tm-chips', role: 'group', 'aria-label': t('Market') },
            MARKET_ORDER.map((m) =>
              h(
                'button',
                {
                  key: m,
                  className: 'tm-chip' + (market === m ? ' tm-chip--active' : ''),
                  onClick: () => {
                    setMarket(m)
                    setBoard(null)
                    setPage(1)
                  },
                },
                t(MARKET_LABEL_KEY[m]),
              ),
            ),
          ),
          boardRows.length
            ? h(
                'div',
                { className: 'tm-chips', role: 'group', 'aria-label': t('Board') },
                boardRows.map((b) =>
                  h(
                    'button',
                    {
                      key: b.id,
                      className: 'tm-chip' + (activeBoard === b.id ? ' tm-chip--active' : ''),
                      title: b.complete ? t('Board fully loaded') : t('Board not fully loaded yet'),
                      onClick: () => {
                        setBoard(b.id)
                        setPage(1)
                      },
                    },
                    b.id + (b.total ? ` · ${b.total}` : ''),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'tm-universe__filter' },
          h(
            'div',
            { className: 'tm-search__field' },
            h(Icon, { name: 'search' }),
            h('input', {
              className: 'tm-input',
              value: query,
              placeholder: t('Filter listings — code or company name'),
              onChange: (event) => setQuery(event.target.value),
              spellCheck: false,
            }),
            loading ? h('span', { className: 'tm-search__hint' }, t('loading…')) : null,
          ),
        ),
        h(
          'div',
          { className: 'tm-universe__tools' },
          h(
            'span',
            { className: 'tm-hint tm-hint--tiny' },
            t('{loaded} listings loaded · {board} page {page} of {pages} · {total} listed', {
              loaded: String(loaded),
              board: activeBoard || '—',
              page: String(shown),
              pages: String(pages || '—'),
              total: String((boardMeta && boardMeta.total) || (result && result.total) || '—'),
            }),
          ),
          h(
            'div',
            { className: 'tm-card__tools' },
            shown > 1 ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => setPage(Math.max(1, shown - 1)) }, h(Icon, { name: 'up' }), t('Prev')) : null,
            canNext ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => setPage(shown + 1) }, t('Next'), h(Icon, { name: 'down' })) : null,
            h('button', { className: 'tm-btn', onClick: walkBoard, disabled: busy || running }, h(Icon, { name: 'download' }), running ? t('Loading the whole board…') : t('Load entire board')),
          ),
        ),
        error ? h(ErrorNote, { error, onRetry: walkBoard }) : null,
        error && !rows.length
          ? h('div', { className: 'tm-hint' }, t('The listing feed is temporarily unavailable. Use the search box above — it covers the whole market — or press Load entire board to retry.'))
          : null,
        result && result.mode === 'search' && !rows.length && !loading
          ? h('div', { className: 'tm-hint' }, t('Nothing loaded matches this filter. Results from the live search below cover the whole market.'))
          : null,
        loading && !rows.length ? h(Spinner, { label: t('Loading listings…') }) : null,
        rows.length
          ? h(
              'ul',
              { className: 'tm-universe__list' },
              rows.map((row) => h(UniverseRow, { key: row.symbol, row, onAdd, owned })),
            )
          : fallback.length
            ? h(
                'ul',
                { className: 'tm-universe__list' },
                fallback.map((row) => h(UniverseRow, { key: row.symbol, row, onAdd, owned, note: t('from the live search') })),
              )
            : null,
      )
    }

    function UniverseRow({ row, onAdd, owned, note }) {
      const { t } = useT()
      const has = Boolean(owned && typeof owned.has === 'function' && owned.has(row.symbol))
      return h(
        'li',
        { className: 'tm-universe__row' },
        h('span', { className: 'tm-universe__sym' }, row.symbol),
        h('span', { className: 'tm-universe__name' }, nameOf(row, row.symbol) + (row.nameZh && row.name && row.nameZh !== row.name ? ` · ${row.nameZh}` : '')),
        h('span', { className: 'tm-universe__meta' }, note || [row.market, row.exchange, row.industry && row.industry !== '-' ? row.industry : null].filter(Boolean).join(' · ')),
        h(
          'button',
          {
            className: 'tm-btn tm-btn--ghost',
            disabled: has,
            title: has ? t('Already in your watchlist') : t('Add to watchlist'),
            onClick: () => onAdd(row),
          },
          h(Icon, { name: has ? 'star' : 'plus' }),
          has ? t('Added') : t('Add'),
        ),
      )
    }

    function BriefCard({ brief, onRun, onOpenFull, loading, error, aiAvailable, aiReason }) {
      const { t } = useT()
      return h(
        Card,
        {
          title: t('AI Watchlist Brief'),
          right: h(
            'div',
            { className: 'tm-card__tools' },
            onOpenFull && brief ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: onOpenFull }, t('View Full Analysis')) : null,
            h('button', { className: 'tm-btn', onClick: onRun, disabled: loading || !aiAvailable }, loading ? t('Analysing…') : t('Generate Brief')),
          ),
        },
        !aiAvailable
          ? h(
              'div',
              { className: 'tm-hint' },
              t('DeepSeek is not available in this DSH session, so the brief cannot be generated. Market data above is unaffected.'),
              aiReason ? h('div', { className: 'tm-hint__why' }, t('Reason: ') + aiReason) : null,
            )
          : null,
        error ? h(ErrorNote, { error, onRetry: onRun }) : null,
        loading ? h(Spinner, { label: t('DeepSeek is reading your watchlist…') }) : null,
        brief
          ? h(
              'div',
              { className: 'tm-brief' },
              h('p', { className: 'tm-brief__headline' }, brief.headline),
              h(
                'div',
                { className: 'tm-brief__counts' },
                h(Cell, { label: t('Stocks tracked'), value: String(brief.stocksTracked) }),
                h(Cell, { label: t('Up'), value: String(brief.upCount), tone: 'tm-up' }),
                h(Cell, { label: t('Down'), value: String(brief.downCount), tone: 'tm-down' }),
              ),
              h('p', null, h('strong', null, t('Strongest mover: ')), brief.strongestMover),
              h('p', null, h('strong', null, t('Largest decline: ')), brief.largestDecline),
              brief.unusualVolume.length ? h('p', null, h('strong', null, t('Unusual volume: ')), brief.unusualVolume.join(' ')) : null,
              brief.keyObservations.length ? h('ul', { className: 'tm-list tm-list--plain' }, brief.keyObservations.map((line, i) => h('li', { key: i }, line))) : null,
              h('p', { className: 'tm-disclaimer' }, t('These are watchlist stocks, not portfolio holdings. Not financial advice.')),
            )
          : h('div', { className: 'tm-hint' }, t('Generate a brief to summarise the movers, volume anomalies and technical changes in your watchlist.')),
      )
    }

    // ------------------------------------------------------------------ status
    function StatusStrip({ status, ai, watchlistBackend, cacheBackend }) {
      const { t } = useT()
      const [open, setOpen] = useState(false)
      const providers = (status && status.providers) || []
      const healthy = providers.filter((p) => p.healthy).length
      const active = providers.filter((p) => p.healthy).map((p) => p.id)
      return h(
        'div',
        { className: 'tm-status' },
        h(
          'button',
          { className: 'tm-status__pill', onClick: () => setOpen(!open), title: t('Data source status') },
          h('span', { className: 'tm-dot' + (healthy ? ' tm-dot--ok' : ' tm-dot--bad') }),
          t('{ready}/{total} sources ready', { ready: healthy, total: providers.length }),
          active.length ? h('span', { className: 'tm-status__active' }, active.join(' → ')) : null,
        ),
        h(
          'span',
          { className: 'tm-status__meta' },
          t('cache: {cache} · watchlist: {watchlist} · AI: {ai}', {
            cache: cacheBackend || '—',
            watchlist: watchlistBackend || '—',
            ai: (ai && (ai.route || (ai.available ? t('ready') : t('unavailable')))) || '—',
          }),
        ),
        open
          ? h(
              'div',
              { className: 'tm-status__pop' },
              providers.map((p) =>
                h(
                  'div',
                  { key: p.id, className: 'tm-status__row' },
                  h('span', { className: 'tm-dot' + (p.healthy ? ' tm-dot--ok' : ' tm-dot--bad') }),
                  h('span', { className: 'tm-status__name' }, `${p.label || p.id} (${p.id})`),
                  h(
                    'span',
                    { className: 'tm-status__stats' },
                    t('ok {ok} / fail {fail}', { ok: p.successes, fail: p.failures }) +
                      (p.cooldownRemainingMs ? t(' · cooling {seconds}s', { seconds: Math.round(p.cooldownRemainingMs / 1000) }) : ''),
                  ),
                  p.lastError ? h('span', { className: 'tm-status__err' }, p.lastError) : null,
                ),
              ),
              h('div', { className: 'tm-status__row' }, h('span', { className: 'tm-status__name' }, t('Chains')), h('span', { className: 'tm-status__stats' }, JSON.stringify((status && status.chains) || {}))),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ detail
    function AiAnalysisSection({ symbol, analysis, loading, error, onRun, aiAvailable, aiReason, question, setQuestion, dataQuality }) {
      const { t } = useT()
      // 0.8.0: the grades are fresh / delayed / stale / historical / unknown —
      // `fresh` means "recent", it is never presented as a live quote, and any
      // other grade has to be labelled right above the prose.
      const recencyNote = (() => {
        const grade = dataQuality && dataQuality.grade
        if (!grade || grade === 'fresh') return null
        if (grade === 'delayed') return t('This analysis is based on delayed data.')
        if (grade === 'unknown') return t('The age of the data behind this analysis could not be established.')
        return t('This analysis is based on the last available data, not a live quote.')
      })()
      return h(
        Card,
        {
          title: t('AI Analysis'),
          right: h(
            'div',
            { className: 'tm-card__tools' },
            h('button', { className: 'tm-btn', onClick: onRun, disabled: loading || !aiAvailable }, loading ? t('Analysing…') : t('Ask DeepSeek')),
          ),
        },
        !aiAvailable
          ? h(
              'div',
              { className: 'tm-hint' },
              t('DeepSeek is not available in this DSH session.'),
              aiReason ? h('div', { className: 'tm-hint__why' }, t('Reason: ') + aiReason) : null,
            )
          : null,
        h(
          'div',
          { className: 'tm-ask' },
          h('input', {
            className: 'tm-input',
            value: question,
            placeholder: t('Optional question — context (price, candles, indicators, timestamp) is attached automatically'),
            onChange: (event) => setQuestion(event.target.value),
          }),
        ),
        error ? h(ErrorNote, { error, onRetry: onRun }) : null,
        recencyNote ? h('div', { className: 'tm-note tm-note--warn' }, recencyNote) : null,
        loading ? h(Spinner, { label: t('DeepSeek is analysing {symbol}…', { symbol }) }) : null,
        analysis
          ? h(
              'div',
              { className: 'tm-ai' },
              h('p', { className: 'tm-ai__summary' }, analysis.summary),
              h(
                'div',
                { className: 'tm-grid' },
                h(Cell, { label: t('Trend · short term'), value: analysis.trend.shortTerm }),
                h(Cell, { label: t('Trend · medium term'), value: analysis.trend.mediumTerm }),
                h(Cell, { label: t('Trend · long term'), value: analysis.trend.longTerm }),
                h(Cell, { label: t('Momentum'), value: analysis.momentum }),
                h(Cell, { label: t('Volume'), value: analysis.volume }),
              ),
              h('h4', { className: 'tm-ai__h' }, t('Support')),
              analysis.supportLevels.length ? h('div', { className: 'tm-levels' }, analysis.supportLevels.map((v, i) => h('span', { key: i, className: 'tm-level tm-level--sup' }, plain(v)))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Resistance')),
              analysis.resistanceLevels.length ? h('div', { className: 'tm-levels' }, analysis.resistanceLevels.map((v, i) => h('span', { key: i, className: 'tm-level tm-level--res' }, plain(v)))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Risk Factors')),
              analysis.riskFactors.length ? h('ul', { className: 'tm-list tm-list--plain' }, analysis.riskFactors.map((line, i) => h('li', { key: i }, line))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Key Observations')),
              analysis.keyObservations.length ? h('ul', { className: 'tm-list tm-list--plain' }, analysis.keyObservations.map((line, i) => h('li', { key: i }, line))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
            )
          : h('div', { className: 'tm-hint' }, t('Ask DeepSeek for a structured read of the trend, momentum, volume, support/resistance and risk of this stock. Values are supplied by the system; DeepSeek never fetches market data.')),
      )
    }

    /**
     * §27/§31 technical grid, as label/value pairs. Kept as a pure function so
     * the field mapping can be tested without a browser or a live provider.
     * @param {any} tech the §31 technical block
     * @param {(text: string) => string} [t] translator (defaults to English)
     */
    function technicalCells(tech, t) {
      if (!tech) return []
      const tr = typeof t === 'function' ? t : makeT('en')
      return [
        { label: 'MA20', value: plain(tech.ma20), title: tr('20-day simple moving average') },
        { label: 'MA50', value: plain(tech.ma50) },
        { label: 'MA200', value: plain(tech.ma200) },
        { label: 'RSI14', value: plain(tech.rsi14, 2), title: tr('Relative Strength Index, 14 periods') },
        { label: 'MACD', value: plain(tech.macd, 3) },
        { label: tr('MACD Signal'), value: plain(tech.macdSignal, 3) },
        { label: tr('MACD Histogram'), value: plain(tech.macdHistogram, 3) },
        { label: 'ATR14', value: plain(tech.atr14, 3), title: tr('Average True Range, 14 periods') },
        { label: tr('Volume Ratio (20D)'), value: isNum(tech.volumeRatio20d) ? plain(tech.volumeRatio20d, 2) + '×' : '—' },
        { label: tr('Trend alignment'), value: tr(tech.trendAlignment || '—') },
        { label: tr('52W High'), value: isNum(tech.high52w) ? plain(tech.high52w) : '—' },
        { label: tr('52W Low'), value: isNum(tech.low52w) ? plain(tech.low52w) : '—' },
        { label: 'MA5', value: plain(tech.ma5) },
        { label: 'MA10', value: plain(tech.ma10) },
        { label: 'MA60', value: plain(tech.ma60) },
        { label: 'EMA12', value: plain(tech.ema12) },
        { label: 'EMA26', value: plain(tech.ema26) },
        { label: tr('Avg volume 20D'), value: volumeText(tech.volumeAverage20d) },
        { label: tr('Volatility 20D (ann.)'), value: isNum(tech.volatility20dAnnualizedPct) ? plain(tech.volatility20dAnnualizedPct, 2) + '%' : '—' },
      ]
    }

    function DetailView({ symbol, market, onBack, aiAvailable, aiReason }) {
      const { ui, lang, t } = useT()
      const range = ui.range || '6mo'
      const [tv, setTv] = useState(ui.tv)
      const [analysis, setAnalysis] = useState(null)
      const [analysisError, setAnalysisError] = useState(null)
      const [analysisMeta, setAnalysisMeta] = useState(null)
      const [analysing, setAnalysing] = useState(false)
      const [question, setQuestion] = useState('')

      // The market is a *resolution hint*: a bare `BTC` is also a plausible US
      // ticker, so the server must be told which book the symbol came from.
      const hint = market || marketOfSymbol(symbol)
      const qs = `?market=${encodeURIComponent(hint)}`
      const quote = useAsync((signal) => apiGet(`/quote/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      const profile = useAsync((signal) => apiGet(`/profile/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      const chart = useAsync(
        (signal) =>
          apiGet(
            `/candles/${encodeURIComponent(symbol)}?range=${range}&interval=${RANGE_INTERVAL[range] || '1d'}&market=${encodeURIComponent(hint)}`,
            signal,
          ),
        [symbol, range, hint],
      )

      useEffect(() => {
        setTv(ui.tv)
      }, [ui.tv])
      useEffect(() => {
        setAnalysis(null)
        setAnalysisError(null)
      }, [symbol, lang])

      const data = quote.data
      const company = profile.data || {}
      const title = quote.loading && !data ? symbol : nameOf(Object.assign({}, company, data, { symbol }), symbol)
      const technical = chart.data && chart.data.technical
      const tech = technical && technical.technical
      const levels = (technical && technical.levels) || null
      const bars = (chart.data && chart.data.data && chart.data.data.candles) || []
      const chartMeta = chart.data && chart.data.meta
      // 0.7.0: how much history the indicator block rests on.
      const quality = (chart.data && chart.data.technicalMeta && chart.data.technicalMeta.quality) || (technical && technical.quality) || null

      const runAnalysis = useCallback(() => {
        setAnalysing(true)
        setAnalysisError(null)
        apiPost(`/analyze/${encodeURIComponent(symbol)}`, { lang, market: hint, question: question.trim() || undefined })
          .then((value) => {
            // The route answers { symbol, analysis, meta }; tolerate a flattened
            // payload too so a future server change cannot blank the section.
            const result = value && value.analysis ? value.analysis : value && value.summary !== undefined ? value : null
            // 0.7.0: keep the recency verdict so the panel can label the answer.
            setAnalysisMeta(value && value.meta ? value.meta : null)
            setAnalysis(
              result || {
                summary: t('No summary was returned.'),
                trend: { shortTerm: t('Unavailable.'), mediumTerm: t('Unavailable.'), longTerm: t('Unavailable.') },
                momentum: t('Unavailable.'),
                volume: t('Unavailable.'),
                supportLevels: [],
                resistanceLevels: [],
                riskFactors: [],
                keyObservations: [],
              },
            )
          })
          .catch((error) => setAnalysisError(error))
          .then(() => setAnalysing(false))
      }, [symbol, question, lang, t])

      return h(
        'div',
        { className: 'tm-detail' },
        h(
          'div',
          { className: 'tm-detail__head' },
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: onBack }, h(Icon, { name: 'back' }), t('Back')),
          h(
            'div',
            { className: 'tm-detail__id' },
            h('h2', { className: 'tm-detail__title' }, title),
            h(
              'div',
              { className: 'tm-detail__sub' },
              h('span', { className: 'tm-badge' }, symbol),
              company.exchange || (data && data.exchange) ? h('span', null, company.exchange || data.exchange) : null,
              h('span', null, (data && data.currency) || company.currency || ''),
              company.industry ? h('span', null, company.industry) : null,
            ),
          ),
          h(
            'div',
            { className: 'tm-detail__price' },
            h('span', { className: 'tm-detail__last ' + toneOf(data && data.price, data && data.previousClose) }, data ? money(data.price, data.currency) : '—'),
            h('span', { className: 'tm-detail__chg ' + trendClass(data && data.changePct) }, data ? `${signed(data.change, 2)}  ${percent(data.changePct)}` : t('Data unavailable')),
            h(Freshness, { data }),
          ),
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => { quote.reload(); profile.reload(); chart.reload() } }, h(Icon, { name: 'refresh' }), t('Refresh')),
          h('button', { className: 'tm-btn' + (tv ? ' tm-btn--active' : ''), onClick: () => { const next = !tv; setTv(next); setStore({ tv: next }) } }, 'TradingView'),
        ),
        h(SourcesRow, {
          record: Object.assign({}, company, data || {}, {
            symbol,
            market: (data && data.market) || company.market,
            exchange: company.exchange || (data && data.exchange),
          }),
        }),
        quote.error ? h(ErrorNote, { error: quote.error, onRetry: quote.reload }) : null,

        h(
          'div',
          { className: 'tm-ranges' },
          RANGES.map((key) =>
            h(
              'button',
              { key, className: 'tm-range' + (key === range ? ' tm-range--active' : ''), onClick: () => setStore({ range: key }) },
              RANGE_LABEL[key],
            ),
          ),
          chart.loading ? h('span', { className: 'tm-search__hint' }, t('loading bars…')) : null,
        ),
        h(Card, { title: t('Chart') }, chart.error ? h(ErrorNote, { error: chart.error, onRetry: chart.reload }) : null, h(CandleChart, { candles: bars, series: technical && technical.series, interval: chart.data && chart.data.data && chart.data.data.interval, degraded: Boolean(chartMeta && chartMeta.degraded) }), chartMeta ? h(Freshness, { meta: chartMeta, compact: true }) : null),

        tv
          ? h(
              Card,
              { title: t('TradingView (external embed)') },
              h('div', { className: 'tm-hint' }, t("Embedded third-party chart. Values shown here are TradingView's own and are not used by Trading Mode analytics.")),
              h('iframe', {
                className: 'tm-frame',
                src: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tradingViewSymbol(Object.assign({ symbol }, data, company)))}&interval=60&theme=light&style=1&hidesidetoolbar=0&locale=${lang}`,
                title: 'TradingView',
                allowFullScreen: true,
              }),
            )
          : null,

        h(
          'div',
          { className: 'tm-columns' },
          h(
            Card,
            { title: t('Market Data') },
            h(
              'div',
              { className: 'tm-grid' },
              h(Cell, { label: t('Open'), value: money(data && data.open, data && data.currency) }),
              h(Cell, { label: t('High'), value: money(data && data.high, data && data.currency) }),
              h(Cell, { label: t('Low'), value: money(data && data.low, data && data.currency) }),
              h(Cell, { label: t('Previous Close'), value: money(data && data.previousClose, data && data.currency) }),
              h(Cell, { label: t('Volume'), value: volumeText(data && data.volume) }),
              h(Cell, { label: t('Timestamp'), value: data ? dateTimeOf(data.timestamp) : '—' }),
              h(Cell, { label: t('Data source'), value: (data && data.source) || '—' }),
              h(Cell, { label: t('Freshness'), value: data ? ((quote.data && quote.data.stale) ? t('Last available data') : t('Data may be delayed')) : '—' }),
              company.marketCap ? h(Cell, { label: t('Market cap'), value: volumeText(company.marketCap), title: String(company.marketCap) }) : null,
              isNum(company.peRatio) ? h(Cell, { label: t('P/E'), value: plain(company.peRatio, 2) }) : null,
            ),
            company.description ? h('p', { className: 'tm-desc' }, company.description) : null,
          ),
          h(
            Card,
            { title: t('Technical Indicators') },
            quality && !quality.sufficient
              ? h(
                  'div',
                  { className: 'tm-note tm-note--warn' },
                  t('Not enough history for reliable indicators: only {n} daily bars are available (need {m}).').replace('{n}', String(quality.bars)).replace('{m}', String(quality.required)),
                )
              : quality && quality.grade && quality.grade !== 'full'
                ? h(
                    'div',
                    { className: 'tm-note' },
                    t('Limited history: {n} daily bars — long-term indicators (MA200, 52-week levels, 1-year change) are not reported.').replace('{n}', String(quality.bars)),
                  )
                : null,
            tech
              ? h(
                  'div',
                  { className: 'tm-grid' + (quality && !quality.sufficient ? ' tm-grid--muted' : '') },
                  technicalCells(tech, t).map((cell) => h(Cell, { key: cell.label, label: cell.label, value: cell.value, title: cell.title })),
                )
              : chart.loading
                ? h(Spinner, { label: t('Computing indicators…') })
                : h(Empty, null, t('Data unavailable')),
            levels && (levels.support || levels.resistance)
              ? h(
                  'div',
                  { className: 'tm-levels-block' },
                  h('span', { className: 'tm-levels-block__k' }, t('Reference levels (system-computed)')),
                  h(
                    'div',
                    { className: 'tm-levels' },
                    (levels.support || []).slice(0, 3).map((v, i) => h('span', { key: 's' + i, className: 'tm-level tm-level--sup' }, plain(v))),
                    (levels.resistance || []).slice(0, 3).map((v, i) => h('span', { key: 'r' + i, className: 'tm-level tm-level--res' }, plain(v))),
                  ),
                )
              : null,
          ),
        ),

        h(AiAnalysisSection, {
          symbol,
          analysis,
          loading: analysing,
          error: analysisError,
          onRun: runAnalysis,
          aiAvailable,
          aiReason,
          question,
          setQuestion,
          dataQuality: (analysisMeta && analysisMeta.dataQuality) || null,
        }),
        h('p', { className: 'tm-disclaimer' }, DISCLAIMER_FALLBACK),
      )
    }

    /** `600519.SH` → `SSE`/`SZSE`/`BSE`; falls back to the record's exchange. */
    function cnVenue(record) {
      const symbol = String((record && record.symbol) || '').toUpperCase()
      const suffix = symbol.includes('.') ? symbol.split('.').pop() : ''
      if (suffix === 'SH') return 'SSE'
      if (suffix === 'SZ') return 'SZSE'
      if (suffix === 'BJ') return 'BSE'
      const exchange = String((record && record.exchange) || '').toUpperCase()
      if (exchange.includes('SSE') || exchange.includes('SHANGHAI')) return 'SSE'
      if (exchange.includes('SZSE') || exchange.includes('SHENZHEN')) return 'SZSE'
      if (exchange.includes('BSE') || exchange.includes('BEIJING')) return 'BSE'
      return 'SSE'
    }

    /** Eastmoney/Tencent/Sina dialect prefix of a mainland listing. */
    function cnPrefix(record) {
      const venue = cnVenue(record)
      return venue === 'SZSE' ? 'sz' : venue === 'BSE' ? 'bj' : 'sh'
    }

    function tradingViewSymbol(record) {
      const symbol = String((record && record.symbol) || '')
      const links = (record && record.links) || {}
      // Indices (and anything else the server already resolved) arrive with an
      // explicit chart dialect such as `TVC:VIX`, `NASDAQ:IXIC`, `HKEX:700`.
      if (links.tradingView) return String(links.tradingView)
      const market = (record && record.market) || marketOfSymbol(symbol)
      if (market === 'CRYPTO') {
        const quote = String((record && (record.currency || record.quote)) || 'USDT').toUpperCase()
        return 'BINANCE:' + symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') + quote
      }
      if (market === 'HK') {
        const code = String(parseInt(symbol.replace(/\.HK$/, ''), 10))
        return 'HKEX:' + (code === 'NaN' ? symbol : code)
      }
      if (market === 'CN') return cnVenue(record) + ':' + symbol.split('.')[0]
      if (market === 'JP') return 'TSE:' + symbol.split('.')[0]
      const exchange = String((record && record.exchange) || '').toUpperCase()
      const venue = exchange.includes('NASDAQ') ? 'NASDAQ' : exchange.includes('NYSE') ? 'NYSE' : exchange.includes('AMEX') ? 'AMEX' : 'NASDAQ'
      return venue + ':' + symbol
    }

    /** Zero-padded digit code of a symbol (`0700.HK` → `00700`). */
    function digitsOf(symbol, width) {
      const raw = String(symbol == null ? '' : symbol)
        .replace(/\.HK$/i, '')
        .replace(/\D/g, '')
      const value = parseInt(raw, 10)
      return isFinite(value) ? String(value).padStart(width, '0') : raw
    }

    /**
     * External "data source" pages (user request m01395).
     *
     * These are ordinary public web pages the user opens in a browser tab. Nothing
     * here is scraped: §8 forbids TradingView scraping, reverse-engineered
     * sockets and front-end calls to the market-data providers — it does not
     * forbid linking to a public quote page. We deliberately never embed these
     * pages as a data feed.
     *
     * Checked again 2026-10-07 with probe-source-links.mjs / probe-link-candidates.mjs:
     * US/HK/CN `eastmoney` quote pages, `gu.qq.com` keys and the Sina company page
     * answer 200 with the right company title; the Beijing listing lives under
     * `/bj/<code>.html` (the flat `/bj<code>.html` form is 404); Tokyo has no
     * eastmoney page at all (`/jp/7203.html` is 404) but Yahoo!ファイナンス and
     * minkabu do; Yahoo's global quote pages answer 403 to scripted clients yet
     * still open in a browser. TradingView/Binance/Gate are unreachable from this
     * host (blocked, not wrong) — the URLs are the documented public forms.
     */
    /** Yahoo's dialect of a symbol (`600519.SH` → `600519.SS`, `BTC` → `BTC-USD`). */
    function yahooSymbol(record, market) {
      const symbol = String((record && record.symbol) || '')
      if (market === 'CN') {
        const venue = cnVenue(record)
        const code = symbol.split('.')[0]
        if (venue === 'SSE') return code + '.SS'
        if (venue === 'SZSE') return code + '.SZ'
        return null
      }
      if (market === 'CRYPTO') {
        const quote = String((record && (record.currency || record.quote)) || 'USDT').toUpperCase()
        return symbol.toUpperCase() + (quote === 'USDT' || quote === 'USD' ? '-USD' : '-' + quote)
      }
      return symbol
    }

    function SOURCE_LINKS(record) {
      const symbol = String((record && record.symbol) || '').trim()
      if (!symbol) return []
      const links = (record && record.links) || {}
      const market = (record && record.market) || marketOfSymbol(symbol)
      const isIndex = (record && record.kind === 'index') || symbol.charAt(0) === '^'
      const out = [
        {
          id: 'tradingview',
          label: 'TradingView',
          href: 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(links.tradingView || tradingViewSymbol(record)),
        },
      ]
      const yahoo = links.yahoo || yahooSymbol(record, market)
      if (yahoo) {
        out.push({
          id: 'yahoo',
          label: 'Yahoo Finance',
          href: 'https://finance.yahoo.com/quote/' + encodeURIComponent(yahoo),
        })
      }
      // The eastmoney global-index pages are 404, so indices only get the sites
      // that really have a page for them.
      if (!isIndex) {
        if (market === 'CRYPTO') {
          const pair = symbol.toUpperCase() + '_' + String((record && (record.currency || record.quote)) || 'USDT').toUpperCase()
          out.push({ id: 'binance', label: 'Binance', href: 'https://www.binance.com/en/trade/' + encodeURIComponent(pair) })
          out.push({ id: 'gate', label: 'Gate.io', href: 'https://www.gate.io/trade/' + encodeURIComponent(pair) })
        } else if (market === 'CN') {
          const code = symbol.split('.')[0]
          const venue = cnVenue(record)
          out.push({
            id: 'eastmoney',
            label: '东方财富',
            // Beijing listings live under `/bj/<code>.html`; the flat `bj<code>.html`
            // form that the Shanghai/Shenzhen prefix produces is a 404 there.
            href:
              venue === 'BSE'
                ? 'https://quote.eastmoney.com/bj/' + code + '.html'
                : 'https://quote.eastmoney.com/' + cnPrefix(record) + code + '.html',
          })
          out.push({
            id: 'sina',
            label: '新浪财经',
            href: 'https://finance.sina.com.cn/realstock/company/' + cnPrefix(record) + code + '/nc.shtml',
          })
        } else if (market === 'JP') {
          // No eastmoney page exists for Tokyo listings; the Japanese finance
          // portals do have one page per code.
          out.push({
            id: 'yahoojapan',
            label: 'Yahoo!ファイナンス',
            href: 'https://finance.yahoo.co.jp/quote/' + symbol.split('.')[0] + '.T',
          })
        } else {
          out.push({
            id: 'eastmoney',
            label: '东方财富',
            href:
              market === 'HK'
                ? 'https://quote.eastmoney.com/hk/' + digitsOf(symbol, 5) + '.html'
                : 'https://quote.eastmoney.com/us/' + encodeURIComponent(symbol.replace(/^\^/, '')) + '.html',
          })
        }
      }
      const tencentKey =
        links.tencentKey ||
        (market === 'HK'
          ? 'hk' + digitsOf(symbol, 5)
          : market === 'CN'
            ? cnPrefix(record) + symbol.split('.')[0]
            : market === 'US'
              ? 'us' + symbol.replace(/^\^/, '')
              : null)
      if (tencentKey && /^[a-z0-9.]+$/i.test(tencentKey)) {
        out.push({ id: 'tencent', label: '腾讯财经', href: 'https://gu.qq.com/' + encodeURIComponent(tencentKey) })
      }
      return out
    }

    /** A row of "open the source page" links (§8-safe: links only, never scraping). */
    function SourcesRow({ record, label, compact }) {
      const { t } = useT()
      const links = SOURCE_LINKS(record)
      if (!links.length) return null
      return h(
        'div',
        { className: compact ? 'tm-sources tm-sources--compact' : 'tm-sources' },
        h('span', { className: 'tm-sources__label' }, label === undefined ? t('Data source pages') : label),
        links.map((link) =>
          h(
            'a',
            {
              key: link.id,
              className: 'tm-source',
              href: link.href,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: t('Open {name} in a new tab', { name: link.label }),
            },
            link.label,
            h(Icon, { name: 'external', size: 12 }),
          ),
        ),
      )
    }

    /**
     * Market Overview strip (user request m01395, extended in 0.5.0 by m02818):
     * headline indices per market — VIX, Nasdaq Composite/100, S&P 500, Dow,
     * Hang Seng, HSCEI, Hang Seng TECH, plus the mainland and Tokyo benchmarks —
     * and, on its own tab, the crypto spotlight ranked by market cap.
     * Index levels are points, never presented as a tradable price (§21/§26);
     * crypto levels are spot prices and are labelled as such.
     */
    function MarketOverview({ onOpen }) {
      const { t } = useT()
      const [market, setMarket] = useState('US')
      const state = useAsync((signal) => apiGet(`/indices?market=${market}`, signal), [market])
      const data = state.data || {}
      const items = data.items || []
      const unavailable = data.unavailable || []
      const crypto = market === 'CRYPTO'

      return h(
        'section',
        { className: 'tm-card tm-card--overview' },
        h(
          'div',
          { className: 'tm-card__head' },
          h('h3', { className: 'tm-card__title' }, h(Icon, { name: 'globe', size: 14 }), crypto ? t('Crypto') : t('Market Overview')),
          h('span', { className: 'tm-card__meta' }, crypto ? t('Spot prices, 24/7 market') : t('Index levels, not tradable prices')),
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => state.reload() }, h(Icon, { name: 'refresh' }), t('Refresh')),
        ),
        h(
          'div',
          { className: 'tm-chips', role: 'group', 'aria-label': t('Market') },
          MARKET_ORDER.map((m) =>
            h(
              'button',
              {
                key: m,
                className: 'tm-chip' + (market === m ? ' tm-chip--active' : ''),
                onClick: () => setMarket(m),
              },
              t(MARKET_LABEL_KEY[m]),
            ),
          ),
        ),
        state.loading && !items.length ? h(Spinner, { label: crypto ? t('Loading crypto prices…') : t('Loading indices…') }) : null,
        state.error ? h(ErrorNote, { error: state.error, onRetry: state.reload }) : null,
        items.length
          ? h(
              'div',
              { className: 'tm-indices' },
              items.map((item) => h(IndexCell, { key: item.symbol, item, onOpen, market })),
            )
          : null,
        unavailable.length
          ? h(
              'p',
              { className: 'tm-hint tm-hint--tiny' },
              t('Data unavailable for {symbols}', { symbols: unavailable.map((row) => row.symbol).join(', ') }),
            )
          : null,
      )
    }

    function IndexCell({ item, onOpen, market }) {
      const { lang, t } = useT()
      const quote = item.quote || {}
      const meta = item.meta || {}
      const name = lang === 'zh' ? item.nameZh || item.name : item.name
      const stale = Boolean(meta.stale || quote.stale)
      const crypto = market === 'CRYPTO'
      return h(
        'div',
        { className: 'tm-index' },
        h(
          'button',
          {
            className: 'tm-index__main',
            onClick: () => onOpen(Object.assign({}, item, { market: item.market || market })),
            title: t('Open {name}', { name }),
          },
          h('span', { className: 'tm-index__name' }, name),
          h('span', { className: 'tm-index__symbol' }, item.symbol),
          h(
            'span',
            { className: 'tm-index__value' },
            crypto ? money(quote.price, quote.currency) : plain(quote.price, 2),
          ),
          h(
            'span',
            { className: 'tm-index__chg ' + trendClass(quote.changePct) },
            quote.changePct === undefined || quote.changePct === null
              ? '—'
              : `${signed(quote.change, 2)}  ${percent(quote.changePct)}`,
          ),
        ),
        h(
          'div',
          { className: 'tm-index__meta' },
          stale
            ? h('span', { className: 'tm-index__stale' }, t('Last available data'))
            : h('span', null, t('Updated {time}', { time: clockOf(quote.timestamp) })),
          h(SourcesRow, {
            record: Object.assign({}, item, { market: quote.market || item.market || market }),
            compact: true,
            label: '',
          }),
        ),
      )
    }

    // -------------------------------------------------------------- home / app
    function HomeView({ onOpen }) {
      const { ui, lang, t } = useT()
      const [brief, setBrief] = useState(null)
      const [briefError, setBriefError] = useState(null)
      const [briefLoading, setBriefLoading] = useState(false)
      const [fullBrief, setFullBrief] = useState(false)
      const bootstrap = useAsync((signal) => apiGet('/bootstrap', signal), [])

      const data = bootstrap.data || {}
      const rows = data.items || []
      const aiAvailable = Boolean(data.ai && data.ai.available)
      const aiReason = (data.ai && data.ai.reason) || null
      const owned = useMemo(() => new Set(rows.map((row) => row.symbol)), [rows])

      const reload = useCallback(() => bootstrap.reload(), [bootstrap])

      // The host keeps the language preference, so a fresh browser (or another
      // machine) opens the panel in the language the user last chose.
      useEffect(() => {
        if (bootstrap.data && bootstrap.data.settings) applyServerLang(bootstrap.data.settings)
      }, [bootstrap.data])

      const addSymbol = useCallback(
        (record) => {
          const symbol = typeof record === 'string' ? record : record && record.symbol
          if (!symbol) return
          apiPost('/watchlist', { symbol, market: record && record.market })
            .then(() => {
              setStore({ addMode: false })
              reload()
            })
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const removeSymbol = useCallback(
        (symbol) => {
          request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'DELETE' })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const favourite = useCallback(
        (symbol, isFavorite) => {
          request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'PATCH', body: { isFavorite } })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const move = useCallback(
        (from, to) => {
          const symbols = rows.map((row) => row.symbol)
          if (to < 0 || to >= symbols.length) return
          const next = symbols.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          request('/watchlist/order', { method: 'PATCH', body: { symbols: next } })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [rows, reload],
      )

      const runBrief = useCallback(() => {
        setBriefLoading(true)
        setBriefError(null)
        apiPost('/watchlist/analyze', { lang })
          .then((value) => {
            // The route answers { brief, meta }; tolerate a flattened payload too.
            setBrief(value && value.brief ? value.brief : value && value.headline !== undefined ? value : null)
          })
          .catch((error) => setBriefError(error))
          .then(() => setBriefLoading(false))
      }, [lang])

      return h(
        'div',
        { className: 'tm-home' },
        h(SearchBox, { onPick: (row) => (ui.addMode ? addSymbol(row) : onOpen(row)), addMode: ui.addMode, onAdd: addSymbol, autoFocus: ui.addMode }),
        h(ErrorNote, { error: bootstrap.error, onRetry: reload }),
        h(WatchlistCard, {
          rows,
          loading: bootstrap.loading,
          error: null,
          onOpen,
          onRemove: removeSymbol,
          onFavorite: favourite,
          onMove: move,
          onRefresh: reload,
          addMode: ui.addMode,
          onToggleAdd: () => setStore({ addMode: !ui.addMode }),
          identity: data.identity || null,
        }),
        h(MarketOverview, { onOpen }),
        ui.addMode
          ? h(
              Card,
              {
                title: t('Browse all US, HK, CN, JP & crypto listings'),
                right: h('span', { className: 'tm-hint tm-hint--tiny' }, t('Everything listed on NASDAQ, NYSE, AMEX, HKEX, SSE, SZSE, BSE, JPX and the top coins')),
              },
              h(UniverseBrowser, { onAdd: addSymbol, owned }),
            )
          : null,
        rows.length ? null : h(StarterPool, { recommendations: data.recommendations, onAdd: addSymbol }),
        h(BriefCard, {
          brief: fullBrief || !brief ? brief : brief,
          onRun: runBrief,
          onOpenFull: brief ? () => setFullBrief(!fullBrief) : null,
          loading: briefLoading,
          error: briefError,
          aiAvailable,
          aiReason,
        }),
        h('p', { className: 'tm-hint tm-hint--tiny' }, t('Market data providers: {chains}', { chains: JSON.stringify((data.status && data.status.chains) || {}) })),
      )
    }

    function TradingApp() {
      const { ui, t } = useT()
      const [statusForAi, setStatusForAi] = useState(null)

      useEffect(() => {
        if (!ui.open || statusForAi) return undefined
        let alive = true
        apiGet('/status')
          .then((value) => {
            if (!alive) return
            setStatusForAi(value)
            if (value && value.settings) applyServerLang(value.settings)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [ui.open, statusForAi])

      useEffect(() => {
        if (!ui.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setStore({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [ui.open])

      if (!ui.open) return null

      const aiAvailable = Boolean(statusForAi && statusForAi.ai && statusForAi.ai.available)
      const aiReason = (statusForAi && statusForAi.ai && statusForAi.ai.reason) || null

      return h(
        'div',
        { className: 'tm-layer tm-scheme--' + effectiveTheme(ui) },
        h(
          'div',
          { className: 'tm-window', role: 'dialog', 'aria-label': 'DSH Trading Mode' },
          h(
            'header',
            { className: 'tm-header' },
            h('span', { className: 'tm-header__brand' }, h(Icon, { name: 'chart' }), 'DSH Trading Mode'),
            h(
              'nav',
              { className: 'tm-tabs' },
              h('button', { className: 'tm-tab' + (ui.view === 'home' ? ' tm-tab--active' : ''), onClick: () => setStore({ view: 'home' }) }, t('Home')),
              ui.symbol
                ? h('button', { className: 'tm-tab' + (ui.view === 'detail' ? ' tm-tab--active' : ''), onClick: () => setStore({ view: 'detail' }) }, ui.symbol)
                : null,
            ),
            h(StatusStrip, {
              status: statusForAi && statusForAi.status,
              ai: statusForAi && statusForAi.ai,
              watchlistBackend: statusForAi && statusForAi.watchlist && statusForAi.watchlist.backend,
              cacheBackend: statusForAi && statusForAi.config && statusForAi.config.cacheBackend,
            }),
            h(ThemeToggle),
            h(LangToggle),
            h('button', { className: 'tm-iconbtn', title: t('Close'), onClick: () => setStore({ open: false }) }, h(Icon, { name: 'close' })),
          ),
          h(
            'div',
            { className: 'tm-body' },
            ui.view === 'detail' && ui.symbol
              ? h(DetailView, { symbol: ui.symbol, market: ui.symbolMarket || null, onBack: () => setStore({ view: 'home' }), aiAvailable, aiReason })
              : h(HomeView, {
                  onOpen: (target) => {
                    const record = typeof target === 'string' ? { symbol: target } : target || {}
                    if (!record.symbol) return
                    setStore({ view: 'detail', symbol: record.symbol, symbolMarket: record.market || null })
                  },
                }),
          ),
          h(
            'footer',
            { className: 'tm-footer' },
            h('span', null, t('Market research only — no order routing, no brokerage connection. Market data may be delayed.')),
            h('span', null, t('AI output is generated from system-supplied structured data; it is not financial advice.')),
          ),
        ),
      )
    }

    function TradingButton() {
      const { ui, t } = useT()
      return h(
        'button',
        {
          className: 'tm-trigger' + (ui.open ? ' tm-trigger--active' : ''),
          title: 'DSH Trading Mode',
          onClick: () => setStore({ open: !ui.open }),
        },
        h(Icon, { name: 'chart' }),
        h('span', { className: 'tm-trigger__label' }, t('Trading Mode')),
      )
    }

    // -------------------------------------------------------------------- css
    const CSS = `
      /* Theme (user request m11109). The panel paints every surface from its OWN
         opaque palette instead of the host alias tokens: a custom DSH theme (or
         a portal mounted outside the themed subtree) can leave
         \`--dsw-alias-bg-overlay\` undefined, and \`var(--token, fallback)\` is
         then invalid at computed-value time — the declaration loses the property
         entirely, so the window turns transparent instead of falling back.
         Literal colours cannot fail that way, which is what keeps the panel
         opaque. \`.tm-scheme--dark\` = white on black (default),
         \`.tm-scheme--light\` = black on white. */
      .tm-layer { --tm-bg: #000000; --tm-surface: #0c0c0f; --tm-surface-2: #191920; --tm-overlay: #111116; --tm-text: #ffffff; --tm-text-dim: #b6b6c2; --tm-border-1: #26262e; --tm-border-2: #3a3a46; --tm-brand: #4b8bf5; --tm-up: #35c98a; --tm-down: #ff6b5e; --tm-up-ink: #6fd0a0; --tm-down-ink: #eba294; --tm-up-soft: rgba(53,201,138,.16); --tm-down-soft: rgba(255,107,94,.16); --tm-warn: #e3b341; --tm-err: #e0836f; --tm-ma20: #e0b64a; --tm-ma50: #5aa7e0; --tm-ma200: #b07de0; --tm-vol: rgba(120,130,150,.28); --tm-vol-up: rgba(53,201,138,.35); }
      .tm-layer.tm-scheme--light { --tm-bg: #ffffff; --tm-surface: #f6f6f9; --tm-surface-2: #e8e8ef; --tm-overlay: #ffffff; --tm-text: #101014; --tm-text-dim: #55555f; --tm-border-1: #e1e1e8; --tm-border-2: #c5c5d0; --tm-brand: #2563eb; --tm-up: #0f7a4d; --tm-down: #c02a1e; --tm-up-ink: #0b5c3a; --tm-down-ink: #9c2519; --tm-up-soft: rgba(15,122,77,.12); --tm-down-soft: rgba(192,42,30,.12); --tm-warn: #8a6400; --tm-err: #b02a1c; --tm-ma20: #9a7b00; --tm-ma50: #1f6fb2; --tm-ma200: #7a45b5; --tm-vol: rgba(90,100,120,.22); --tm-vol-up: rgba(15,122,77,.28); }
      /* Point the host alias names at the panel palette so every rule below
         follows the scheme without a second set of values. */
      .tm-layer { --dsw-alias-bg-base: var(--tm-bg); --dsw-alias-bg-layer-1: var(--tm-surface); --dsw-alias-bg-layer-2: var(--tm-surface-2); --dsw-alias-bg-overlay: var(--tm-overlay); --dsw-alias-label-primary: var(--tm-text); --dsw-alias-label-secondary: var(--tm-text-dim); --dsw-alias-border-l1: var(--tm-border-1); --dsw-alias-border-l2: var(--tm-border-2); --dsw-alias-brand-primary: var(--tm-brand); --dsw-alias-state-warn-primary: var(--tm-warn); }

      .tm-themes { display: inline-flex; border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 999px; overflow: hidden; }
      .tm-thm { border: 0; background: transparent; color: var(--tm-text-dim, #b6b6c2); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; line-height: 1.6; }
      .tm-thm + .tm-thm { border-left: 1px solid var(--tm-border-1, #26262e); }
      .tm-thm:hover { background: var(--tm-surface-2, #191920); color: var(--tm-text, #ffffff); }
      .tm-thm--active { background: var(--tm-brand, #4b8bf5); color: #fff; }

      .tm-trigger { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; font: inherit; }
      .tm-trigger:hover { background: var(--dsw-alias-bg-layer-1, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-trigger--active { color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-trigger__label { font-size: 12px; white-space: nowrap; }

      .tm-layer { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; pointer-events: none; }
      .tm-window { pointer-events: auto; display: flex; flex-direction: column; width: min(1180px, 96vw); height: min(820px, 92vh); background: var(--tm-bg, #000000); border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 14px; box-shadow: 0 24px 80px rgba(0,0,0,.55); color: var(--tm-text, #ffffff); overflow: hidden; }
      .tm-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262626); background: var(--dsw-alias-bg-layer-1, #161616); }
      .tm-header__brand { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
      .tm-tabs { display: flex; gap: 4px; margin-left: 6px; }
      .tm-tab { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
      .tm-tab:hover { background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-tab--active { background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); border-color: var(--dsw-alias-border-l2, #333); }
      .tm-body { flex: 1; overflow: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
      .tm-footer { display: flex; justify-content: space-between; gap: 12px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #262626); font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); background: var(--dsw-alias-bg-layer-1, #161616); }

      .tm-langs { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #343434); border-radius: 999px; overflow: hidden; }
      .tm-lang { border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; line-height: 1.6; }
      .tm-lang + .tm-lang { border-left: 1px solid var(--dsw-alias-border-l1, #2b2b2b); }
      .tm-lang:hover { background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-lang--active { background: var(--dsw-alias-brand-primary, #4b8bf5); color: #fff; }

      .tm-card { border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #171717); }
      .tm-card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #242424); }
      .tm-card__title { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; }
      .tm-card__tools { display: flex; gap: 6px; }
      .tm-card__body { padding: 10px 12px; }
      .tm-card__meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8f8f8f); }

      .tm-indices { display: grid; grid-template-columns: repeat(auto-fit, minmax(186px, 1fr)); gap: 8px; padding: 10px 12px; }
      .tm-index { display: flex; flex-direction: column; gap: 4px; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l1, #262626); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #1c1c1c); }
      .tm-index__main { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'name value' 'symbol chg'; align-items: baseline; column-gap: 8px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .tm-index__name { grid-area: name; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-index__symbol { grid-area: symbol; font-size: 10px; letter-spacing: .02em; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-index__value { grid-area: value; font-size: 14px; font-variant-numeric: tabular-nums; }
      .tm-index__chg { grid-area: chg; font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
      .tm-index__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-index__stale { color: var(--dsw-alias-state-warn-primary, #e3b341); }
      .tm-sources { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .tm-sources__label { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-source { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l2, #343434); border-radius: 999px; font-size: 11px; color: var(--dsw-alias-label-secondary, #b0b0b0); text-decoration: none; }
      .tm-source:hover { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }

      .tm-btn { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 7px; cursor: pointer; }
      .tm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .tm-btn--ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-btn--ghost:hover { background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-btn--active { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #8f8f8f); cursor: pointer; }
      .tm-iconbtn:hover { background: var(--dsw-alias-bg-layer-2, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-iconbtn--on { color: var(--tm-warn, #e3b341); }

      .tm-search { position: relative; }
      .tm-search__field { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #171717); color: var(--dsw-alias-label-secondary, #999); }
      .tm-input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 13px; }
      .tm-search__hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
      .tm-results { list-style: none; margin: 6px 0 0; padding: 0; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 9px; overflow: hidden; background: var(--dsw-alias-bg-layer-1, #171717); }
      .tm-result { display: flex; align-items: stretch; border-bottom: 1px solid var(--dsw-alias-border-l1, #222); }
      .tm-result:last-child { border-bottom: 0; }
      .tm-result__main { flex: 1; display: flex; align-items: baseline; gap: 8px; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 7px 10px; cursor: pointer; }
      .tm-result__main:hover { background: var(--dsw-alias-bg-layer-2, #202020); }
      .tm-result__sym { font-weight: 600; font-size: 12.5px; min-width: 82px; }
      .tm-result__name { font-size: 12.5px; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-result__meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }

      .tm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .tm-list--plain { gap: 4px; padding-left: 4px; }
      .tm-list--plain li { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; }
      .tm-row:hover { background: var(--dsw-alias-bg-layer-2, #1d1d1d); }
      .tm-row__main { flex: 1; min-width: 0; display: grid; grid-template-columns: 96px 1fr; grid-template-rows: auto auto; gap: 1px 8px; cursor: pointer; }
      .tm-row__sym { grid-row: span 2; font-weight: 600; font-size: 13px; align-self: center; }
      .tm-row__name { font-size: 12px; color: var(--dsw-alias-label-primary, #ddd); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-row__err { font-size: 11px; color: var(--tm-err, #e0836f); }
      .tm-row__quote { display: flex; align-items: baseline; gap: 8px; }
      .tm-row__price { font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .tm-row__chg { font-size: 12px; font-variant-numeric: tabular-nums; }
      .tm-row__ts { font-size: 11px; color: var(--dsw-alias-label-secondary, #7f7f7f); }
      .tm-row__tools { display: flex; gap: 2px; }

      .tm-detail { display: flex; flex-direction: column; gap: 12px; }
      .tm-detail__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .tm-detail__id { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
      .tm-detail__title { margin: 0; font-size: 17px; }
      .tm-detail__sub { display: flex; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #999); flex-wrap: wrap; }
      .tm-badge { border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
      .tm-detail__price { display: flex; flex-direction: column; gap: 2px; margin-left: auto; }
      .tm-detail__last { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .tm-detail__chg { font-size: 12.5px; font-variant-numeric: tabular-nums; }

      .tm-ranges { display: flex; gap: 4px; }
      .tm-range { border: 1px solid var(--dsw-alias-border-l2, #333); background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 999px; cursor: pointer; }
      .tm-range:hover { color: var(--dsw-alias-label-primary, #eee); }
      .tm-range--active { background: var(--dsw-alias-brand-primary, #4b8bf5); border-color: transparent; color: #fff; }

      .tm-chart { display: flex; flex-direction: column; gap: 4px; }
      .tm-chart__svg { width: 100%; height: 340px; display: block; }
      .tm-chart__grid { stroke: var(--dsw-alias-border-l1, #2a2a2a); stroke-width: 1; vector-effect: non-scaling-stroke; }
      .tm-chart__wick { stroke-width: 1; vector-effect: non-scaling-stroke; }
      .tm-chart__body { stroke: none; }
      .tm-up-stroke { stroke: var(--tm-up, #35c98a); } .tm-down-stroke { stroke: var(--tm-down, #ff6b5e); }
      .tm-up-fill { fill: var(--tm-up, #35c98a); } .tm-down-fill { fill: var(--tm-down, #ff6b5e); }
      .tm-chart__vol { fill: var(--tm-vol, rgba(120,130,150,.28)); }
      .tm-chart__vol--up { fill: var(--tm-vol-up, rgba(53,201,138,.35)); }
      .tm-chart__ma { stroke-width: 1.4; vector-effect: non-scaling-stroke; }
      .tm-chart__ma--ma20 { stroke: var(--tm-ma20, #e0b64a); } .tm-chart__ma--ma50 { stroke: var(--tm-ma50, #5aa7e0); } .tm-chart__ma--ma200 { stroke: var(--tm-ma200, #b07de0); }
      .tm-chart__legend, .tm-chart__footer { display: flex; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8c8c8c); flex-wrap: wrap; }
      .tm-chart__ma-key--ma20 { color: var(--tm-ma20, #e0b64a); } .tm-chart__ma-key--ma50 { color: var(--tm-ma50, #5aa7e0); } .tm-chart__ma-key--ma200 { color: var(--tm-ma200, #b07de0); }

      .tm-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 900px) { .tm-columns { grid-template-columns: 1fr; } }
      .tm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; }
      .tm-cell { display: flex; flex-direction: column; gap: 1px; }
      .tm-cell__k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-cell__v { font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .tm-desc { margin: 8px 0 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #a5a5a5); }
      .tm-up { color: var(--tm-up, #35c98a); } .tm-down { color: var(--tm-down, #ff6b5e); } .tm-flat { color: inherit; }

      .tm-fresh { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #8f8f8f); flex-wrap: wrap; }
      .tm-fresh--compact { font-size: 10.5px; }
      .tm-fresh--stale .tm-fresh__time { color: var(--tm-warn, #e3b341); }
      .tm-fresh__note { opacity: .85; }
      .tm-fresh__why { border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 999px; padding: 0 6px; }
      .tm-chart__partial { border: 1px solid var(--tm-warn, #e3b341); color: var(--tm-warn, #e3b341); border-radius: 999px; padding: 0 6px; cursor: help; }
      .tm-note { margin: 6px 0; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #a5a5a5); }
      .tm-note--warn { border-left: 2px solid var(--tm-warn, #e3b341); padding-left: 8px; color: var(--tm-warn, #e3b341); }
      .tm-grid--muted { opacity: .6; }
    .tm-hint__why { margin-top: 4px; opacity: .8; font-size: 12px; }

      .tm-ai { display: flex; flex-direction: column; gap: 8px; }
      .tm-ai__summary { margin: 0; font-size: 13px; line-height: 1.55; }
      .tm-ai__h { margin: 6px 0 2px; font-size: 12px; color: var(--dsw-alias-label-secondary, #9a9a9a); text-transform: uppercase; letter-spacing: .05em; }
      .tm-ask { margin-bottom: 8px; display: flex; }
      .tm-ask .tm-input { border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 8px; padding: 6px 9px; background: var(--dsw-alias-bg-layer-2, #1c1c1c); }
      .tm-levels { display: flex; gap: 6px; flex-wrap: wrap; }
      .tm-level { border-radius: 6px; padding: 1px 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
      .tm-level--sup { background: var(--tm-up-soft, rgba(53,201,138,.16)); color: var(--tm-up-ink, #6fd0a0); }
      .tm-level--res { background: var(--tm-down-soft, rgba(255,107,94,.16)); color: var(--tm-down-ink, #eba294); }
      .tm-levels-block { margin-top: 10px; }
      .tm-levels-block__k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); display: block; margin-bottom: 4px; }
      .tm-brief { display: flex; flex-direction: column; gap: 6px; }
      .tm-brief__headline { margin: 0; font-size: 13px; font-weight: 600; }
      .tm-brief__counts { display: flex; gap: 18px; margin: 2px 0; }
      .tm-brief p { margin: 0; font-size: 12.5px; line-height: 1.5; }

      .tm-status { display: flex; align-items: center; gap: 8px; margin-left: auto; position: relative; }
      .tm-status__pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l1, #2f2f2f); background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer; }
      .tm-status__active { opacity: .7; }
      .tm-status__meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #7f7f7f); }
      .tm-status__pop { position: absolute; top: 26px; right: 0; z-index: 5; width: 380px; padding: 8px; border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 9px; background: var(--tm-overlay, #111116); box-shadow: 0 10px 30px rgba(0,0,0,.4); display: flex; flex-direction: column; gap: 4px; }
      .tm-status__row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
      .tm-status__name { font-weight: 600; }
      .tm-status__stats { color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-status__err { color: var(--tm-err, #e0836f); margin-left: auto; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tm-text-dim, #777); display: inline-block; }
      .tm-dot--ok { background: var(--tm-up, #35c98a); } .tm-dot--bad { background: var(--tm-down, #ff6b5e); }

      .tm-chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .tm-chip { border: 1px solid var(--dsw-alias-border-l2, #333); background: transparent; color: var(--dsw-alias-label-primary, #ddd); font: inherit; font-size: 12px; padding: 2px 9px; border-radius: 999px; cursor: pointer; }
      .tm-chip:hover { border-color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-chip--active { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-universe { display: flex; flex-direction: column; gap: 10px; }
      .tm-universe__bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
      .tm-universe__filter { display: flex; }
      .tm-universe__tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
      .tm-universe__list { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 9px; }
      .tm-universe__row { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 5px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #2a2a2a); }
      .tm-universe__row:last-child { border-bottom: none; }
      .tm-universe__row:hover { background: var(--dsw-alias-bg-layer-2, #1d1d1d); }
      .tm-universe__sym { font-weight: 600; font-variant-numeric: tabular-nums; }
      .tm-universe__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-universe__meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8f8f8f); white-space: nowrap; }
      /* The TradingView embed is a third-party page with its own light chrome:
         it stays white in both schemes on purpose. */
      .tm-frame { width: 100%; height: 460px; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 8px; background: #fff; }
      .tm-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8f8f8f); line-height: 1.5; }
      .tm-hint--tiny { font-size: 10.5px; opacity: .75; word-break: break-word; }
      .tm-empty { padding: 14px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-error { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--tm-down, #ff6b5e); background: var(--tm-down-soft, rgba(255,107,94,.16)); border-radius: 8px; font-size: 12px; }
      .tm-error__msg { flex: 1; }
      .tm-spinner { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8f8f8f); padding: 6px 0; }
      .tm-spinner__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4b8bf5); animation: dsh-trading-mode-pulse 1.1s ease-in-out infinite; }
      @keyframes dsh-trading-mode-pulse { 0%,100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.1); } }
      .tm-disclaimer { margin: 4px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #858585); }
    `

    // -------------------------------------------------------------------- apply
    const module = { exports: {} }

    const name = 'trading-mode'
    const inject = ['slots']

    /**
     * Follow the DSH interface language unless the user picked one here.
     * `ctx.get('locale')` is an optional client service — when this build does
     * not expose it the panel stays switchable and defaults to the browser
     * language.
     */
    function bindPlatformLocale(ctx) {
      let browserLang = 'en'
      try {
        if (typeof navigator !== 'undefined' && navigator.language) browserLang = normalizeLang(navigator.language) || 'en'
      } catch (_) {
        /* no navigator (tests) */
      }
      setStore({ platformLang: browserLang })
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
        if (!locale || typeof locale.getLocale !== 'function') return null
        const read = () => normalizeLang((locale.getLocale() || {}).active) || 'en'
        setStore({ platformLang: read() })
        if (typeof locale.subscribe === 'function') {
          const unsubscribe = locale.subscribe(() => setStore({ platformLang: read() }))
          ctx.effect(
            () => () => {
              try {
                if (typeof unsubscribe === 'function') unsubscribe()
              } catch (_) {
                /* the service is already gone */
              }
            },
            'dsh-trading-mode: locale',
          )
        }
        return locale
      } catch (_) {
        return null
      }
    }

    function apply(ctx) {
      bindPlatformLocale(ctx)
      bindPlatformTheme(ctx)

      // 注入一次 <style> 到页面；卸载时移除。
      const styleTag = document.createElement('style')
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
      ctx.effect(() => () => {
        if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
      }, 'dsh-trading-mode: styles')

      // 注意：slot 注册的第二参是「组件」，会被 jsx(Comp, ...) 渲染。
      // 必须传元素 () => h(Component)，不要 () => Component()——
      // 后者把带 hooks 的组件当普通函数直接调用，hooks 会绑错 fiber。
      // `ctx.slots.inject(slot, cb)` takes a plain callback that returns the
      // registration's disposer — the same shape the shipped third-party
      // plugins use, and the only one that works whether the host consumes a
      // callback or an effect generator.
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'trading-mode', order: 30, label: 'Trading Mode' },
          () => h(TradingButton),
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'trading-mode-app', order: 500, label: 'DSH Trading Mode' },
          () => h(TradingApp),
        ),
      )
    }

    // `_internals` is a test hook only — the DSH client module loader reads
    // apply/inject/name and ignores everything else.
    module.exports = {
      apply,
      inject,
      name,
      _internals: {
        store,
        setStore,
        ZH,
        LANGS,
        makeT,
        translate,
        normalizeLang,
        effectiveLang,
        applyServerLang,
        persistLang,
        THEME_SCHEMES,
        normalizeTheme,
        effectiveTheme,
        applyThemeSnapshot,
        bindPlatformTheme,
        persistTheme,
        ThemeToggle,
        TradingApp,
        TradingButton,
        LangToggle,
        HomeView,
        DetailView,
        BriefCard,
        AiAnalysisSection,
        SearchBox,
        CandleChart,
        MarketOverview,
        IndexCell,
        SourcesRow,
        SOURCE_LINKS,
        UniverseBrowser,
        UniverseRow,
        UNIVERSE_PAGE_SIZE,
        MARKET_ORDER,
        MARKET_LABEL_KEY,
        marketOfSymbol,
        cnVenue,
        cnPrefix,
        yahooSymbol,
        digitsOf,
        buildGeometry,
        downsample,
        tradingViewSymbol,
        technicalCells,
        money,
        percent,
        volumeText,
        clockOf,
        nameOf,
      },
    }
    return module.exports
  },
})
