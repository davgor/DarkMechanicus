# DM-125 Sprint 1 acceptance

## Full gate

| Exact check | Result | Evidence |
| --- | --- | --- |
| `lint` | passed | [DM-125-lint.log](DM-125-lint.log) |
| `typecheck` | passed | [DM-125-typecheck.log](DM-125-typecheck.log) |
| `test` | passed: 276 files / 5,020 tests and 20 Fireguard files / 105 tests | [DM-125-test.log](DM-125-test.log) |
| `coverage` | passed: 98.15% lines, 98.06% statements, 97.35% functions, 95.37% branches | [DM-125-coverage.log](DM-125-coverage.log) |
| `deadcode` | passed: no new dead exports | [DM-125-deadcode.log](DM-125-deadcode.log) |
| `build` | passed: Electron main, preload, and renderer production bundles | [DM-125-build.log](DM-125-build.log) |
| `fireguard` | passed by accepted DM-129 result; not rerun | [DM-129-fireguard.md](DM-129-fireguard.md), [DM-129-fireguard.json](DM-129-fireguard.json) |

The accepted Fireguard report is grade A (91): 251 assertions, zero mocks and tautologies, 100/100 isolated runs without flakes, and 238/310 mutations killed (77%, 75% minimum). It records base `3f0e33a6ec21ec19641ff2df4a2b3cbc2f9f2211` and graded commit `f39080c7819fd7a9c6165c72857a3094283bb71b`. That result is tied to its recorded commit; this acceptance reuses the accepted result as instructed and does not claim the current tip was graded.

The full gate exposed two stale or platform-sensitive test fixtures. The update-copy test now asserts the current concise notification while the existing silent-install and “Restart now” interaction tests remain intact. Fireguard’s timeout fixture now invokes `node` through `PATH`, avoiding the Windows executable path being split at its space. Two mascot tests were refactored into helpers to meet lint limits; their assertions and behavior are unchanged. No production behavior changed. The coverage provider was restored from the checked-in lockfile without changing package declarations or the lockfile.

## Acceptance criteria

- **c1 — Atlas playback:** all six actions rendered from the production preview. Alpha bounds were measured for all 36 cells; every cell retained transparent padding, each painted sprite fit its tile, and the inspected screenshot shows distinct poses without visible clipping, opaque backgrounds, cell leaks, or identity drift. Evidence: [preview metadata](DM-125-preview-metadata.json) and [action screenshot](DM-125-actions-production.png).
- **c2 — Motion:** the deterministic preview recorded `jump · ticket-a` → `climb · ticket-a` → `walk · ticket-a`; the board sprite stayed inside its board bounds. Motion and placement unit tests passed in the full suite. Evidence: preview metadata and the action screenshot.
- **c3 — Real graph and accessibility:** the production build rendered the real PlanGraph with multiple cards under the app’s production CSP. Selection, model movement, card drag/drop, pan, zoom, pause frame stability, reduced-motion static idle pose, and three viewport sizes passed. No horizontal page overflow or console, CSP, or request errors occurred. Evidence: [preview metadata](DM-125-preview-metadata.json), [desktop graph screenshot](DM-125-graph-production.png), and [narrow graph screenshot](DM-125-graph-narrow-production.png).
- **c4 — Fireguard provenance:** the accepted grade, base, graded commit, and report path were checked against the DM-129 JSON and Markdown artifacts linked above.

## Reproducible visual check

`DM-125-preview-check.mjs` builds both preview pages into a temporary production output directory, serves them with the exact production CSP from `electron.vite.config.ts`, drives Edge, checks the interactions and atlas alpha bounds, and saves the screenshots and metadata alongside this report. All 14 recorded preview contracts pass.
