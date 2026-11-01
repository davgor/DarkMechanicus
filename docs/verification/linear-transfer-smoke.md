# Linear transfer smoke run (DM-293)

`scripts/linear-transfer-smoke.mjs` runs the scripted transfer agent of `src/test/linearTransferDriver.ts` against the built stdio MCP server and the fake Linear MCP server of `src/test/fakeLinearMcp.ts`.

## How it runs

- It launches `out/main/mcp.js` with `node` as an orchestrator (`--role orchestrator --allow-save`) on a fresh temporary repository. `DARKMECHANICUS_HOME` points to a fresh temporary directory too. The script removes both when it ends.
- The agent uses only the server's MCP tools: `get_capabilities`, `initialize_repository`, `create_epic`, `get_plan`, `update_plan_draft`, `save_plan`, `get_transfer`, `start_transfer`, `record_transfer_item`, `submit_transfer_readback`, `get_epic` and `start_run`.
- Queueing and canceling a transfer are the person's desktop commands, and no MCP tool offers them. A desktop session on the same repository performs them: the source Workspace (`src/core/workspace.ts`), loaded with `tsx`.
- The fake Linear server runs in process and is reached over an in-memory MCP transport.

Steps:

1. A two-sprint epic is queued and transferred. The agent stops right after creating the fourth issue, before recording it. A fresh session resumes from `next`, finds that issue by its marker and records it, and creates the rest.
2. A wrong milestone and an extra issue are injected by hand. The read-back reports both mismatches. The agent fixes them with an update and a move, never a delete, then reads the whole project back again. The second read-back is verified and completes the epic. `start_run` and a new queue are then refused.
3. A one-sprint epic is transferred, canceled and queued again. Every item is adopted: the project, the milestone and the issues by their markers, and the relations by listing them. Nothing new is created, and the read-back is verified.

## Run

Run from the `linear-DM-293` worktree at commit `bcc575709ec251151bb6e282df797b5532602ada`, after `npm run build`, on Node v24.19.0:

```
$ node scripts/linear-transfer-smoke.mjs
- connected to /Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/linear-DM-293/out/main/mcp.js (darkmechanicus 0.19.0, schema 10, role orchestrator)
- queued the transfer of the two-sprint epic ep_01m68adp3w1sb7zh6vsn5dbn75 in the desktop session
- crashed: Interrupted right after creating tk_01m68adp3w851jfm3ybfx1tryv. Recorded issues: 3; issues in Linear: 4; next starts at tk_01m68adp3w851jfm3ybfx1tryv
- resumed (resumed: true): adopted tk_01m68adp3w851jfm3ybfx1tryv by its marker, created 12 more items; Linear holds 7 issues for 7 in the packet
- injected: the issue of LS-4 moved to the sprint 2 milestone; ENG-8 added to the project by hand
- read-back rejected ({"project":true,"milestones":2,"issues":8,"relations":9}): milestone LS-4: expected "ms-1", got "ms-2"; unexpected iss-8: expected null, got "ENG-8"
- read-back verified ({"project":true,"milestones":2,"issues":7,"relations":9})
- fixes: updated the milestone of LS-4; moved ENG-8 out of the project
- epic completed: Transferred to Linear: https://linear.fake/acme/project/linear-handoff-fixture-prj-1
- refused after completion: start_run completed_epic; queueTransfer completed_epic
- transferred the one-sprint epic ep_01m68adp65fnc6pj935xjc8sha: created 8 items
- canceled in the desktop session (canceled, 0 recorded); start_transfer now approval_required
- queued again: created 0, adopted 8 of 8 items by marker (relations by listing)
- read-back verified

Linear layout:
Project Linear handoff fixture <https://linear.fake/acme/project/linear-handoff-fixture-prj-1>
  Milestone Sprint 1
    ENG-1 (unstarted, P2) Define the API [backend] -> blocks ENG-3, blocks ENG-4
    ENG-2 (unstarted, P3) Build the screen [frontend] -> blocks ENG-3, blocks ENG-4
    ENG-3 (unstarted, P3) Wire the screen to the API [backend, frontend] -> blocks ENG-4, blocks ENG-6
    ENG-4 (unstarted, P3) Sprint 1 acceptance
  Milestone Sprint 2: Ship it
    ENG-5 (unstarted, P4) Write the guide [docs] -> related ENG-1, blocks ENG-7
    ENG-6 (unstarted, P1) Release [backend] -> blocks ENG-7
    ENG-7 (unstarted, P3) Sprint 2 acceptance
Project Cancel path fixture <https://linear.fake/acme/project/cancel-path-fixture-prj-2>
  Milestone Sprint 1
    ENG-9 (unstarted, P3) Prepare [ops] -> blocks ENG-10, blocks ENG-11
    ENG-10 (unstarted, P2) Deliver -> blocks ENG-11
    ENG-11 (unstarted, P3) Sprint 1 acceptance
Outside any project
  ENG-8 (unstarted, P0) Stray note
```

The command exited with code 0. `LS-4` is the Dark Mechanicus key of "Wire the screen to the API" (the repository is named `linear-smoke`), and `ENG-n` are the fake's Linear identifiers. They rise in execution order in each project, and each acceptance issue comes last in its milestone, blocked by the work issues of its sprint. `ENG-8` was moved out of the project and still exists.
