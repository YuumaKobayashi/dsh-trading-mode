# Security Policy

`dsh-trading-mode` is a local research panel for DSH (DeepSeek Harness). It
reads public market data over the network, stores a watchlist and display
preferences inside your DSH profile, and asks the host's LLM service for
commentary. It has no server component of its own, no user accounts, and no
ability to trade.

## Reporting a vulnerability

**Please do not open a public issue for anything exploitable.** A public report
tells everyone before a fix exists.

- Preferred channel: the repository's **private security-advisory** feature, if
  the host offering this plugin provides one (look for a "Report a
  vulnerability" entry in that repository's Security section).
- If no such private channel exists, ask the maintainer for a private channel
  through the repository's own listing or contact field, and send the report
  there.
- Send the report as **plain text**. Do not paste live credentials, tokens or
  personal data — if a secret is involved, say what kind it is and where it
  would appear, not the value. A redacted sample is enough.

Please include: the plugin version (the `version` field of `package.json`), what
you did, what happened, what an attacker gains, and any suggested fix. If the
issue involves the host, the DSH version matters too.

## Supported versions

| Version | Security fixes |
| --- | --- |
| `0.6.x` | yes — current line |
| `<= 0.5.x` | no — please upgrade before reporting |

## Scope: what this plugin actually does

- It makes **outbound HTTP(S) requests to third-party market-data sites** (and,
  for the AI layer, only through the host's LLM service). Those requests carry
  **no credentials of yours**: the market-data sources used are keyless public
  endpoints.
- It **never places orders, never connects to a broker and never moves money**.
  There is no execution path to attack.
- It stores the watchlist, display preferences and cached quotes in the **local
  DSH profile on a single machine**. There is no cross-device sync and no
  remote copy.
- Its HTTP surface is the host-mounted `/api/trading/*` prefix inside the DSH
  web server. It is not an internet-facing service; reaching it means reaching
  the host first.

Given that, the classes of issue that are genuinely interesting here are:

1. **Request forgery / SSRF through user-supplied input.** Symbols, search
   queries and provider configuration end up in upstream URLs. A crafted value
   must not be able to steer a request to an arbitrary host, port or scheme, or
   to smuggle extra parameters.
2. **Credential or secret leakage.** Anything secret that could reach logs, an
   error message, the cache files, or the published package contents —
   including accidental commits of keys or personal paths into the shipped
   files.
3. **Cross-user data exposure through `/api/trading/*`.** Requests must be
   fenced on the host connection and storage must be keyed by user id, so one
   session cannot read or mutate another's watchlist or preferences through
   these routes.
4. **Untrusted upstream response handling.** A hostile or broken upstream
   answer must not crash the host or corrupt state: payloads are decoded and
   parsed defensively (a malformed body becomes a typed `PARSE_ERROR`), values
   pass through the schema/coercion layer before reaching the UI, inbound
   request bodies are capped at `MAX_BODY_BYTES` (64 KiB), and upstream calls
   are bounded by a per-request timeout.

## What is not a vulnerability

- **A third-party market-data site being unreachable, blocking or
  rate-limiting you.** Providers are chained with health scopes and cooldowns;
  degraded output is expected behaviour, not a defect.
- **Delayed, stale or partial quotes.** The plugin labels freshness explicitly
  and never claims to be a real-time feed.
- **The absence of trading features.** Research-only is the product, not a gap.
- **Someone with local access reading your own profile files.** They live in
  your DSH profile on your machine by design.

## Handling of discovered issues

Reports are triaged privately. Fixes are released in the current `0.6.x` line
and documented in `CHANGELOG.md`; credit is given in the release notes if you
want it.
