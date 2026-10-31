# fireguard

Deterministic unit-test quality grader for agent-authored Vitest tests.

Fireguard assigns a letter grade (**A–F**) using three fail-fast gates — no LLM evaluation:

1. **AST** — mock/assert ratio, tautological assertions, empty tests  
2. **Flake** — added/modified tests (git diff vs `main`) must pass **100** isolated runs at **0%** flake (fail-fast; reports `executed/configuredRuns`)  
3. **Mutation** — changed production modules must kill ≥ **75%** of mutants; a module's mutants run only against the graded tests that transitively import it, nearest importers first

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

`concurrency` (default: one per three CPUs, so 4 on a 12-core machine and 1 below 6 cores) is how many mutants are tested at once; see [Speed](#speed). This repository's `.fireguardrc.json` sets `testCommand` to `node node_modules/vitest/vitest.mjs run`, which skips `npx`'s start-up on every one of the thousands of test runs.

Env overrides: `FIREGUARD_MIN_MUTATION_SCORE`, `FIREGUARD_MAX_MOCK_RATIO`, `FIREGUARD_AGENTIC_FLAKINESS_RUNS`, `FIREGUARD_BASE_REF`, `FIREGUARD_TEST_COMMAND`, `FIREGUARD_TEST_TIMEOUT_MS`, `FIREGUARD_CONCURRENCY`.

`testTimeoutMs` (default 300000) bounds each test run. A run that exceeds it is killed together with every process it started and counts as failed: a mutant that makes code loop forever is **killed**, and a hung flake run is **flaky**, instead of hanging fireguard.

## Scope rules

- **Graded tests** — paths with git status `A`/`M`/`R`/`C` matching `include` vs `baseRef`
- **Changed modules** — added/modified production `src|lib|app` files (not tests)
- Production modules changed with **no** graded test updates → grade **F** (fail closed)
- No graded tests and no module changes → skip with grade A
- Mutation runs when there are graded tests and changed modules
- At `concurrency` 1, mutation writes in-place with `try/finally` restore plus a process `exit` hook to avoid dirty trees; above 1 it writes only temporary workspace copies, unless it has to fall back to the working tree (see [Speed](#speed))

## Mutation

Each changed production module is mutated one operator at a time (`+ - * / < > <= >= === !==`, `if` inversion, boolean/number `return` tweaks) and the tests are re-run against every mutant; a mutant that still passes them survives.

**Mutants of a module run only against graded tests that transitively import it.** Only those tests can load the mutated code, so grading semantics are unchanged, but a milestone-sized branch no longer re-runs every graded test file for every mutant. Fireguard builds a static import graph with the TypeScript compiler (nothing is executed):

- Follows relative specifiers (`./x`, `../x`) in `import … from`, `export … from`, `import x = require()`, and `import()` / `require()` calls with a string literal.
- Resolves the exact path, then `.ts`, `.tsx`, `.mts`, `.js`, `.mjs`, `.jsx`, then `index.*` files. `./x.js` also matches `x.ts` / `x.tsx`, and Vite suffixes such as `?raw` are ignored.
- Ignores package and alias specifiers (tsconfig `paths`, Vite `resolve.alias`), `vi.mock(...)` / `vi.importActual(...)` targets, `import.meta.glob`, and computed `import(expr)` calls, so a test that reaches a module only that way is not run for its mutants. Use relative imports for the modules under test.
- A changed module that no graded test reaches keeps every mutant as a survivor. The report shows it as `tests per module: … src/x.ts=0 (no graded test imports it)`; add or extend a test that imports it.
- A test whose import closure exceeds 5,000 files is treated as related to every module (fail-safe), as one of its farther tests.

**Nearest tests first.** A mutant first runs against the related tests that reach its module in the fewest import hops (usually the module's own test file). Only a mutant those tests leave alive runs against the module's remaining related tests. A mutant is killed exactly when one of its related tests fails, as before, but most mutants are killed by the first, small batch, so they no longer pay for every importer.

Mutant runs add two vitest flags. `--bail=1` stops a run at its first failing test (that failure already kills the mutant) instead of also waiting out every other test the mutant makes hang until vitest's test timeout; it cannot change a verdict. `--passWithNoTests` makes a batch of graded files that vitest does not collect (for example `*.spec.ts` outside vitest's `include`) pass; before, such a run failed with "No test files found" and its mutant counted as killed.

`--json` output carries the same counts as `gates.mutation.moduleTests` (module path → number of related graded test files, nearest and farther). Callers of `runFireguard` that do not supply `fileExists` and `readFileSync` keep the previous behavior of running every graded test for every mutant.

## Speed

A sprint-sized change can mean 1,000 to 2,000 mutants, and the mutation gate used to be most of a multi-hour run. Each mutant's test run is a whole vitest process, mostly start-up and module loading, and leaves most CPUs idle, so fireguard tests several mutants at once.

With `concurrency` above 1, fireguard copies the workspace into a temporary directory once per lane: every file `git ls-files --cached --others --exclude-standard` lists, as the working tree has it (ignored files such as build output are not copied), with `node_modules` linked rather than copied. Each lane tests one mutant at a time in its own copy, so the working tree is never mutated and a build or an interrupted run cannot pick up a mutant. Each lane's vitest runs get `VITEST_MAX_WORKERS` set to their share of the CPUs, so all lanes together use about as many workers as one ordinary vitest run. The copies are deleted when the gate finishes.

Before using the copies, fireguard runs the graded tests once in one of them. If that fails (for example, a test needs `.git`, an ignored file, or a nested `node_modules`), or the workspace cannot be copied, the mutants run in the working tree one at a time, exactly as at `concurrency` 1, and the report says why: `ran one mutant at a time in the working tree (graded tests failed in a workspace copy: …)`. `--json` carries this as `gates.mutation.execution`.

The flake gate still makes its 100 runs one after another in the working tree: each run already keeps vitest's workers busy, and running several at once measured slower and made timing-sensitive tests fail.

Tests that share a fixed resource across processes (a fixed port, a fixed path outside the workspace) can collide when two lanes run them at once, and a collision counts as a kill. Set `FIREGUARD_CONCURRENCY=1` if a suite has such tests.

## Grades

Hard gate failure → **F** (score 0). Meeting thresholds starts at **C** (~70); lower mock density and higher mutation kill rates raise the score toward **A**.
