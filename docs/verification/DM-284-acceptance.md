# DM-284 sprint acceptance evidence

Integration branch: `linear-sprint-1` (sprint 1 of the Linear handoff epic, tickets DM-285 to DM-296 merged at `f959446`). Every check ran in the integration worktree on Node v24.19.0 (macOS, arm64). Fireguard grading is not part of this epic's Definition of Done (entry criterion n2), so it was not run. Every command that opens a repository ran against a scratch repository or against a backup copy of the coordinating checkout's database. None opened the live `state.sqlite`, which still reports `PRAGMA user_version` 9.

## Integration fixes (two commits on `linear-sprint-1`)

1. `af2a17a` **Refresh the deadcode baseline.** The first `npm run deadcode` failed ([DM-284-deadcode-before-fix.log](DM-284-deadcode-before-fix.log)) for two kinds of reason:
   - Line shifts in existing baseline entries: `chat.ts`, `chatApi.ts`, `domain/api.ts`, `views.ts` and `desktop/api.ts`.
   - New exports from the transfer tickets. These are type exports used only inside their own module or by tests: `transfer.ts`, `linearPacket.ts`, `transferKickoff.ts`, `TransferChatRequest`, `transferActions.ts`, `transferView.ts` and `transferBackend.ts`. Also, `canonical.ts` is now reached by the web project, because the renderer fixture imports `buildLinearPacket`.

   I checked every new finding and each one is intentional. `npm run deadcode:refresh` then rewrote `.tsprune-ignore`.
2. `a377830` **Write the long-stderr fixture synchronously so the test is deterministic on macOS.** The first `npm test` failed one test ([DM-284-test-before-fix.log](DM-284-test-before-fix.log)): `src/main/agents/adapters/acpProcess.test.ts` › "keeps only the tail of a long stderr". It fails the same way at the epic start commit `88c212f` (run from a `git archive` copy), so this sprint did not cause it.

   The cause: on macOS, Node's pipe stdio is asynchronous, so `process.exit` cut the fixture's `console.error` at 64 KiB. `node -e "console.error('x'.repeat(100000)+'THE-END'); process.exit(1)" 2>&1 >/dev/null | wc -c` prints `65536`. The fixture now writes the same 100,000 bytes with `fs.writeSync(2, …)`. The product code and every assertion are unchanged.

   The test passed 5 runs out of 5 after the fix. A temporary probe that expected an absent tail (`ABSENT-PROBE`) failed, which proves the assertion still bites. The probe was then reverted. `oxlint` is clean on the file.

## Definition of done (final run, after both fixes)

| Check | Command | Result | Log |
|---|---|---|---|
| lint | `npm run lint` | Passed (exit 0, no findings) | [DM-284-lint.log](DM-284-lint.log) |
| typecheck | `npm run typecheck` | Passed (exit 0; node, web and fireguard projects) | [DM-284-typecheck.log](DM-284-typecheck.log) |
| test | `npm test` | Passed: 423 files, 8,191 tests passed, 9 skipped; then the Fireguard suite, 20 files and 105 tests | [DM-284-test.log](DM-284-test.log) |
| coverage | `npm run coverage` | Passed: 423 files, 8,191 passed, 9 skipped. Statements 97.67%, branches 95.23%, functions 96.36%, lines 97.82%; thresholds met | [DM-284-coverage.log](DM-284-coverage.log) |
| deadcode | `npm run deadcode` | Passed: "No new dead exports found." | [DM-284-deadcode.log](DM-284-deadcode.log) |
| build | `npm run build` | Passed: main (`out/main/index.js`, `mcp.js`, `cli.js`), preload and renderer | [DM-284-build.log](DM-284-build.log) |

Logs from the runs before the fixes are kept for the record: [lint](DM-284-lint-before-fix.log), [typecheck](DM-284-typecheck-before-fix.log), [deadcode](DM-284-deadcode-before-fix.log), [test](DM-284-test-before-fix.log), and [coverage](DM-284-coverage-before-fix.log). Coverage happened to pass before the fix. The [Fireguard suite](DM-284-test-fireguard-suite.log) ran on its own then, because the failing Vitest run had stopped `npm test` before reaching it.

## Acceptance criteria

The script [DM-284-transfer-check.mjs](DM-284-transfer-check.mjs) produced the output for c1, c4, c5, c6, c7 and the prompt part of c8. Its full output is in [DM-284-transfer-check.log](DM-284-transfer-check.log). The setup:

- The built `out/main/mcp.js` runs over stdio as an orchestrator with `--allow-save`.
- It uses a scratch repository and a temporary `DARKMECHANICUS_HOME`.
- Queue, cancel and queue-run actions go through a desktop `Workspace` loaded from source with tsx.
- Linear is the in-memory fake from `src/test/fakeLinearMcp.ts`.

- **c1 (DM-285):** prompts served by the built server.
  - `darkmechanicus-planner`:
    > By default, only the project's Definition of Done gates acceptance. Any further standard applies to an epic only when the plan states it, either in a "Standards" section of the epic intent or in a ticket's body. That covers tests written first, test-quality grading such as Fireguard, coverage targets beyond the Definition of Done, and a per-sprint grading ticket. Never add one by default.

    > … Every work ticket's body carries a **Tests** section that lists the tests its worker writes, or "none" with the reason.
  - `darkmechanicus-worker`:
    > Write and run the tests your ticket's **Tests** section lists, in this ticket. Order is free unless the plan states tests-first.
- **c2 (DM-286):** see [DM-284-rules.log](DM-284-rules.log).
  - `grep -rn 'Fireguard ticket'` over AGENTS.md, CLAUDE.md, README.md, .ai-instructions.md, .cursor/rules, .claude/skills, .cursor/skills, .agents/skills and skills prints nothing (exit 1).
  - `cmp .claude/skills/delivery-standards/SKILL.md .cursor/skills/delivery-standards/SKILL.md` prints nothing (exit 0).
- **c3 (DM-287):** run against a backup copy of the coordinating checkout's database; see [DM-284-cli-dbcopy.log](DM-284-cli-dbcopy.log). The command was `dm transfer linear --epic ep_01m6772ffwkwr2a91fsqzfz1he --json`, exit 0.
  - planRows of the saved plan: row 1 `DM-285 DM-286 DM-287`, row 2 `DM-288`, row 3 `DM-289 DM-290`, row 4 `DM-291`, row 5 `DM-292`, row 6 `DM-293 DM-294`, row 7 `DM-295`, row 8 `DM-296`. The acceptance node is `DM-284`.
  - Packet issue keys: `DM-285 DM-286 DM-287 DM-288 DM-289 DM-290 DM-291 DM-292 DM-293 DM-294 DM-295 DM-296 DM-284`, positions 1 to 13. They are identical to the planRows order, and the acceptance node comes last.
- **c4 (DM-288):** on a one-sprint fixture epic:
  - Before queueing, `start_transfer` fails with `approval_required` ("The person has not authorized a transfer of this epic.", status `not_started`).
  - Then desktop `queueTransfer` returns `queued`, and `start_transfer` returns `next = [project, sp_…, tk_A, tk_B, tk_C(acceptance), rel:A:B, rel:A:C, rel:B:C]`.
  - Then `record_transfer_item` records `project` (with its url) and the sprint's milestone.
  - Then `get_transfer` shows `next = [tk_A, tk_B, tk_C, rel:A:B, rel:A:C, rel:B:C]`: exactly the remaining refs, in order.
- **c5 (DM-289):** the same epic, with an unsaved draft edit, while the transfer is `in_progress`:
  - `queue_run` (desktop `queueRun`) returns `conflict: Finish or cancel the Linear transfer of this epic first. {"transferStatus":"in_progress"}`.
  - `save_plan` returns the same conflict.
  - After desktop `cancelTransfer` (`canceled`), `save_plan` returns `saved` and `queue_run` returns a `queued` run.
- **c6 (DM-290):** on a two-sprint fixture epic transferred to the fake Linear (19 items):
  - I set the Linear priority of DS-6 to 1; the packet has 3.
  - The read-back is `rejected` with exactly one mismatch, `{"field":"priority","key":"DS-6","expected":3,"actual":1}`.
  - After the driver's fix, the corrected read-back is `verified`.
  - `get_epic` then shows `completed`, with outcome summary "Transferred to Linear: https://linear.fake/acme/project/linear-handoff-fixture-prj-1" and `outcome.transfer.items` holding 7 entries, the first being `{"key":"DS-5","identifier":"ENG-1","url":"https://linear.fake/acme/issue/ENG-1"}`.
  - The summary comment reads "Transferred to Linear: <url> … The project, its 2 milestones, 7 issues and 9 relations match revision 1 of the saved plan, as read back from Linear."
- **c7 (DM-291):** `tools/list` of the built server (63 tools):
  - `get_transfer` has `readOnlyHint:true` (read).
  - `start_transfer` and `record_transfer_item` have `idempotentHint:true` (idempotent).
  - `submit_transfer_readback` has `idempotentHint:false` and `destructiveHint:false` (write).
  - The only tools whose names contain "transfer" are those four. The only name containing "queue" or "cancel" is the pre-existing `cancel_run`. There is no queue or cancel transfer tool.
- **c8 (DM-292):**
  - `prompts/list` includes `darkmechanicus-linear-transfer`, beside the planner, graph-planner, orchestrator, worker, reviewer and sprint-reporter prompts.
  - `dm transfer linear --epic ep_01m6772ffwkwr2a91fsqzfz1he` ran against the database copy with no token (as a reader), exit 0, with empty stderr. It prints:
    - "The transfer is not authorized yet. …";
    - the kickoff ("Move this saved Dark Mechanicus epic to a Linear project, as its orchestrator. …" plus the guide);
    - "=== Packet summary === … 1 milestones, 13 issues, 27 relations. … First issues, in order: 1. DM-285 …";
    - the Linear setup lines and the Agent access lines.

    The full text is in [DM-284-cli-dbcopy.log](DM-284-cli-dbcopy.log).
- **c9 (DM-293):**
  - `src/integration/linearTransfer.test.ts` is part of the 423 passing files of the full suite. Its 4 tests are listed in [DM-284-integration-test.log](DM-284-integration-test.log).
  - The smoke record is [linear-transfer-smoke.md](linear-transfer-smoke.md). I ran it again against this branch's build ([DM-284-smoke.log](DM-284-smoke.log), exit 0). It shows "crashed: Interrupted right after creating tk_… Recorded issues: 3; issues in Linear: 4". Next comes "resumed (resumed: true): adopted tk_… by its marker, created 12 more items". After that it shows "read-back rejected … milestone LS-4 … unexpected iss-8" and "read-back verified", then "epic completed".
- **c10 (DM-294):** The screenshot is taken from DM-294's accepted result, [linear-transfer-chat.png](linear-transfer-chat.png). DM-294 took it from the worktree's built dev app, with an isolated user-data-dir. It shows the "Linear transfer · Scratch transfer fixture" chat with the Codex, Orchestrator and "Does not save plans" labels. The chat's first message is the transfer kickoff for the scratch epic `ep_01m68ac70f7pb2zvhvk4c3m5pp`. DM-294's accepted evidence records the stop: the chat was stopped right after the screenshot, its transcript is `[user_message, turn_stopped]` with 0 tool calls, and the stand-in agent made no tool calls. This acceptance did not run the app again.
- **c11 (DM-295):** the screenshots are taken from DM-295's accepted result:
  - [the Transfer to Linear button](DM-295-transfer-button.png);
  - [the dialog](DM-295-transfer-dialog.png);
  - [the progress strip with a mismatch](DM-295-transfer-strip-mismatch.png): "IN PROGRESS … 19 of 19 created … The last read-back differs from the plan in 2 places: D2S-11 milestone, D2S-13 title";
  - [a transferred epic with its link](DM-295-transferred-epic.png): "Transferred to Linear … Open the project in Linear https://linear.fake/acme/project/onboarding-guide-prj-2".
- **c12 (DM-296):** see [DM-284-links.log](DM-284-links.log).
  - `README.md` lines 11 and 27, and `docs/runbooks/mcp-setup.md` line 238, link `docs/runbooks/linear-transfer.md`.
  - All 9 relative links in the runbook resolve to existing files, and every `#anchor` matches a heading. The same holds for the README and mcp-setup links to it.

## Database copy used for c3 and c8

`/tmp/dm284-dbcopy` was built as follows:

1. `git init`.
2. The coordinating checkout's `.darkmechanicus/` was copied without `local/state.sqlite*`.
3. The live database was copied with `sqlite3 -readonly <live> ".backup '<copy>/.darkmechanicus/local/state.sqlite'"`. The copy reported `user_version` 9 and `integrity_check` ok.

The commands ran with `DARKMECHANICUS_HOME=/tmp/dm284-home`. The build opened the copy and migrated it to 10, as expected; the copy needed no further adaptation. The live database still reports `user_version` 9.
