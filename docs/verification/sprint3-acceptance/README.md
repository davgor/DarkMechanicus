# Sprint 3 acceptance (DM-149): evidence

Built app: `npm run build` on `source-control-sprint-3` at 1482136 (every sprint 3 ticket merged). Each run went
through Playwright Electron with a fresh temporary `--user-data-dir`, a pre-seeded `folders.json` (and `clone.json` for
the clone parent), and the profile was deleted after the run. Signed-out runs pointed `gh` at an empty `GH_CONFIG_DIR`
with `GH_TOKEN`/`GITHUB_TOKEN` empty. The one signed-in run (c4) used this machine's gh login and signed out at the end;
no token was printed, logged or captured, and these files contain no token-like string. Scratch repositories were built
by `scripts/setup.sh` under `/private/tmp/sc-epic/scratch/DM-149/`. `scratch-gh` pushes go to a local bare repository
(`remote.origin.pushurl`), and nothing was pushed. The `DM-149-*.txt` files are the script output, with each git
terminal check printed next to what the app showed; temporary profile paths are redacted.

| Criterion | Evidence |
| --- | --- |
| c1 clone | `DM-149-c1c2.txt`. `octocat/Hello-World` typed as owner/repo (`DM-149-c1-shorthand-dialog.png`) cloned into the scratch parent with 14 progress events (Enumerating objects, Receiving objects 84 → 92 → 100 %) and origin `https://github.com/octocat/Hello-World.git`. `git/git` cancelled at "Receiving objects 2%" (`DM-149-c1-big-clone-in-progress.png`; the folder existed mid-clone) left no `git-big` folder (`DM-149-c1-big-clone-cancelled.png`). An `ext::sh -c touch …` URL was refused in the dialog (`DM-149-c1-ext-refused.png`) and through `window.git.clone` with `invalid_input`; the marker file the helper would create does not exist, so git never ran. |
| c2 sidebar clone | `DM-149-c2-sidebar-plus-menu.png` (Add existing folder… / Clone repository…), `DM-149-c2-clone-dialog-running.png`, then `DM-149-c2-cloned-open-on-source-control.png`: `hello-url` tracked (in the profile's `folders.json`), selected in the sidebar and open on Source control. |
| c3 PR checkout | `DM-149-c3c4out.txt`. `window.git.checkoutPullRequest(scratch-c, {number: 1, uncommitted: 'stash'})`, called from the renderer through Playwright `page.evaluate` (the same call devtools makes), created `pr/1` at the commit `refs/pull/1/head` points to in `origin-c.git` and switched to it, leaving no `refs/dm` ref (`DM-149-c3-scratch-c-on-pr-1.png`). Signed out, `window.git.getPullRequests(scratch-gh)` returned `auth_required`. |
| c4 PR UI | `DM-149-c4-push-and-create-pull-request.png` (signed in as @davgor, `feature-unpublished` with no upstream; `DM-149-c4in.txt`), `DM-149-c4-pull-requests-signed-out.png` (branch menu → Pull requests: "Sign in to GitHub to see pull requests"). |
| c5 line commits | `DM-149-c5c6.txt`. In `scratch-lines`, 5 changed lines over two hunks (−line 3, +A1; +B1 +B2 +B3); A1 and B2 unselected (`DM-149-c5-notes-selected.png`, `DM-149-c5-crlf-selected.png`). After each commit, `git show HEAD:<file>` equals the expected text byte for byte, and the working file's hash is unchanged; `notes.txt` (LF), then `crlf.txt` (CRLF) (`DM-149-c5-crlf-after-commit.png`). |
| c6 selection | `DM-149-c6-partial-lines-indeterminate.png` (X2 and Y1 unselected; `list.txt` checkbox indeterminate), then `DM-149-c6-selection-reset-toast.png` after appending a line on disk: "list.txt changed, so its line selection was reset", and every line is selected again. |
| c7 docs | `DM-149-doccheck.txt` (`scripts/check_docs.py`): 301 links, paths and module names in the decision record 0004, `architecture.md`, `runbooks/github-sign-in.md` and `README.md` exist. A claim-by-claim read against the code found one runbook message that did not match the app's text; it was fixed in this acceptance. |
| c12 rebase banner | `DM-149-c12to14.txt`. `git rebase -r` stopped at the conflicting merge (MERGE_HEAD and `rebase-merge/` both present): `DM-149-c12-rebase-banner.png` shows "A rebase is in progress … Abort", with no Abort merge or Commit merge. Abort gave `git status` "On branch feature, nothing to commit" with neither marker left (`DM-149-c12-after-abort.png`). |
| c13 `:/a` | `DM-149-c13-only-colon-slash-a-included.png`, `DM-149-c13-after-commit.png`: `git show --stat HEAD` lists only `:/a`; `git status --short` still shows ` M a`. |
| c14 merge message | `DM-149-c14-merge-conflict.png`, `DM-149-c14-merge-committed.png`: the merge was started from the branch menu and resolved with Use mine, then Commit merge. `git log -1 --format=%B` is `Merge branch 'feature/conflict'` with 0 lines starting with `#` (MERGE_MSG had `# Conflicts:`). |
| c15 stall | `DM-149-c15.txt`: Fetch origin against `ext::stall.sh` (prints nothing, sleeps) showed "Fetching…" with Cancel (`DM-149-c15-fetching.png`). After 60.6 s it showed "The connection stalled: git made no progress for 60 seconds." and the button was Fetch origin again (`DM-149-c15-stall-timeout.png`). git wrote no stderr, so there was no detail block. `DM-149-c15-variant.txt` and `DM-149-c15-variant-stall-timeout.png` use a helper that writes one stderr line before it stalls: after 61.1 s the same message appeared with Details "stall-helper: waiting for the server". |

## Definition of Done at 1482136

`dod/DM-149-dod-summary.txt` has the order, times and `uptime` (load 20–116). Results: lint, typecheck, coverage
(statements 97.79 %, branches 95.01 %, functions 96.94 %, lines 97.97 %), deadcode and build passed on the first run.
`npm test` failed twice for reasons that were not about the tests' logic, then passed:
1. `dod/DM-149-test.txt`: two adapter test files hit "Electron failed to install correctly". They raced each other to
   download the Electron binary into this fresh worktree.
2. `dod/DM-149-test-rerun.txt`: one test in `pullRequestsCheckout.test.ts` hit the 15 s timeout at load 92. Alone, that
   test takes about 1.2 s.
3. `dod/DM-149-test-rerun2.txt`: Vitest 545 files, 10077 passed and 9 skipped; the Fireguard suite 21 files, 129 passed.
