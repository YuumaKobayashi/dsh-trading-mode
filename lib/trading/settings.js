/**
 * Per-user UI preferences (currently just the display language).
 *
 * Deliberately simple and dependency-free: the only value V0.1 stores is the
 * language the user picked in the panel, and it must survive a restart so a
 * fresh browser opens in the same language. Writes are atomic (temp file +
 * rename), and a corrupt/unreadable file degrades to read-only defaults rather
 * than taking the plugin down (§44).
 *
 * Storage note: DSH ships no key-value store/Redis, so this is a small JSON
 * document under the harness home directory — the same shape the cached market
 * data and the file-fallback watchlist already use.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { CODES, TradingError } from './errors.js';
import { SUPPORTED_LANGS, DEFAULT_LANG, DEFAULT_USER, normalizeLang } from './config.js';

const MAX_SETTINGS_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;

export class UserSettingsStore {
  /**
   * @param {{ logger?: any, homeDir?: string, filePath?: string }} [options]
   */
  constructor(options = {}) {
    this.logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.filePath =
      options.filePath || path.join(options.homeDir || process.cwd(), 'trading-mode', 'settings.json');
    /** @type {Map<string, {lang: string, updatedAt: string|null}>} */
    this.rows = new Map();
    // Set when the on-disk document is unreadable: keep serving defaults rather
    // than overwriting a file we failed to parse.
    this.readOnly = false;
    this.lastError = null;
    this.writes = 0;
  }

  async init() {
    this.rows = new Map();
    this.readOnly = false;
    this.lastError = null;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      if (raw.length > MAX_SETTINGS_BYTES) throw new Error('settings document is too large');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const users = (parsed && parsed.users) || {};
      for (const [userId, value] of Object.entries(users)) {
        const lang = normalizeLang(value && value.lang);
        if (!lang) continue;
        this.rows.set(userId, { lang, updatedAt: (value && value.updatedAt) || null });
      }
    } catch (error) {
      const code = error && /** @type {any} */ (error).code;
      if (code !== 'ENOENT') {
        this.readOnly = true;
        this.lastError = String((error && error.message) || error);
        this.logger.warn?.(
          `trading-mode: settings store is read-only (${this.lastError}); keep using built-in defaults`,
        );
      }
    }
    return this;
  }

  /** Stored preferences for one user; always answers with a usable object. */
  get(userId) {
    const key = userId || DEFAULT_USER;
    const row = this.rows.get(key);
    return {
      userId: key,
      lang: (row && row.lang) || DEFAULT_LANG,
      supported: SUPPORTED_LANGS.slice(),
      defaultLang: DEFAULT_LANG,
      updatedAt: (row && row.updatedAt) || null,
      storage: this.readOnly ? 'read-only' : 'file',
    };
  }

  /**
   * Apply a partial update. An explicitly unsupported language is a client bug,
   * so it is rejected with BAD_REQUEST instead of being silently ignored.
   */
  async patch(userId, patch) {
    const key = userId || DEFAULT_USER;
    const current = this.get(key);
    const next = { lang: current.lang };

    if (patch && patch.lang !== undefined && patch.lang !== null) {
      const lang = normalizeLang(patch.lang);
      if (!lang) {
        throw new TradingError(
          CODES.BAD_REQUEST,
          `unsupported language ${JSON.stringify(patch.lang)}; supported languages are ${SUPPORTED_LANGS.join(', ')}`,
        );
      }
      next.lang = lang;
    }

    this.rows.set(key, { lang: next.lang, updatedAt: new Date().toISOString() });
    await this.flush();
    return this.get(key);
  }

  /** Atomic write of the whole document (temp file + rename). */
  async flush() {
    if (this.readOnly) return false;
    const payload = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      users: Object.fromEntries(this.rows),
    };
    const body = JSON.stringify(payload, null, 2);
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, this.filePath);
    this.writes += 1;
    return true;
  }

  info() {
    return {
      backend: 'file',
      filePath: this.filePath,
      users: this.rows.size,
      writes: this.writes,
      readOnly: this.readOnly,
      lastError: this.lastError,
    };
  }
}
