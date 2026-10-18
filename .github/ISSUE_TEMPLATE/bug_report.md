---
name: Bug report
about: Something in Trading Mode is wrong, missing or crashes
title: '[bug] '
labels: ['bug']
---

<!-- Please do not paste API keys, tokens, session ids or personal paths. -->

## What happened

## What you expected

## Steps to reproduce

1.
2.
3.

## Evidence

- Plugin version (from `package.json`):
- DSH version / Node version (`node --version`):
- Which market and symbol (e.g. `AAPL`, `0700.HK`, `600519.SH`, `7203.T`, `BTC`):
- Which suite fails, if any (`npm test`): the check name and its message
- Provider health: paste the relevant part of `GET /api/trading/status`
  (`providers[].scopes`, `transport`, `providerChains`, `providerChainProblems`, `networkMode`, `ai.reason`)

```
<paste here — redact anything personal>
```

## Notes

<!-- If the problem only happens with one upstream, say which one and from where. -->
<!-- A whole-market outage is usually upstream, not the plugin: see docs/TROUBLESHOOTING.md. -->
