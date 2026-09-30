# EPIC: Fireguard mutation scoping

Fireguard's mutation gate re-runs every graded test file for every mutant, which does not scale to milestone-sized changes. Run only the graded tests that (transitively) import the mutated module — the only tests that can kill its mutants — so grading semantics are unchanged but runtime drops.

## Acceptance criteria

- [x] A static import graph (relative imports, `.ts/.tsx/.mjs/.js`, index files) maps each changed module to the graded tests that reach it (tested in `fireguard/test`)
- [x] The mutation gate runs each module's mutants against only its related graded tests; modules with none still count as survivors (tested)
- [x] `npm run test:fireguard` passes
- [x] Each test run is bounded by `testTimeoutMs` (default 5 min, `FIREGUARD_TEST_TIMEOUT_MS`); a timed-out run kills its whole process tree and counts as failed, so infinite-loop mutants are killed instead of hanging the gate (`fireguard/test/runnerTimeout.test.ts`)

## Verification — 2026-09-30

`npm run test:fireguard`: 19 files, 101 tests pass (46 before); `tsc -p fireguard/tsconfig.json` clean. `fireguard/src/importGraph.ts` builds a static relative-import closure per graded test (matched TypeScript bundler resolution with 0 mismatches over 47 tests × 89 modules on the live tree); the mutation gate runs each module's mutants against only the graded tests that reach it, and modules no graded test imports count every mutant as survived without applying it. On a live-tree snapshot (69 tests × 94 modules × 800 mutants) test-file executions drop from 55,200 to 2,564.
