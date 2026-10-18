/**
 * DSH Trading Mode — AI-powered Market Research & Watchlist Assistant (V0.1).
 *
 * Host entry point. Wires the four modules the spec keeps separate (§75):
 *
 *   providers/ → router.js → service.js   market data, provider-agnostic
 *   watchlist.js                          private, per-user membership only
 *   ai.js                                 DeepSeek, structured data in / JSON out
 *   api.js                                the HTTP surface the client calls
 *
 * This file deliberately contains no market data access, no indicator maths and
 * no prompt text: it only composes the modules and owns the lifecycle.
 */

import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';

import { AI_CONFIG, DISCLAIMER, IDENTITY_POLICY, allowUnfencedLoopback, applyProviderChains, setAllowUnfencedLoopback, setNetworkMode } from './trading/config.js';
import { TradingAi } from './trading/ai.js';
import { ApiRoutes } from './trading/api.js';
import { MarketDataService } from './trading/service.js';
import { FileCachePersist } from './trading/persist.js';
import { UserSettingsStore } from './trading/settings.js';
import { StockUniverse } from './trading/universe.js';
import { WatchlistStore } from './trading/watchlist.js';

export const name = 'trading-mode';

const requireFromHere = createRequire(import.meta.url);

/**
 * The version this build actually reports. Read from `package.json` so there is
 * exactly one source of truth, and reported by the fence-independent
 * `GET /api/trading/health` route (0.8.0).
 */
export const PLUGIN_VERSION = (() => {
  try {
    const version = requireFromHere('../package.json')?.version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
})();

/** The webserver serves our prefix route; the connection owns the request fence. */
export const inject = ['connection', 'webServer'];

export const TRADING_API_PREFIX = '/api/trading';

/**
 * Resolve a host service lazily and defensively. The plugin applies before every
 * service is guaranteed to be registered (and the `llm` plugin may bind after
 * us), so `TradingAi` must be handed a *getter*: resolving at call time is what
 * makes the AI brief work at all. Three lookup routes are tried because a host
 * may expose the service through `ctx.get`, the root registry, or as a property.
 */
export function serviceGetter(ctx, name) {
  return () => {
    for (const lookup of [
      () => ctx.get?.(name),
      () => ctx.root?.get?.(name),
      () => ctx[name],
    ]) {
      try {
        const value = lookup();
        if (value) return value;
      } catch {
        // not reachable through this route — try the next one
      }
    }
    return null;
  };
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  const homeDir = resolveHomeDir();
  // User configuration first (0.6.0, tasks B1/B2): a bad value is reported once
  // and the conservative default stays in force — never a silent change and
  // never a failed start.
  const configProblems = applyUserConfig(config, logger);
  const cachePersist = new FileCachePersist({
    filePath: config.cachePath || path.join(homeDir, 'trading-mode', 'market-cache.json'),
    logger,
  });
  const watchlist = new WatchlistStore({ logger, homeDir });
  const settings = new UserSettingsStore({
    logger,
    filePath: config.settingsPath || path.join(homeDir, 'trading-mode', 'settings.json'),
  });
  const universe = new StockUniverse({
    logger,
    filePath: config.universePath || path.join(homeDir, 'trading-mode', 'universe.json'),
  });
  let service = null;
  let ai = null;
  let api = null;
  /** Resolved in `ready`; never a fabricated shared bucket (0.8.0, round-3 P1⑦). */
  let identity = { id: null, source: 'pending', persistent: false };
  let initError = null;

  const ready = (async () => {
    identity = await resolveIdentity(config.identity || {}, logger);
    await universe.init();
    service = await new MarketDataService({ logger, cachePersist, universe }).init();
    await watchlist.init({ ctx });
    await settings.init();
    ai = new TradingAi({
      // Getters, not values: the plugin applies before every service is
      // guaranteed to be registered, and the LLM plugin (id `llm`) may bind
      // after us. Resolving at call time is what makes the brief work.
      // Three lookup routes so a host that only exposes one of them still works.
      llm: serviceGetter(ctx, 'llm'),
      defaultModel: serviceGetter(ctx, 'agentDefaultModel'),
      logger,
      config: { ...AI_CONFIG, ...(config.ai || {}) },
    });
    api = new ApiRoutes({
      service,
      ai,
      watchlist,
      settings,
      identity: () => identity,
      version: PLUGIN_VERSION,
      logger,
      connection: ctx.get?.('connection'),
      config: { problems: configProblems },
    });
    const fenced = typeof ctx.get?.('connection')?.requestRejection === 'function';
    logger.info(
      `trading-mode: ready (market cache: ${cachePersist.name}; watchlist: ${watchlist.backend}; settings: ${settings.info().backend}; universe: ${universe.info().size} listings; providers: ${[...service.providers.keys()].join(', ')}; ai: ${ai.available ? 'available' : `unavailable — ${ai.unavailableReason()}`}; identity: ${identity.source}${identity.id ? '' : ' (per-user data refused)'}; request fence: ${fenced ? 'host' : allowUnfencedLoopback() ? 'OPEN — loopback debugging exception' : 'unavailable — the API refuses with 503'})`,
    );
    if (!fenced && !allowUnfencedLoopback()) {
      logger.error(
        'trading-mode: SECURITY — the host request fence is unavailable, so every route except `GET /api/trading/health` answers 503 HOST_SECURITY_UNAVAILABLE. Do not expose this port to an untrusted network.',
      );
    }
    return true;
  })().catch((err) => {
    initError = err;
    logger.error(`trading-mode: initialisation failed — ${err && err.message}`);
    return false;
  });

  // The route is registered immediately so an initialisation failure is
  // *reported* to the UI (503 + INIT_FAILED) instead of surfacing as a 404 or,
  // worse, as an empty success (§43/§77.27).
  const webServer = ctx.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    logger.error('trading-mode: the webServer service is unavailable; the Trading API cannot be served');
    return () => {};
  }

  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: TRADING_API_PREFIX,
    handler: async (req, res) => {
      try {
        await ready;
      } catch {
        /* handled below */
      }
      if (initError || !api) {
        return sendJson(res, 503, {
          ok: false,
          error: {
            code: 'INIT_FAILED',
            message: `Trading Mode failed to initialise: ${initError ? initError.message : 'unknown error'}`,
          },
        });
      }
      return api.handle(req, res);
    },
  });

  const dispose = () => {
    try {
      if (typeof disposeRoute === 'function') disposeRoute();
    } catch (err) {
      logger.warn?.(`trading-mode: route dispose failed: ${err && err.message}`);
    }
    try {
      api?.dispose();
    } catch {
      /* already gone */
    }
    Promise.resolve(watchlist.dispose()).catch(() => {});
    Promise.resolve(settings.flush()).catch(() => {});
    Promise.resolve(universe.flush()).catch(() => {});
    Promise.resolve(service?.cache?.flush()).catch(() => {});
  };

  ctx.effect?.(() => dispose, 'trading-mode:dispose');
  logger.info(`trading-mode: API route registered at ${TRADING_API_PREFIX}`);
  return dispose;
}

/**
 * Apply the user's `providers` (per-market chain override), `networkMode` and
 * `security.allowUnfencedLoopback` configuration (0.6.0 tasks B1/B2; the
 * security switch is 0.8.0). Returns the list of problems it found; every
 * problem is logged with the accepted values and the shipped default is left in
 * force, because a typo in a config file must not take the plugin down.
 */
function applyUserConfig(config, logger) {
  const problems = [];
  try {
    const { applied, problems: chainProblems } = applyProviderChains(config.providers);
    problems.push(...chainProblems);
    if (applied.length) logger.info(`trading-mode: provider chains overridden for ${applied.join(', ')}`);
  } catch (err) {
    problems.push(`providers: ${err && err.message}`);
  }
  try {
    if (config.networkMode !== undefined) {
      const mode = setNetworkMode(config.networkMode);
      logger.info(`trading-mode: networkMode = ${mode}`);
    }
  } catch (err) {
    problems.push(`networkMode: ${err && err.message}`);
  }
  try {
    // 0.8.0: the fail-closed fence has exactly one opt-out, and it must be asked
    // for in plain sight. Enabling it is announced at error level, not info.
    const declared = config.security && typeof config.security === 'object' ? config.security.allowUnfencedLoopback : undefined;
    if (declared !== undefined) {
      const enabled = setAllowUnfencedLoopback(declared);
      if (enabled) {
        logger.error(
          'trading-mode: SECURITY — security.allowUnfencedLoopback is enabled in plugin config. Requests from loopback peers will be served WITHOUT the host request fence. This is a debugging exception for this machine only; anyone who can reach this port from another host is still refused.',
        );
      } else {
        logger.info('trading-mode: security.allowUnfencedLoopback = false (fail-closed fence stays in force)');
      }
    }
  } catch (err) {
    problems.push(`security.allowUnfencedLoopback: ${err && err.message}`);
  }
  for (const problem of problems) {
    logger.error(`trading-mode: invalid configuration — ${problem} (the shipped default stays in force)`);
  }
  return problems;
}

// --------------------------------------------------------------------- helpers

function makeLogger(ctx) {
  try {
    const scoped = ctx.logger?.(name);
    if (scoped) return scoped;
  } catch {
    /* fall through to the console */
  }
  return console;
}

/** `$DSH_HOME` when the host exports it, otherwise the conventional `~/.dsh`. */
function resolveHomeDir() {
  for (const key of ['DSH_HOME', 'DSH_DIR']) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return path.join(os.homedir(), '.dsh');
}

/**
 * The DSH user id (§11). DSH has no user table; the supported stable identity is
 * the anonymous user id the harness itself persists, and it is what
 * `dsh-llm-deepseek` already sends upstream.
 *
 * 0.8.0 (round-3 P1⑦) removed the silent fallback to one shared `local` bucket:
 * when the host identity is unavailable the plugin reports "no identity" and
 * refuses per-user storage, unless the operator explicitly names a single-user
 * bucket (`identity.localBucket`), which is an acknowledgement, not a guess.
 *
 * @returns {Promise<{id: string|null, source: 'host-anonymous-id'|'configured-local-bucket'|'none', persistent: boolean}>}
 */
export async function resolveIdentity(config = {}, logger = null) {
  try {
    const mod = await import('@deepseek-ai/dsh-anonymous-user-id');
    const id = mod.getOrCreateAnonymousUserId?.();
    if (id) return { id: String(id), source: 'host-anonymous-id', persistent: true };
    logger?.warn?.('trading-mode: getOrCreateAnonymousUserId() returned nothing');
  } catch (err) {
    logger?.warn?.(`trading-mode: dsh-anonymous-user-id is unavailable (${err && err.message})`);
  }
  const localBucket = config?.localBucket ?? config?.identity?.localBucket ?? IDENTITY_POLICY.localBucket;
  if (typeof localBucket === 'string' && localBucket.trim()) {
    const id = localBucket.trim();
    logger?.warn?.(
      `trading-mode: using the operator-declared identity.localBucket "${id}" — per-user data is stored under it, so this deployment must be single-user`,
    );
    return { id, source: 'configured-local-bucket', persistent: true };
  }
  logger?.error?.(
    'trading-mode: no trustworthy per-user identity (host anonymous user id unavailable and no identity.localBucket configured) — market data reads still work, but the watchlist and preferences are refused with 503 NO_IDENTITY instead of being shared between every browser',
  );
  return { id: null, source: 'none', persistent: false };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export { DISCLAIMER };
