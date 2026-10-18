## What this changes

## Why

## Checks

- [ ] `npm test` is green (offline, no network needed)
- [ ] `npm run check` is green
- [ ] Behaviour changes are described in `CHANGELOG.md` (and docs if a config key, endpoint or limit changed)
- [ ] No new runtime dependency; no import of a private host package (host services only)
- [ ] No secret, token, personal path or user data added to any shipped file (`npm run test:repo`)
- [ ] Stays inside the research-only boundary (no orders, positions, P&L, broker integration)
- [ ] Degraded or stale data is still labelled, never silently presented as fresh
