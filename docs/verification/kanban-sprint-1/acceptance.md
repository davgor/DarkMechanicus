# DM-377: sprint 1 acceptance of "Kanban"

Combined sprint work on `kanban-sprint-1` (base `b8b100d`, sprint start). The covered criteria were verified against the build of `0a3727c`, whose production code is identical to the final code commit `8e6ec56`; the commits after `0a3727c` change tests only. The Definition of Done ran in full on `8e6ec56`.

## Method

- Scratch fixtures only, under `/private/tmp/dm-kanban/acceptance/fx`: the repo-mode Git repository `repo` (key prefix DM), the db-mode folder `db` with its own `DARKMECHANICUS_HOME` (`dbhome`), the clone `clone` (`clonehome`), and `v12-orig` / `v12-copy` for the schema-12 database. The app ran with `--user-data-dir=<scratch>/userdata` and `DARKMECHANICUS_HOME=<scratch>/fx/dmhome`. The person's app profile, their running app and the live databases were not opened.
- Script checks (c2 to c5, c9) ran as throwaway scripts under `/tmp/dm-kanban/acceptance/scripts` (`node --import tsx`, calling `openWorkspace` from `src/core/workspace.ts`, or the built `out/main/cli.js` and `out/main/mcp.js`). Claim tokens are redacted in every output. c1's schema-12 database came from the coordinating checkout's pre-Kanban build (`out/main/mcp.js`, read-only use).
- App checks used the built app (`npm run build`), launched as `DISABLE_AUTO_UPDATE=1 DARKMECHANICUS_HOME=<scratch> <worktree>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=9461 <worktree> --user-data-dir=<scratch>/userdata --remote-debugging-port=9462`, driven over the DevTools protocol. Over the main process's Node inspector, `dialog.showOpenDialog` was replaced by a stub returning one path (the folder to track; for Find, `~/.local/share/claude/versions/2.1.316`, the resolved `~/.local/bin/claude`), and the `dm:command`, `chats:startKanbanCard` and `chats:kickBackKanbanCard` handlers were wrapped to log each call ([c8-ipc-log.txt](c8-ipc-log.txt)). The home path was masked in the page before every screenshot. The app was quit with `app.quit()`; `ps` afterwards shows nothing left ([before](ps-before-quit.txt), [after](ps-after-quit.txt)).
- The live check (c6) used Claude Code 2.1.316 (signed in for this user) on Sonnet 5.5, started with Play. Every approval card was answered by a logged rule: Allow once only when every path is inside the scratch repository (or is the app's own dm CLI) and nothing pushes, deletes recursively or reaches the network. 14 were allowed, none denied ([c6-approvals.txt](c6-approvals.txt)).

## Criteria

- **c1: met.** A schema-12 database (pre-Kanban build, `PRAGMA user_version` 12, no kanban table) was copied with its folder (`cp -R v12-orig v12-copy`); the built app tracked `v12-copy` and its Storage card read Schema v13 ([c1-app-storage-v13.png](c1-app-storage-v13.png)). `sqlite3 .tables` on the copy then lists `kanban_attempts`, `kanban_cards` and `kanban_events`, and `PRAGMA user_version` prints 13; the indexes `kanban_attempts_one_open_per_card` and `kanban_events_card` exist and the pre-existing epic survived. The original stayed at 12. [c1.txt](c1.txt)
- **c2: met.** A planner session created DM-1 and DM-2 in `repo`; `listKanbanCards` lists both in Backlog with the fields id, key, kickBackCount, lane, openAttempt, playPending, priority, summary, title, updatedAt (no body, criteria or evidence): "Backlog keys: DM-1, DM-2; consecutive = true". [c2.txt](c2.txt)
- **c3: met.** DM-3: an orchestrator claim before Play returned `play_required`; desktop Play, claim (packet: branch main, reporting tools named, token redacted), a second claim `already_claimed`, worker heartbeat (running), submit (Ready for review); orchestrator approve and kick back returned `unauthorized` ("not permitted to perform kanban.review"); a blank kick-back comment was refused; the kick-back returned the card to In progress with a pending Play; the second claim's packet listed the comment; attempt 1's token then returned `stale_claim`; submit and desktop approve moved it to Done with the compact summary. [c3.txt](c3.txt)
- **c4: met.** The listing of `.darkmechanicus/kanban/` shows each card's `card.json` and one event file per transition (DM-3: created, played, claimed, running, submitted, kicked_back, claimed, submitted, approved); no file contains either attempt's claim secret (14 files scanned against the secrets in the database). After committing the records, a fresh `git clone` that reconciles lists the identical board: `diff c4-board-original.json c4-board-clone.json` is empty (exit 0). In the db-mode folder, `git status --porcelain --ignored` is empty before and after a full lifecycle with a kick-back, and the folder holds only `.git`, `NOTES.md`, `README.md`. [c4.txt](c4.txt), [original](c4-board-original.json), [clone](c4-board-clone.json)
- **c5: met.** `node out/main/cli.js --list` lists the 11 kanban commands with their capabilities (create/update `kanban.write`, claim `kanban.claim`, heartbeat/submit/fail `kanban.report`, play `kanban.play`, approve and kick back `kanban.review`, list/get `read`). A planner MCP session over stdio lists only the create, update, list and get tools and `create_kanban_card` created DM-4 in Backlog (its `claim_kanban_card` call was refused). Under an orchestrator grant issued by a desktop session, the dm CLI claimed and submitted DM-4, and `dm call approve_kanban_card` was refused with `unauthorized` ("This orchestrator session is not permitted to perform kanban.review", exit 1), as were kick back and play; the card stayed in Ready for review. [c5.txt](c5.txt)
- **c6: met.** In the built app, the Claude agent was added (Find), the fixture card DM-5 "Add a line to NOTES.md" (criterion "NOTES.md gains one line") was created with New card and started with Play (Claude Code, Sonnet 5.5). The card's orchestrator chat called get_capabilities and `claim_kanban_card`, started a worker subagent that appended the line and committed on the checked-out branch `main`, heartbeated and called `submit_kanban_card`: Ready for review. Kick back with "Also add a second line saying 'kicked back once'." delivered "DM-5 was kicked back by a person: … Claim it again with claim_kanban_card and address the comment." to that chat, which claimed again, had the worker commit the second line and submitted: Ready for review again (1 kick-back). Approve moved it to Done. Commits `6748399` and `d2e5ab5` on `main`; attempts rejected (with the comment) and accepted; events played, claimed, running, submitted, kicked_back, claimed, running, submitted, approved. Screenshots `c6-00` to `c6-17`, [c6-git-and-db.txt](c6-git-and-db.txt), [c6-chat-transcript.txt](c6-chat-transcript.txt), [c6-approvals.txt](c6-approvals.txt).
- **c7: met.** [c7-sidebar-and-board.png](c7-sidebar-and-board.png): the folder `repo` in the sidebar lists In progress, Backlog, Kanban (3) and Completed in that order; the board shows DM-1 in Backlog, DM-2 in In progress (Agent working), DM-4 in Ready for review and DM-3 in Done (expanded). DM-2 was put in progress by script ([c7-setup.txt](c7-setup.txt)). [c8-done-lane-compact-rows.png](c8-done-lane-compact-rows.png) shows the same after the live run.
- **c8: met.** [c8-ready-for-review-panel.png](c8-ready-for-review-panel.png): DM-4's panel with Approve and Kick back, its acceptance criteria, checks (lint, test), criteria results and notes from attempt #1 (also `c6-08` and `c6-15` for DM-5). [c8-done-lane-compact-rows.png](c8-done-lane-compact-rows.png): Done with compact rows (key, title, outcome line, date). [c8-done-card-opened.png](c8-done-card-opened.png): an opened Done card leads with the summary. [c8-ipc-log.txt](c8-ipc-log.txt): the board's reads are `listKanbanCards` only; `getKanbanCard` appears only after a card is clicked (DM-4 at 07:01:17, DM-3 at 07:01:41, DM-5 at 07:11:21), while that card stays open, and never on Show Done.
- **c9: met.** Over stdio with the built `out/main/mcp.js`: `darkmechanicus-planner` line 11, `darkmechanicus-orchestrator` line 14 and `darkmechanicus-worker` line 11 each read "An isolated ticket, meaning one coherent change with no prerequisites and nothing depending on it that one worker can finish in one attempt, goes on the folder's Kanban board with `create_kanban_card`, not into a new epic. Work that needs two or more tickets, ordering or sprints stays an epic. Agents create and edit cards; only a person presses Play, approves or kicks back." [c9.txt](c9.txt)
- **c10:** see the Definition of Done and Fireguard below.

## Definition of Done (final code commit `8e6ec56`)

| Check | Result | Log |
| --- | --- | --- |
| lint | passed: `oxlint src scripts`, exit 0 | [lint.log](logs/lint.log) |
| typecheck | passed: node, web and Fireguard projects | [typecheck.log](logs/typecheck.log) |
| test | passed on the second run: 470 files, 9243 passed, 9 skipped; Fireguard suite 21 files, 129 passed. The first run at the same commit timed out one unchanged multi-repo test (`attemptsIncrement.test.ts`, 15 s limit) while the machine's load average was about 60 from other agents' runs | [test.log](logs/test.log), [first run](logs/test-first-run.log) |
| coverage | passed: statements 97.62%, branches 95.35% (threshold 95%), functions 96.3%, lines 97.75% | [coverage.log](logs/coverage.log) |
| deadcode | passed: no new dead exports | [deadcode.log](logs/deadcode.log) |
| build | passed | [build.log](logs/build.log) |

The first sweep at `405ae98` failed coverage (branches 94.75%) and deadcode. The fixes on `kanban-sprint-1`:

- `0a3727c`: `DONE_PAGE` and `KanbanBoardState` (`useKanbanBoard.ts`) and `EvidenceRow` and `EvidenceList` (`panelTabs.tsx`) were exported but used only in their modules, so they are module-private again. `.tsprune-ignore` was refreshed for line drift and for the Kanban command inputs, `KanbanAttemptState` and `KANBAN_EDITABLE_FIELDS`, which only the main-process program imports ([tsprune-ignore.diff](logs/tsprune-ignore.diff)).
- `d29c1bc`: behavioural tests for Kanban branches the sprint left untested (import refusals and rebuilds, finalizer exports, the card and attempt services, Play and Kick back in main, the board, counts and panel states), lifting branches from 94.75% to 95.35%.
- `8e6ec56`: a red-team review of `d29c1bc` found one import test that could not fail (the lease it checked was the same on both branches); it was rewritten and now fails when the kept lease is dropped. Two minor fixes: a time-zone-safe date and an assertion of the kickoff send.

## Fireguard

`FIREGUARD_BASE_REF=b8b100d840226c4eb24e1c6ab098dc0f48385976 npm run fireguard -- --json` on `8e6ec56`, exit 0: grade **A** (90), every hard gate passed, so no new or changed test is graded F ([fireguard.json](logs/fireguard.json); stderr [fireguard.err](logs/fireguard.err)).

- Scope: 52 graded test files, 63 changed modules.
- AST: 2728 assertions, 0 mocks, 0 tautologies, no empty tests, no findings.
- Flake: 100 of 100 isolated runs passed, 0 failures.
- Mutation: 917 killed, 285 survived of 1202; score 76% (minimum 75%).

An earlier Fireguard run on `d29c1bc` was stopped during mutation when the red-team review led to `8e6ec56`; it produced no grade. Only the run above is reported. No production code, threshold or Fireguard setting was changed.

## Caveats

- **c4:** the list output of the clone is identical, as the criterion asks. `getKanbanCard` differs in one field: the progress note of DM-3's closed attempt is null in the clone (heartbeat notes are not carried in the records).
- **c6:** the orchestrator's first two `heartbeat_kanban_card` calls were refused for wrong input fields (it passed `cardId`); the third succeeded. Both times the worker's commit carried a Haiku co-author trailer, and the orchestrator amended the unpushed commit message; the diff was unchanged. The first approval came after a gap (my monitor started late), which only delayed the claim.
- **c1:** the folder was copied with its database, not the database file alone, because a repo-mode database lives in the folder.
- Native dialogs were stubbed as described; the real dialogs were not exercised.

## Discoveries

- **Progress notes do not travel** (DM-381): a reconciled clone shows `progressNote: null` for an attempt that heartbeated with a note on the other computer.
- **Play shows on a kicked-back card** (DM-385): after Kick back, the panel offers Play on the In-progress card while the kick-back has already resumed the card's chat with a pending Play. Pressing it was not tried; it would start a second orchestrator chat for the same card.
- **Card heartbeat input** (DM-382/DM-383): the live orchestrator first sent `cardId` to `heartbeat_kanban_card`, which takes `attemptId`; the kickoff or the tool description could name the fields.
