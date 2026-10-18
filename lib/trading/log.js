/**
 * Minimal scoped logger. DSH passes a `logger`-like object on some services but
 * not all, so this wrapper degrades gracefully to the console with a stable
 * `[trading]` prefix. Levels can be raised with the `DSH_TRADING_DEBUG` env var.
 */

const DEBUG = (() => {
  try {
    const v = typeof process !== 'undefined' && process.env ? process.env.DSH_TRADING_DEBUG : '';
    return v === '1' || v === 'true' || v === 'debug';
  } catch {
    return false;
  }
})();

function fmt(scope, args) {
  return [`[trading${scope ? ':' + scope : ''}]`, ...args];
}

function emit(level, scope, args) {
  const out = fmt(scope, args);
  const sink = typeof console !== 'undefined' ? console : null;
  if (!sink) return;
  if (level === 'error') (sink.error || sink.log)(...out);
  else if (level === 'warn') (sink.warn || sink.log)(...out);
  else if (level === 'debug') {
    if (DEBUG && sink.debug) sink.debug(...out);
  } else (sink.log || sink.info)(...out);
}

export function createLogger(scope = '') {
  return {
    scope,
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

export const rootLogger = createLogger();
export const isDebug = () => DEBUG;
