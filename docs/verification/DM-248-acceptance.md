# DM-248 sprint 1 acceptance evidence

Integration branch: `agent-clis-sprint-1`. The end-to-end run used the build of `7f55d00` (the combined sprint). The Definition of Done ran at `796b5af`, which differs from `7f55d00` only by removing three `export` keywords and refreshing `.tsprune-ignore` (see deadcode below). It was run on macOS (arm64) on 2026-10-30. Times below are UTC. Home paths are written as `~` and the user name as `<user>`. Screenshots were masked in the page before capture: the DOM text `/Users/<user>` was replaced with `~`.

## How it was run

- **Evidence folder:** `/tmp/dm248-evidence` (macOS resolves it to `/private/tmp/dm248-evidence`), outside every repository. `scratch-a` is a fresh `git init` repository there with one commit. The throwaway user data is `<evidence>/userdata`. The person's app, its user data and their tracked folders were not touched.
- **Old build:** a detached worktree at `98df7226c9a8e19588de974f36414bcb4f65cbe0` (the epic's start commit; app v0.19.0, Electron 42.11.9) with `node_modules` linked from the coordinating checkout, built with `npm run build`. It was removed after the run.
- **New build:** `npm run build` in the integration worktree.
- **Launch:** every instance started as `DISABLE_AUTO_UPDATE=1 <worktree>/node_modules/.bin/electron --inspect=<port> <worktree> --user-data-dir=<evidence>/userdata --remote-debugging-port=<port>`. Over the Node inspector, `app.getPath('userData')` returned `/private/tmp/dm248-evidence/userdata`. `agents.json`, `folders.json` and, in the new build, `app.sqlite` appeared there.
- **Driving the app:** the page was driven over the Chrome DevTools Protocol: clicks, React-compatible value setting, and screenshots at 1280×800.
- **Native dialogs, method (b):** over the main process's Node inspector, `require('electron').dialog.showOpenDialog` was replaced with a function that returns one path. That path was `realpath(<evidence>/scratch-a)` for the folder dialog and `realpath(~/.local/bin/claude)` = `~/.local/share/claude/versions/2.1.291` for the file dialog. Electron's macOS dialog resolves symlinks by default, so this is the path a real Find would return. The app's own Track and Find code ran after the stub. The stub recorded both calls: "Choose a repository folder" (`openDirectory`) and "Locate the Claude Code CLI (claude)" (`openFile`). `agents.json` and `folders.json` were written by the old build itself.
- **Quitting:** every quit used `app.quit()` over the inspector, then the inspector was detached. `ps` confirmed that no process was left each time.
- **Live model turns:** Claude Code 2.1.291 (the person's subscription), Haiku and the Worker role in both chats. Seven short turns in total. Two approval cards came up, both for the `dm` `get_capabilities` command, and both were answered **Allow once**. `pwd` ran without a card. No request named a path outside the scratch folder, so nothing was denied.
- **Codex and Cursor:** they are not installed on this machine. Their paths are covered by the replay tests in `npm test` only.

## Old profile (98df722)

| Step | Result | Evidence |
|---|---|---|
| Track `scratch-a` with **Track a folder**, then **Initialize folder** ("In this repository"; `.mcp.json` unchecked) | Tracked as `/private/tmp/dm248-evidence/scratch-a`. Initializing was needed because the old build shows the Agents block, and its New chat button, only under an initialized folder | [old profile files](DM-248-old-profile.txt) |
| **Add an agent → Claude Code → Find** | The card showed "Connected · v2.1.291" and Signed in | [screenshot](DM-248-old-01-claude-connected.png) |
| New chat in scratch-a (Claude Code, Haiku, Worker), one exchange | The reply was `PINEAPPLE-OLD`. The chat stored session `83ac2834-…` | [screenshot](DM-248-old-02-chat-in-scratch-a.png) |
| Quit | `claude` (pid 4717) and the app were gone after quit | [before](DM-248-ps-old-before-quit.txt), [after](DM-248-ps-old-after-quit.txt), [app log](DM-248-app-old.log) |
| Files after quit | `agents.json` (one entry: `claude`, found, 2.1.291) and `folders.json` exist. There is no `app.sqlite` | [DM-248-old-profile.txt](DM-248-old-profile.txt) |

## Acceptance criteria

- **c1 — app.sqlite: met.** After the first start of the new build, `app.sqlite` is in the user data at `PRAGMA user_version` **1**. `.tables` lists `agents`, `app_meta` and `folder_agent_defaults` ([first-start dump](DM-248-sqlite-first-start.txt)). The app was quit and restarted (run 2) on the same user data. Run 2 opened with no error: its [log](DM-248-app-run2.log) holds only the auto-update line, no error banner appeared ([screenshot](DM-248-new-10-restart-no-error.png)), and the [after-restart dump](DM-248-sqlite-after-restart.txt) shows the same version, tables and rows with `PRAGMA integrity_check` = `ok`.
  - **What happens at quit.** Quitting **while a chat's agent process is live** logs `Uncaught exception: Error: database is not open` at `SqliteDb.close`. This happened in run 1, and run 3 reproduced it with `scratch-a` in place ([run 1 log](DM-248-app-run1.log), [run 3 log](DM-248-app-run3.log)).
  - **Whether the person sees it.** They do not: it appears only as a log line. `src/main/logger.ts` registers a `process.on('uncaughtException')` handler that only logs, so Electron shows no error dialog. Run 3's main process exited with code 0 within 3.6 s of `app.quit()`, which a modal dialog would have blocked. No process was left, and no new crash report appeared in `~/Library/Logs/DiagnosticReports`. A quit with no live agent (run 2) logged nothing.
  - **Not fixed here, by the orchestrator's decision.** It is listed under Discoveries.
- **c2 — legacy import: met.** After the first start, `agents.json` is gone from the user data and `folders.json` remains. `app_meta` holds `legacyAgentsImported|imported`. `SELECT id, kind, protocol, executable_path FROM agents` returns exactly one row, `claude|claude|claude|~/.local/share/claude/versions/2.1.291`: the single agent the old build connected. `SELECT *` matches the old `agents.json` field by field, including `version` 2.1.291, `found`, `connectedAt` and `lastProbed`. Evidence: the [dump](DM-248-sqlite-first-start.txt) and the [old file](DM-248-old-profile.txt). The agent page shows Claude Code with Executable, **Version 2.1.291**, "Found on this computer" and Signed in ([agent page](DM-248-new-01-agent-page-claude-connected.png)). The agents list shows "Connected · v2.1.291" ([list](DM-248-new-02-agents-list-claude-connected.png)).
- **c3 — chats survive the upgrade: met.**
  - **The old chat.** It is listed under scratch-a and reopened with its transcript (`PINEAPPLE-OLD`) ([screenshot](DM-248-new-03-old-chat-reopened.png)). Its chat-store key is `sha256("/private/tmp/dm248-evidence/scratch-a")[:24]`, which is the same in both builds. A new message got the answer `MANGO-NEW` ([screenshot](DM-248-new-04-old-chat-new-message-answered.png)). The new build started `claude` with `--resume=83ac2834-…`, the session the old build stored.
  - **A new chat.** A new Claude chat in scratch-a (Haiku, Worker) answered `KIWI-FRESH` ([screenshot](DM-248-new-05-new-claude-chat-scratch-a.png)).
- **c4 — pinned folder: met.** `realpath scratch-a` = `/private/tmp/dm248-evidence/scratch-a`.
  - **`pwd`.** In the new chat, `pwd` printed exactly that path ([screenshot](DM-248-new-06-pwd-canonical.png)). `lsof` reported the same cwd for both `claude` processes ([ps](DM-248-ps-c4-before-rename.txt)).
  - **`get_capabilities`.** The agent ran the system prompt's command, `node <worktree>/out/main/cli.js --repo /private/tmp/dm248-evidence/scratch-a call get_capabilities '{}'` ([approval card](DM-248-new-07-get-capabilities-approval.png)). The stored tool result is truncated before `repoRoot`. So the agent ran the same command again piped through `grep -n repoRoot`, which gave `20: "repoRoot": "/private/tmp/dm248-evidence/scratch-a",` ([screenshot](DM-248-new-08-get-capabilities-repoRoot.png), [stored tool results](DM-248-c4-chat-items.txt)).
  - **Rename.** `scratch-a` was then renamed to `scratch-a-renamed` without quitting. The new chat's agent process was still live, and it kept answering (`AFTER-RENAME`). Its cwd followed the directory to `scratch-a-renamed` ([ps](DM-248-ps-c4-live-process-after-rename.txt)). The folder check runs when a process starts, not on every message to a live process (see Discoveries).
  - **The refusal.** The old chat's process stopped at its 10-minute idle stop (13:30). A message sent to the old chat then showed **"The folder /private/tmp/dm248-evidence/scratch-a is gone: it was moved or deleted. Track the folder again to keep using this chat."** ([screenshot](DM-248-new-09-renamed-folder-error.png)). The `ps` listings before and after show the same PIDs: the three Electron helpers and the one live `claude` 8287 of the other chat. No new agent process was started ([before](DM-248-ps-c4-before-send.txt), [after](DM-248-ps-c4-after-send.txt)).
  - **Afterwards.** The app quit left nothing running ([ps](DM-248-ps-new-after-quit-run1.txt)), and the folder was renamed back before the restart.
- **c5 — ACP recording is clean: met.** `docs/reports/autonomous-acp.md` and `src/main/agents/adapters/__mocks__/autonomousRecordings.ts` exist on the branch. [DM-248-c5-grep.sh](DM-248-c5-grep.sh) reads the values at run time from `whoami`, `git config user.name`, `git config user.email` (and its local part) and `$HOME`, and prints counts only. Each value matches **0** lines in both files. In copies of the recording with one value planted each, the same grep finds **1** line each (positive control). See [DM-248-c5-grep.log](DM-248-c5-grep.log), run at `796b5af`.
- **c6 — Fireguard: met.** DM-254 is accepted with grade **A, score 92** ("all hard gates passed"). Its details:
  - **Commits:** base `98df7226c9a8e19588de974f36414bcb4f65cbe0`, graded head `e58c061e50f7868f7cde50549b2c5baa4107cd49`.
  - **Gates:** flake 100/100 runs with 0 failures; mutation 573 of 725 killed (79%, minimum 75%); AST 2145 assertions, 5 mocks, 6 tautologies.
  - **Report:** [DM-254-fireguard.md](DM-254-fireguard.md) and [DM-254-fireguard.json](DM-254-fireguard.json). The Git blob SHA-256 of the JSON is `7538ddf62512e1e6e5594913c6f587191039ef27ac7f22371ff99de7bef394e6`.
  - **Not re-run.** No test file changed after `e58c061`: `git diff --name-only e58c061..796b5af` lists only `docs/verification/DM-254-*`, `.tsprune-ignore` and the three type-only source edits.

## Definition of done (at `796b5af`)

| Check | Result | Evidence |
|---|---|---|
| `npm run lint` | Passed (`oxlint src scripts`, exit 0) | [DM-248-lint.log](DM-248-lint.log) |
| `npm run typecheck` | Passed (node, web and Fireguard projects) | [DM-248-typecheck.log](DM-248-typecheck.log) |
| `npm test` | Passed: 417 files, 7987 tests passed and 9 skipped; Fireguard suite 20 files, 105 tests | [DM-248-test.log](DM-248-test.log) |
| `npm run coverage` | Passed: statements 97.69%, branches 95.5%, functions 96.34%, lines 97.8% (thresholds 97, 95, 96, 97) | [DM-248-coverage.log](DM-248-coverage.log) |
| `npm run deadcode` | Passed after one scoped cleanup | See below |
| `npm run build` | Passed (main, preload, renderer) | [DM-248-build.log](DM-248-build.log) |
| `fireguard` | Taken from accepted DM-254, not re-run: **A (92)** | See c6 |

Details of the deadcode cleanup:

- **Original failure:** [DM-248-deadcode-initial.log](DM-248-deadcode-initial.log), run at `7f55d00`.
- **New unused exports:** three, each used only inside its own module: `BuiltInAgentView` (`src/main/desktop/agentAuth.ts`), `BuiltInAgentEntry` (`src/main/desktop/agentRegistry.ts`) and `AgentKind` (`src/shared/desktop/api.ts`). Only their `export` keyword was removed. The other findings were names already in `.tsprune-ignore` whose line numbers had moved ([after unexport](DM-248-deadcode-after-unexport.log)).
- **Baseline refresh:** `npm run deadcode:refresh` ([log](DM-248-deadcode-refresh.log)) rewrote only line numbers and the header count ([diff](DM-248-tsprune-ignore.diff)). The set of ignored names is unchanged: the header's 98 was stale after DM-253 added an entry by hand, and 99 is the true count.
- **Final run:** [DM-248-deadcode.log](DM-248-deadcode.log): "No new dead exports found."

No behaviour changed. Lint, typecheck, test, coverage and build above all ran after the cleanup. The final evidence commit adds only files under `docs/verification/`.

## Red-team review

- **Seams attacked:**
  - **Old to new data:** whether the import happens once (the marker is written and survives a restart), whether every field is kept (compared with the old `agents.json`), and whether `agents.json` comes back (it does not).
  - **Chat store key across builds:** the old chat is found under the same key.
  - **Session resume:** the old build's session id was used.
  - **Launch-folder check at process start and with a live process:** a gap was found for the live process (Discoveries).
  - **Quit path:** a defect was found (Discoveries).
- **c5 grep:** it is case-insensitive and fixed-string, and the positive control shows it can find each value. A wider search for `/Users/`, `/home/`, `C:\Users` and e-mail domains in the recording found nothing.
- **Dialog stub:** it returns what a real macOS dialog returns, the resolved symlink target. It does not test the dialog itself. Find's probe and save ran for real.
- **Fireguard reuse:** confirmed that no test file changed after the graded head.

## Not verified

- Codex and Cursor (not installed; replay tests only), Windows, and the real native dialogs (stubbed as described above).
- Untracking a folder, and a symlink swapped in for the folder. These `resolveLaunchFolder` refusals are covered by unit tests only. The live run exercised "gone" only.

## Discoveries (not fixed here)

1. **DM-249: double `appDb.close()` on quit with a live agent.**
   - **Symptom:** quitting with a live chat logs `Uncaught exception: Error: database is not open` at `SqliteDb.close`.
   - **Sequence:** `runLifecycle` in `src/main/desktop/bootstrap.ts` runs `pool.closeAll(); appDb.close()` on every `before-quit`. `disposeBeforeQuit` in `src/main/quitDisposal.ts` cancels the first `before-quit` when chats are live, disposes them, and then calls `app.quit()` again. That fires `before-quit` a second time, so `appDb.close()` runs twice. It also closes the workspaces and `app.sqlite` while disposal is still running.
   - **Effect:** a log line only. There is no dialog, the exit code is 0, and nothing is left running.
2. **DM-252: a live agent keeps running after its folder is renamed.**
   - **What happened:** the folder check runs only when a process starts. A chat whose process is live keeps working in the renamed directory (its cwd follows the inode) until the process stops, by the idle stop or a quit.
3. **DM-248: a chat's grant is not revoked when its folder is gone at dispose.**
   - **What happened:** at quit, `revokeChatGrant` failed with "… is not initialized for Dark Mechanicus" because the folder was renamed. Grant `gr_01m66fgefd…` in scratch-a's `state.sqlite` keeps `revoked_at` empty until it expires 12 h later.
   - **Origin:** this is pre-existing code, from before sprint 1.
4. **DM-248: test instances write to the person's own app log.**
   - **What happened:** electron-log writes to `~/Library/Logs/dark-mechanicus/main.log`, which `--user-data-dir` does not redirect. The throwaway instances' lines went into the person's app log.
