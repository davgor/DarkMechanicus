# DM-254 Fireguard verification

- Graded commit: `e58c061e50f7868f7cde50549b2c5baa4107cd49` (branch `agent-clis-DM-254`, from sprint tip `92cfb3484446a348a8f1ec33f4daad83290588ed`)
- Exact base commit: `98df7226c9a8e19588de974f36414bcb4f65cbe0` (sprint 1 start)
- Command: `node fireguard/bin/fireguard.mjs --json` with `FIREGUARD_BASE_REF=98df7226c9a8e19588de974f36414bcb4f65cbe0` (macOS; default test command)
- Complete stdout: [DM-254-fireguard.json](DM-254-fireguard.json); stderr was empty
- Grade **A** (92); all hard gates passed
- Scope: 44 graded test files, 52 changed modules (full lists in the JSON)
- AST: 2145 assertions, 5 mocks, 6 tautologies, 0 empty tests, no findings
- Flake: 100 of 100 isolated runs passed; 0 failures, 0% flake
- Mutation: 573 killed, 152 survived, 725 total; score 79%, minimum 75%

## Earlier runs and fixes (tests only)

1. Sprint tip `92cfb34`: grade **F** (0), mutation gate failed — flake 100/100 passed, mutation 528 killed of 725 (73%). `selection.ts` (27 surviving mutants) and `chooseView.ts` (18) changed in the sprint, but no graded test imported them, so every mutant survived. Commit `737eafd` adds agent-pane tests by custom agent id to `src/renderer/src/app/selection.test.ts` and `src/renderer/src/app/chooseView.test.ts`. These cover the sprint's move from matching by kind to matching by id.
2. Commit `737eafd`: grade **F**, flake gate failed on run 28 of 100: `acpProcess.test.ts` › "kills the whole process tree…" found the grandchild still alive right after `kill()`. `killProcessTree` waits at most one second for the process group to empty and is documented to resolve `false` when that limit passes. Under the full-suite load, the killed grandchild was not reaped in time. Commits `29ca497` and `e58c061` rewrite only that test: the grandchild shares the process's stdout, and the test waits for the transport's close, which fires only after every process holding that pipe has exited. The close must report `signal SIGKILL`. Swapping the group kill for `child.kill` alone made the test time out, so the test is not vacuous; that edit was then reverted.

An earlier attempt was killed during mutation and left one mutant in `src/main/agents/adapters/claude.ts`. It was restored with `git checkout` before any graded run, and the worktree was clean after each run.

No production files, grading thresholds, exclusions or rules were changed. Remaining survivors are mostly in renderer components such as `ChatTranscript.tsx` (31) and `runBarView.ts` (24). They do not affect the passing gates, and covering them is a separate opportunity.
