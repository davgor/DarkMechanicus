# Sprint 2 acceptance (DM-140): evidence

Attempt 2. Built app (`npm run build` on `source-control-sprint-2` at f8b0b49, which includes the DM-141/DM-142 rework:
sign-in imports this machine's GitHub CLI login). It ran through Playwright Electron with a fresh temporary
`--user-data-dir` per run, a pre-seeded `folders.json`, and each profile deleted after its run. The scratch repositories
were rebuilt from scratch under `/private/tmp/sc-epic/scratch/DM-140/`. Every tracked path uses `/private/tmp/...` so
that macOS's `/tmp` symlink does not affect the repository-root comparison. The `DM-140-*.log` files are the script
output, with each git terminal check printed next to what the app showed. The temporary profile paths in them are
redacted.

| Criterion | Evidence |
| --- | --- |
| c1/c2 sign-in | `DM-140-signin.log`. In an isolated profile, Sign in to GitHub → Use my GitHub CLI login imported the gh login; the toast said "Signed in as @davgor" and the footer shows `@davgor` (`footer-signed-in.png`). No plain token was found anywhere in the profile. Sign out brought back Sign in to GitHub and removed the stored account (`footer-signed-out.png`); `gh auth status` still reported "Logged in to github.com account davgor (keyring)" afterwards. With a gh wrapper that has no login first on the app's PATH, the dialog shows the `gh auth login` fix with Copy and Try again (`sign-in-gh-auth-login.png`). The token was never printed, logged or captured. |
| c3 sync | `hello-world-fetched.png`: signed out, Fetch origin in a clone of octocat/Hello-World finished in about 1.7 s with no alert and no dialog. `pull-origin-behind-1.png`: Pull origin ↓1 after `other` pushed. After every step, the app's counts matched `git rev-list --left-right --count @{u}...HEAD` (`DM-140-sync.log`). |
| c4 push/fetch | `push-origin-ahead-2.png`; `fetch-in-progress.png` (throttled `ext::` remote, progress bar at "Compressing objects 11%", with Cancel); `push-rejected-pull.png` (rejected because `other` pushed first). Pull brought in "Other change 2" (see `DM-140-sync.log`). |
| c5/c6 branches | `DM-140-branches.log` has `git branch -a` and `git stash list` after each app step: create from the default branch, switch with Leave my changes, come back and Restore, rename, publish, then delete with Also delete origin/…. Screenshots: `branch-popover-filtered.png`, `switch-dialog.png`, `stashed-changes-row.png`, `stashed-changes-open.png`, `delete-dialog.png`. |
| c7 conflicts | `merge-two-conflicts.png`, then `merge-one-resolved.png` (a.txt resolved with Use mine). For b.txt, the resolved content was written straight to disk, because a GUI editor cannot be automated; Mark resolved was then clicked. Commit merge followed: `merge-committed.png`, with `git log --graph -3` in `DM-140-merge.log`. |
| c16 unpushed | `history-scratch-plain.png` (no remote, no arrows), `history-scratch-b.png` (only "Local change 3 (unpushed)" is marked). |
| c17 repo root | `toolbar-subfolder-root.png` tracks `mono/packages/app` and shows "Repository root: /private/tmp/sc-epic/scratch/DM-140/mono". `toolbar-root-folder.png` tracks `mono` itself and shows no root line. |
| c12 loop | See "200x loop" below. |

Scripts: `/tmp/sc-epic/scratch/DM-140/{setup.sh,lib.mjs,signin.mjs,sync.mjs,branches.mjs,merge.mjs,misc.mjs}`.

## Integration fixes made during acceptance (tests only, attempt 1)

- `9434bda`: `history.test.ts` "pages past 100 commits" now builds its 120 commits with a single `git fast-import`.
  Before, it spawned git 120 times and hit the 15 s timeout in 20 of 80 loop runs on a heavily loaded machine.
- `95b1bb2`: covering tests for sprint 2 code. On 39f3e16, `npm run coverage` was below the thresholds, at functions
  95.55 % and branches 94.72 %; it now passes.
- `8d08e72`: the four git-backed tests that still timed out in the 200x loop under external load now use fewer git
  processes, with the same assertions.

## 200x loop

`DM-140-loop-39f3e16.log` and `DM-140-loop-95b1bb2.log` are attempt 1's stopped loops.

`DM-140-loop-21467f4.log` is attempt 2's loop: 200 runs of `vitest run` over the 37 git-backed test files listed in
`DM-140-loop-files.txt` (600 tests per run) at 21467f4, which differs from f8b0b49 only in this folder. All 200 runs
passed (600/600 each, 27–30 s per run), with no busy-folder retry. load1 was 11.8–24.1 (median 15.8) during the loop.

## Definition of Done and Fireguard (attempt 2, at f8b0b49)

lint, typecheck, test (Vitest 481 files: 8752 passed, 9 skipped; Fireguard suite 20 files, 105 passed), coverage
(statements 97.97 %, branches 95.4 %, functions 97.08 %, lines 98.12 %), deadcode and build all exit 0.
`FIREGUARD_BASE_REF=39f3e16 npm run fireguard -- --json` (the tests and production files changed after DM-148, which
includes the DM-141/DM-142 rework) graded A, 93: AST 863 assertions; flake 100 runs with 0 failures over 35 test files;
mutation over 12 changed modules, 77 of 90 killed.
