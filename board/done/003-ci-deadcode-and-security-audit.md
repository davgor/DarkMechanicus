# EPIC: Deadcode + security audit CI

Mirror CapitalGains deadcode (`ts-prune` vs `.tsprune-ignore`) and `npm audit` (fail on moderate+) workflows, wired into delivery standards.

## Acceptance criteria

- [x] `scripts/deadcode-check.mjs` + `deadcode-refresh.mjs` with unit tests
- [x] `.github/workflows/deadcode.yml` runs on PRs and pushes to `main` (honors `[skip ci]`)
- [x] `.github/workflows/security-audit.yml` fails PRs on moderate+ vulnerabilities
- [x] Delivery standards skill lists `npm run deadcode` in the verification gate
