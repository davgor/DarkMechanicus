# EPIC: Fireguard test quality gate

Port CapitalGains fireguard: grade new Vitest unit tests vs `main` (AST + flake + mutation). Letter **F** fails CI and delivery.

## Acceptance criteria

- [x] `fireguard/` package with CLI at `fireguard/bin/fireguard.mjs`
- [x] `.fireguardrc.json` configured for `src/**/*.{test,spec}.{ts,tsx}`
- [x] `npm run fireguard` wired; CI Checks `fireguard` job posts sticky PR comments
- [x] Delivery standards require fireguard when unit tests are added or modified
