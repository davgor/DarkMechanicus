# DM-162 Fireguard verification

- Graded commit: `bc946f1340407b7b70d6530d06a032f25e166714`
- Exact base commit: `2cf6d6a4b6eca9f0e1b2cf0f4b1859fce7d2396f`
- Command: `node fireguard/bin/fireguard.mjs --json` with `FIREGUARD_BASE_REF=2cf6d6a4b6eca9f0e1b2cf0f4b1859fce7d2396f` and `FIREGUARD_TEST_COMMAND=node node_modules/vitest/vitest.mjs run`
- Complete stdout: [DM-162-fireguard.json](DM-162-fireguard.json); stderr: `docs/verification/DM-162-fireguard.stderr.log` (empty, local ignored log)
- Exit: 0; grade **A** (90); all hard gates passed
- AST: 500 assertions, 0 mocks, 0 tautologies, 0 empty tests
- Flake: 100 of 100 isolated runs passed; 0 failures, 0% flake
- Mutation: 569 killed, 192 survived, 761 total; reported score 75%, minimum 75%

Before grading, scoped checks passed (142 tests in 8 files):

```text
node node_modules/oxlint/bin/oxlint src/renderer/src/mascot/motion.test.ts src/renderer/src/mascot/shake.test.ts src/renderer/src/mascot/GraphMascot.test.tsx src/renderer/src/mascot/MascotSprite.test.tsx src/renderer/src/mascot/geometry.test.ts src/renderer/src/mascot/sprite.test.ts src/renderer/src/graph/graphModel.test.ts src/renderer/src/graph/graphPan.test.ts
node node_modules/vitest/vitest.mjs run src/renderer/src/mascot/motion.test.ts src/renderer/src/mascot/shake.test.ts src/renderer/src/mascot/GraphMascot.test.tsx src/renderer/src/mascot/MascotSprite.test.tsx src/renderer/src/mascot/geometry.test.ts src/renderer/src/mascot/sprite.test.ts src/renderer/src/graph/graphModel.test.ts src/renderer/src/graph/graphPan.test.ts
```

After Fireguard identified one test with assertions hidden in a helper, a direct frame-count assertion was committed as `bc946f1340407b7b70d6530d06a032f25e166714`; `node node_modules/oxlint/bin/oxlint src/renderer/src/mascot/sprite.test.ts` and `node node_modules/vitest/vitest.mjs run src/renderer/src/mascot/sprite.test.ts` then passed (5 tests). The final Fireguard run grades that committed change. No grading thresholds, exclusions, rules, or production files changed in this ticket.

The full JSON preserves the eight graded test files and nine changed modules. `PlanGraph.tsx` has zero graded test imports and two surviving mutants; this does not affect the passing hard gates and is a separate coverage opportunity.
