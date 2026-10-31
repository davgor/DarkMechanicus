# DM-310 sprint acceptance evidence

Integration branch: `linear-sprint-2` (sprint 2 of the Linear handoff epic, tickets DM-311 to DM-315 and DM-317 merged at `9060a9f`). DM-316 is optional and not covered. Every check ran in the integration worktree on macOS, arm64. Fireguard grading is not part of this epic's Definition of Done, so it was not run as a grading step (the Fireguard test suite still runs inside `npm test`). Every command that opened a repository ran against a fresh `mktemp -d` scratch repository with a temporary `DARKMECHANICUS_HOME`, removed afterwards. None opened the coordinating checkout's live `state.sqlite`. See [Live database](#live-database) for its schema version, which another build changed during this acceptance.

## Integration fix (one commit on `linear-sprint-2`)

`29cf13f` **Refresh the deadcode baseline.** The first `npm run deadcode` failed ([DM-310-deadcode-before-fix.log](DM-310-deadcode-before-fix.log)) with one finding: `src/renderer/src/epic/transferView.ts:44 - TransferStripView`. The baseline listed the same export at line 51. DM-314 deleted the 7-line `LINEAR_SETUP_LINES` copy at the top of `transferView.ts`, which moved the export up 7 lines, but did not refresh `.tsprune-ignore`. The export and its use are unchanged, so this is a stale baseline entry. `npm run deadcode:refresh` changed only that one line (`:51` to `:44`), and nothing else in `.tsprune-ignore`. The fix touches only `.tsprune-ignore`, which no other check reads, so the other five results at `9060a9f` stand.

## Definition of done

| Check | Command | Result | Log |
|---|---|---|---|
| lint | `npm run lint` | Passed (exit 0, no findings; `oxlint src scripts`) | [DM-310-lint.log](DM-310-lint.log) |
| typecheck | `npm run typecheck` | Passed (exit 0; node, web and fireguard projects) | [DM-310-typecheck.log](DM-310-typecheck.log) |
| test | `npm test` | Passed: 423 files, 8,222 tests passed, 9 skipped; then the Fireguard suite, 20 files and 105 tests | [DM-310-test.log](DM-310-test.log) |
| coverage | `npm run coverage` | Passed: 423 files, 8,222 passed, 9 skipped. Statements 97.68%, branches 95.26%, functions 96.37%, lines 97.83%; thresholds met | [DM-310-coverage.log](DM-310-coverage.log) |
| deadcode | `npm run deadcode` | Passed after `29cf13f`: "No new dead exports found." | [DM-310-deadcode.log](DM-310-deadcode.log) |
| build | `npm run build` | Passed: main (`out/main/index.js`, `mcp.js`, `cli.js`), preload and renderer | [DM-310-build.log](DM-310-build.log) |

`npm test` prints only file and test totals. To show the named tests passing in the full suite, the whole Vitest suite ran once more with `npx vitest run --reporter=verbose` at `29cf13f`: 423 files, 8,222 passed, 9 skipped, exit 0 ([DM-310-test-verbose.log](DM-310-test-verbose.log)). [DM-310-named-tests.log](DM-310-named-tests.log) holds the lines of that log cited below.

## Acceptance criteria

The script [DM-310-transfer-check.mjs](DM-310-transfer-check.mjs) produced the output for c1 and c2. Its full output is in [DM-310-transfer-check.log](DM-310-transfer-check.log) (exit 0, "all assertions passed"). It runs this worktree's built `out/main/mcp.js` (darkmechanicus 0.19.0, schema 10) over stdio, as an orchestrator with `--allow-save`. The person's desktop commands (`queueTransfer`, `cancelTransfer`) go through a desktop `Workspace` loaded from source with tsx, as in `scripts/linear-transfer-smoke.mjs`, because no MCP tool queues or cancels a transfer.

- **c1 (DM-311):** two machines, each with its own scratch repository, home, local database and built server. A "pull" copies machine A's tracked records (everything under `.darkmechanicus/` except `local/`: `.gitignore`, `epics`, `history`, `profiles`, `project.json`) into machine B, as a clone or pull would.
  1. A saves the one-sprint fixture epic as revision 1 (`rv_…r90c`) and flushes. After the pull, B holds revision 1 with no run. B imported it when its server opened the repository, so B's first `reconcile_repository` reports `imported []`.
  2. B's person queues the transfer: `queueTransfer` returns `queued`.
  3. A edits a ticket ("Prepare (edited on A)"), saves revision 2 (`rv_…5nby`), runs `start_run` (run `rn_…2aj`, `running`) and flushes. Then A is pulled into B again.
  4. B's `reconcile_repository` returns `imported []`, `unchanged []`, `rejected []` and one conflict: "Linear transfer open for epic ep_…: tracked records bring saved revision rv_…5nby and run rn_…2aj while its Linear transfer of revision rv_…r90c is queued, so the epic's tracked plan, state and run changes were not imported. Cancel the transfer, then reconcile again."
  5. Nothing was applied. B still holds revision 1, the ticket titles `["Prepare","Deliver"]`, status `backlog` and no run. `get_epic` shows the conflict, `get_storage_status` lists the same conflict, and `get_transfer` is still `queued`.
  6. B's person cancels (`canceled`). The next `reconcile_repository` imports `[ep_…, rn_…2aj]` with no conflicts. B now holds revision 2, "Prepare (edited on A)", `in_progress` and run `rn_…2aj` `running`, and `get_storage_status` lists no conflict for the epic.

  The integration-level unit tests in `src/core/repo/importer.test.ts` (`reconcileRepository while a Linear transfer is open`, `… after a held Linear transfer is canceled`) also pass in the full suite.
- **c2 (DM-312):** on a scratch epic whose transfer is `in_progress`, through the built server:
  - The first part has 17 issues with 500,000-character descriptions, which is 8,502,569 characters of JSON against the 8,000,000 cap. Every field is within its own bound. `submit_transfer_readback` refuses it: `error invalid_input: Invalid arguments for submit_transfer_readback: readback: A read-back part is at most 8000000 characters of JSON. Send the read-back in more, smaller parts.`
  - A non-final part of 600 issues is accepted (`partial`).
  - A second non-final part of 600 distinct issues is refused: `error invalid_input: A transfer read-back holds at most 1100 issues; with this part it would hold 1200. Nothing from this part was stored, and the parts sent before are kept. …` with details `{"limit":"issues","max":1100,"count":1200}`.
  - The paged test passes in the full suite: `src/core/services/transfers.test.ts > a 1,000-ticket transfer > verifies a read-back sent in pages and completes the epic with every issue in its outcome` ([DM-310-named-tests.log](DM-310-named-tests.log), line 188 of the verbose log).
- **c3 (DM-313):** I opened the committed [DM-313-save-hidden.png](DM-313-save-hidden.png) (2880×1800), which comes from DM-313's result. It shows the following:
  - The Draft view of the scratch epic "Linear handoff fixture": `DRAFT REV 2 · UNSAVED` and `EDITING DRAFT`. The folder is `/private/tmp/dm-linear-DM-313-scratch`, so it is a scratch project, not the coordinating checkout.
  - An open transfer: the strip reads `QUEUED Transfer to Linear. Waiting for an agent to start it. 0 of 19 created`, with Resume, Copy prompt and Cancel transfer.
  - No Save button. The header shows "Save is unavailable while the Linear transfer is open. Cancel the transfer to save." where Save was, next to View saved and Discard draft. The validation panel's save box shows the same notice.

  DM-313's accepted evidence says the screenshot came from an isolated dev app. This acceptance did not run the app again, so the isolation is taken from that evidence and from the scratch path the image shows.

  The header and validation panel tests pass in the full suite:
  - `headerView.test.ts > Save in the Draft view while a transfer is open > hides Save in the Draft view while a transfer is queued or in progress, and offers it again after cancel`.
  - `EpicWorkspace.transfer.test.tsx > the Draft view while a transfer is open > hides Save and names the open transfer in its place while it is queued / in_progress, keeping Discard draft and edits`. These assert the notice twice, once in the header and once in the validation panel's save box.
  - `… > offers Save again once the transfer is canceled`.
- **c4 (DM-314):** see [DM-310-setup-lines.log](DM-310-setup-lines.log).
  - `git grep -n LINEAR_SETUP_LINES -- src` shows `src/cli/main.ts:19: import { LINEAR_SETUP_LINES } from '../shared/domain/linearSetup'` and `src/renderer/src/epic/TransferDialog.tsx:3: import { LINEAR_SETUP_LINES } from '../../../shared/domain/linearSetup'`. The only definition is in `src/shared/domain/linearSetup.ts:19`.
  - The criterion text names `transferView.ts`. DM-314 deleted the app's own copy from `transferView.ts`, and the app renders the lines in `TransferDialog.tsx`, which imports the shared constant. `transferView.ts` no longer holds any setup text (`git grep -n -i "setup\|MCP settings" -- src/renderer/src/epic/transferView.ts` exits 1).
  - The old divergent wording "in Cursor's MCP settings" is gone from `src` and `skills` (exit 1).
  - The guide pin test passes in the full suite: `src/mcp/skills.test.ts > SKILLS > gives each Linear setup line of dm transfer and the app verbatim in the transfer guide`.
- **c5 (DM-315):** both tests pass in the full suite:
  - `src/integration/linearTransfer.test.ts > a Linear transfer of an epic with a ticket completed in Dark Mechanicus > creates its issue in a completed state, and the read-back verifies and completes the epic`;
  - `… > rejects its issue left open with a state mismatch naming its key, and verifies once the driver sets the state`.
- **c6 (DM-317):** see [DM-310-rules.log](DM-310-rules.log).
  - `git grep '.Codex/skills/delivery-standards'` prints nothing (exit 1), and so does the case-insensitive form.
  - `cmp .claude/skills/delivery-standards/SKILL.md .cursor/skills/delivery-standards/SKILL.md` prints nothing (exit 0).
  - `diff .agents/skills/delivery-standards/SKILL.md .claude/skills/delivery-standards/SKILL.md` prints nothing (exit 0), so the `.agents` copy is byte-identical to `.claude`.
  - `AGENTS.md:12` links `.agents/skills/delivery-standards/SKILL.md`, and all three copies exist.

## Live database

`sqlite3 -readonly …/DarkMechanicus/.darkmechanicus/local/state.sqlite 'PRAGMA user_version'` prints **10**, not 9, and the database has no `transfers` or `transfer_items` tables ([DM-310-live-db.log](DM-310-live-db.log)). This acceptance did not cause it. Every command here used scratch repositories, and the database lacks this branch's v10 tables.

The cause is the coordinating checkout itself:
- It is on `main` at `022734c`, and its `out/` was rebuilt at 06:02.
- Its own Electron app (started 06:02) and its `out/main/mcp.js` servers hold the database.
- `main`'s `src/core/db/migrations.ts` sets `SCHEMA_VERSION = 10`. That is a different v10, "scrubs the secrets that stored idempotent responses", from the Agent CLIs sprint 3 (`c4a8aaf`).

This branch's v10 creates the transfer tables, so the two v10 migrations collide. A build of this branch would treat a database that `main` migrated to 10 as current, and would never create `transfers`. The orchestrator confirmed the cause: the person's app migrated the live database with `main`'s v10, and no Linear build has opened it. This is not a Definition of Done check. It is recorded as a discovery: renumber the transfers migration to V11 and rebase `linear-handoff` on `main`.
