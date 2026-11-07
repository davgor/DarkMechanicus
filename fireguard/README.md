# fireguard

Deterministic unit-test quality grader for agent-authored Vitest tests.

Fireguard assigns a letter grade (**A–F**) using three fail-fast gates — no LLM evaluation:

1. **AST** — mock/assert ratio, tautological assertions, empty tests  
2. **Flake** — added/modified tests (git diff vs `main`) must pass **100** isolated runs at **0%** flake (fail-fast; reports `executed/configuredRuns`)  
3. **Mutation** — the graded tests must kill ≥ **75%** of the mutants on the lines the diff changed in production modules; a module's mutants run only against the graded tests that transitively import it, nearest importers first

Fireguard grades what is committed: the diff is `baseRef...HEAD`, and every test run happens in a temporary snapshot of HEAD, so uncommitted edits are neither graded nor run, and the working tree is never mutated.

Playwright / e2e is out of scope.

## Copy into another repo

1. Copy the entire `fireguard/` directory.
2. Copy `.fireguardrc.json` (or create one from the defaults below).
3. Ensure peer tooling exists: `typescript`, `vitest`, `tsx`, `minimatch`.
4. If the host `package.json` is **not** `"type": "module"` (common for Electron), keep `fireguard/package.json` with `"type": "module"` and run via `node fireguard/bin/fireguard.mjs`.
5. Add scripts:

```json
{
  "scripts": {
    "fireguard": "node fireguard/bin/fireguard.mjs",
    "test:fireguard": "vitest run --config fireguard/vitest.config.ts"
  }
}
```

6. Call `npm run fireguard` in CI on pull requests. Exit `1` means grade **F**.

## CLI

```bash
npm run fireguard
npm run fireguard -- --json
npm run fireguard -- --comment-pr
npm run fireguard -- --help
```

| Exit | Meaning |
|------|---------|
| 0 | Pass (grade A–D) |
| 1 | Quality failure (grade **F**) |
| 2 | Tool error |

### PR grade comments

On GitHub Actions pull requests, pass `--comment-pr` (requires `pull-requests: write` and `GITHUB_TOKEN`). Fireguard upserts a sticky comment marked `<!-- fireguard-report -->` with the letter grade so agents see **F** on the PR without opening job logs.

Also writes `GITHUB_STEP_SUMMARY` when that env var is set.

## CI sharding

CI uses two independent grading runners, not two full grading runs. A preparation job resolves the selected base (`origin/<PR base>`, or `origin/main` on pushes) once; all shards and the aggregate check out the same Actions HEAD and consume that resolved base SHA.

Each shard grades the same complete AST/test inventory. It executes its round-robin share of the **100 configured complete flake runs** (50 per shard), then mutates its round-robin partition of the sorted changed production modules. Mutation still uses every related graded importer and only changed lines. Empty partitions still emit a manifest. AST metrics are counted once, flake counts are summed, and mutation killed/survived counts are summed **before** computing the score and enforcing the unchanged threshold; shard percentages/grades are never averaged.

The two CI runners each use `FIREGUARD_CONCURRENCY=1` and `VITEST_MAX_WORKERS=2`, bounding nested work. Within a shard, mutation waits for its flake gate; separate GitHub runners isolate mutation from the other shard's flake runs. When reproducing concurrently on one computer, use independent snapshots and allow enough CPU headroom; shared fixed external resources have the same limitations as local lanes.

For local reproduction, set `FIREGUARD_BASE_REF` to a **resolved base commit SHA** and `FIREGUARD_CONCURRENCY=1`, then run the first two commands in separate terminals on the same committed HEAD:

```bash
npm run fireguard -- --shard 1/2 --json-out shards/1.json
npm run fireguard -- --shard 2/2 --json-out shards/2.json
npm run fireguard -- --merge-shards shards --shard-count 2 --json-out fireguard-report.json --markdown-out fireguard-pr.md
```

Create an empty `shards` directory first; keep unrelated JSON files outside it. A shard emits a partial JSON report, not a final verdict or sticky comment. Shard AST/flake failures exit 1; mutation threshold evaluation is deferred to the aggregate. The aggregate validates unique/complete shard indices, resolved HEAD/base commits, configuration, test/module inventory, exact flake budgets/executed counts, and mutation-module partitions. A passing combined run still requires 100/100 flake runs at zero failures. Fail-fast failures report the actual executed count and globally indexed failing runs, and fail the grade. Missing/inconsistent artifacts are tool errors (exit 2), not passes.

Only the aggregate adds `--comment-pr`, so it emits one final report/grade and upserts one sticky comment. Both required check names, `test` and `fireguard`, are aggregate jobs that run even after failed children and require every child job to succeed. CI retains shard/combined JSON artifacts for diagnosis. Local `npm run fireguard` remains unsharded and unchanged.

## Config (`.fireguardrc.json`)

```json
{
  "thresholds": {
    "maxMockToAssertRatio": 1.5,
    "maxTautologicalRatio": 0.1,
    "minAssertionsPerFile": 1,
    "minMutationScore": 75,
    "flakinessRuns": 3,
    "agenticFlakinessRuns": 100,
    "maxFlakeRate": 0
  },
  "include": ["src/**/*.{test,spec}.{ts,tsx}"],
  "exclude": ["**/__mocks__/**", "e2e/**"],
  "baseRef": "main",
  "testCommand": "npx vitest run"
}
```

`concurrency` (default: one per three CPUs, so 4 on a 12-core machine and 1 below 6 cores) is how many lanes run tests at once; see [Speed](#speed).

`testCommand` names the vitest to run and its options. When it runs vitest itself (`npx vitest run`, `node node_modules/vitest/vitest.mjs run --config x`), fireguard reads its `vitest run` options and keeps one vitest running per lane instead of starting the command for every run. Any other command (`npm test --`) is started for every run, as before, which is much slower.

Env overrides: `FIREGUARD_MIN_MUTATION_SCORE`, `FIREGUARD_MAX_MOCK_RATIO`, `FIREGUARD_AGENTIC_FLAKINESS_RUNS`, `FIREGUARD_BASE_REF`, `FIREGUARD_TEST_COMMAND`, `FIREGUARD_TEST_TIMEOUT_MS`, `FIREGUARD_CONCURRENCY`.

`testTimeoutMs` (default 300000) bounds each test run. A run that exceeds it is killed together with every process it started and counts as failed: a mutant that makes code loop forever is **killed**, and a hung flake run is **flaky**, instead of hanging fireguard.

## Scope rules

- **Graded tests** — paths with git status `A`/`M`/`R`/`C` matching `include` in `git diff baseRef...HEAD` (or `baseRef HEAD` when there is no merge base)
- **Changed modules** — added/modified production `src|lib|app` files (not tests)
- Only committed changes count; the AST gate reads the graded tests as committed, and the other gates run in snapshots of HEAD
- Production modules changed with **no** graded test updates → grade **F** (fail closed)
- No graded tests and no module changes → skip with grade A
- Mutation runs when there are graded tests and changed modules
- Mutants are written only into the snapshots, unless fireguard has to fall back to the working tree (see [Speed](#speed)); there it restores each file with `try/finally` plus a process `exit` hook to avoid dirty trees

## Mutation

Each changed production module is mutated one operator at a time (`+ - * / < > <= >= === !==`, `if` inversion, boolean/number `return` tweaks) and the tests are re-run against every mutant; a mutant that still passes them survives.

**Only mutants on changed lines run.** A mutant counts when the code it replaces touches a line the diff added or changed (`git diff -U0`, new side; a condition spanning lines counts if any of them changed). The score is the kill rate of those mutants, so a branch is graded on the code it wrote, not on old code it happens to touch; a module whose diff only deletes lines has none. The report says how many mutants sat on unchanged lines and were not run (`changed lines only: 15 mutants on changed lines, 166 on unchanged lines not run`; `--json`: `gates.mutation.unchangedLineMutants`). Callers of `runFireguard` that do not supply `getChangedLines` run every mutant of every changed module.

**Mutants of a module run only against graded tests that transitively import it.** Only those tests can load the mutated code, so grading semantics are unchanged, but a milestone-sized branch no longer re-runs every graded test file for every mutant. Fireguard builds a static import graph with the TypeScript compiler (nothing is executed):

- Follows relative specifiers (`./x`, `../x`) in `import … from`, `export … from`, `import x = require()`, and `import()` / `require()` calls with a string literal.
- Resolves the exact path, then `.ts`, `.tsx`, `.mts`, `.js`, `.mjs`, `.jsx`, then `index.*` files. `./x.js` also matches `x.ts` / `x.tsx`, and Vite suffixes such as `?raw` are ignored.
- Ignores package and alias specifiers (tsconfig `paths`, Vite `resolve.alias`), `vi.mock(...)` / `vi.importActual(...)` targets, `import.meta.glob`, and computed `import(expr)` calls, so a test that reaches a module only that way is not run for its mutants. Use relative imports for the modules under test.
- A changed module that no graded test reaches keeps every mutant as a survivor. The report shows it as `tests per module: … src/x.ts=0 (no graded test imports it)`; add or extend a test that imports it.
- A test whose import closure exceeds 5,000 files is treated as related to every module (fail-safe), as one of its farther tests.

**Nearest tests first.** A mutant first runs against the related tests that reach its module in the fewest import hops (usually the module's own test file). Only a mutant those tests leave alive runs against the module's remaining related tests. A mutant is killed exactly when one of its related tests fails, as before, but most mutants are killed by the first, small batch, so they no longer pay for every importer.

Every mutant run stops at its first failing test (vitest's `bail: 1`): that failure already kills the mutant, so waiting out the other tests it makes hang cannot change the verdict. A batch of graded files that vitest does not collect (for example `*.spec.ts` outside vitest's `include`) passes rather than counting as a kill.

`--json` output carries the same counts as `gates.mutation.moduleTests` (module path → number of related graded test files, nearest and farther). Callers of `runFireguard` whose lanes' `source` has no `fileExists` and `readFileSync` keep the previous behavior of running every graded test for every mutant.

## Speed

Both test gates run in **lanes**, `concurrency` of them. Each lane is a temporary snapshot of HEAD with one long-lived vitest in it, and runs one thing at a time: a flake run (every graded file once) or a mutant.

- **Snapshots of the committed tree.** `git checkout-index` writes HEAD into a temporary directory per lane, through a temporary index, so the repository's index, branches and worktree list are untouched. Uncommitted, untracked and ignored files (build output) are left out; each `node_modules` (top-level and nested) is linked to the working tree's. A snapshot has no `.git`. The snapshots are deleted at the end, or on exit if fireguard is interrupted.
- **One vitest per lane.** Starting vitest and transforming the modules is most of a short test run. A lane keeps one vitest running (`fireguard/src/vitestLane.mjs`) and sends it each run, so only the first run of a lane pays for start-up and transforms. Each run still gets fresh test workers, as `vitest run` does, so runs stay isolated from each other; a mutant written into a snapshot is reloaded before its run. A run that exceeds `testTimeoutMs` is killed with everything it started, and the lane starts a fresh vitest for its next run. A run that vitest reports as interrupted without a failing test of its own (a bail from the previous run's workers can arrive after that run ended) has no verdict, since its skipped files would read as passing, so the lane starts it again; on this benchmark that kept whole-module mutation results identical to fresh `vitest run`s.
- **Flake runs spread over the lanes.** The 100 runs go to whichever lane is free, so several run at once. Each lane's vitest gets `VITEST_MAX_WORKERS` set to its share of two thirds of the CPUs (2 each for 8 lanes on 24 CPUs), so every run sees about the load of a full test-suite run. The rest of the CPUs is for each lane's vitest, the processes tests start, and antivirus scanning: at one worker per CPU a CPU-heavy test ran 8 times slower than alone and came within 2x of its timeout, while two thirds made as many runs per minute with it at half that. With fail-fast, no run starts after a failure; runs already under way finish, and every failure among them is reported.
- **Mutants on the same lanes, after the flake gate.** The mutation gate starts once the flake gate has passed, in the same lanes and vitests. Mutants never run beside flake runs: a mutant that makes a test hang or exhaust memory would slow the flake runs next to it and could fail them.

If the snapshots cannot be made, the tests run in the working tree, one at a time, and the report says why: `Ran: one at a time in the working tree (…; could not snapshot the committed tree: …)`. `--json` carries how the lanes ran as `execution`. If a graded test needs something a snapshot lacks (`.git`, an ignored or untracked file), it fails there, so the flake gate fails and says which test; commit what it needs.

Tests that share a fixed resource across processes (a fixed port, a fixed path outside the workspace) can collide when two lanes run them at once: in the flake gate that counts as flaky, in the mutation gate as a kill. Set `FIREGUARD_CONCURRENCY=1` if a suite has such tests.

## Grades

Hard gate failure → **F** (score 0). Meeting thresholds starts at **C** (~70); lower mock density and higher mutation kill rates raise the score toward **A**.
