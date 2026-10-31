# DM-336 sprint acceptance evidence

Integration branch: `linear-sprint-3` (sprint 3, the final sprint of the Linear handoff epic). Work tickets DM-337 to DM-341 are merged at `b23a9c9`. DM-316 is optional and not covered. **The tree includes `main` at `022734c` (v0.20.0):** DM-337 merged it in `5c6c873`, and `git merge-base --is-ancestor 022734c HEAD` exits 0. `main` still pointed at `022734c` during this acceptance.

Every check ran in the integration worktree on macOS, arm64, Node 24.19.0. Fireguard grading is not part of this epic's Definition of Done, so it did not run as a grading step. The Fireguard test suite still runs inside `npm test`. Every command that opened a repository ran against a fresh `mktemp -d` scratch repository with a temporary `DARKMECHANICUS_HOME`, all removed afterwards. None opened the coordinating checkout's `state.sqlite`.

## Integration fixes

None were needed. All six checks passed on the first run at `b23a9c9`, including `npm run deadcode` against the committed `.tsprune-ignore` baseline.

## Definition of done

| Check | Command | Result | Log |
|---|---|---|---|
| lint | `npm run lint` | Passed: exit 0, no findings (`oxlint src scripts`) | [DM-336-lint.log](DM-336-lint.log) |
| typecheck | `npm run typecheck` | Passed: exit 0 for the node, web and fireguard projects | [DM-336-typecheck.log](DM-336-typecheck.log) |
| test | `npm test` | Passed: 447 files, 8,684 tests passed, 9 skipped. Then the Fireguard suite: 20 files, 105 tests | [DM-336-test.log](DM-336-test.log) |
| coverage | `npm run coverage` | Passed: 447 files, 8,684 passed, 9 skipped. Statements 97.58%, branches 95.08%, functions 96.24%, lines 97.71%, against thresholds of 97, 95, 96 and 97 | [DM-336-coverage.log](DM-336-coverage.log) |
| deadcode | `npm run deadcode` | Passed: "No new dead exports found." | [DM-336-deadcode.log](DM-336-deadcode.log) |
| build | `npm run build` | Passed: main (`out/main/index.js`, `mcp.js`, `cli.js`), preload and renderer | [DM-336-build.log](DM-336-build.log) |

Branch coverage is 95.08% against a threshold of 95, a margin of 0.08 points.

`npm test` prints only file and test totals. To show the named tests passing in the full suite, the whole Vitest suite ran once more with `npx vitest run --reporter=verbose` at `b23a9c9`: 447 files, 8,684 passed, 9 skipped, exit 0 ([DM-336-test-verbose.log](DM-336-test-verbose.log)). [DM-336-named-tests.log](DM-336-named-tests.log) holds the lines of that log cited below.

## Acceptance criteria

The script [DM-336-check.mjs](DM-336-check.mjs) produced the output for c1 to c4. Its full output is in [DM-336-check.log](DM-336-check.log): exit 0, "all assertions passed". It runs this worktree's built `out/main/mcp.js` (darkmechanicus 0.20.0, schema 11) over stdio. The person's desktop commands (`queueTransfer`, `resolveEpicConflict`) go through a desktop `Workspace` loaded from source with tsx, as in `scripts/linear-transfer-smoke.mjs`, because no MCP tool offers them.

- **c1 (DM-337):** see [DM-336-merge-base.log](DM-336-merge-base.log), [DM-336-main-build.log](DM-336-main-build.log) and the c1 section of the check log.
  - `git merge-base --is-ancestor 022734c HEAD; echo $?` prints `0`. On the ancestry path, `5c6c873` ("Merge main (022734c, v0.20.0) into linear-DM-337") has `022734c` as its second parent.
  - `git diff -U0 022734c HEAD -- src/core/db/migrations.ts` makes three changes:
    - `SCHEMA_VERSION` goes from 10 to 11.
    - The V11 transfers SQL is added.
    - The V10 list entry gains a trailing comma, followed by `{ version: 11, sql: V11 }`.

    `main`'s V1 to V10 are otherwise untouched.
  - **The V10 database.** `main` at `022734c` was built in a throwaway `git worktree add --detach /tmp/dm336-main-022734c.NE6bth 022734c`, which was removed afterwards. Its `package.json` and lock file match this branch, so it used this worktree's `node_modules`. That build reports darkmechanicus 0.20.0, schema 10. It initialized a scratch repository and created an epic. Then `sqlite3 …/state.sqlite "PRAGMA user_version; SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'transfer%'"` printed `10` and no table.
  - **This build on the same repository and home** reports schema 11. `get_epic` still returns "Created by main at V10", and `get_transfer` answers `not_started`. Afterwards the same query printed `11`, `transfer_items` and `transfers`.
  - **A fresh scratch repository** initialized by this build also printed `11`, `transfer_items` and `transfers`.
  - The unit tests pass in the full suite: `migrations.test.ts > schema v11 on top of the v10 scrub > upgrades a database main's v10 scrub left, adding the transfer tables and leaving stored responses untouched` and `… > brings a fresh database straight to v11 with the transfer tables`.
- **c2 (DM-338):** two machines, each with its own scratch repository, home, local database and built server. A "pull" copies machine A's tracked records (everything under `.darkmechanicus/` except `local/`) into machine B, as `DM-310-transfer-check.mjs` did.
  1. A saves the one-sprint fixture epic as revision 1 (`rv_…gtf3`) and flushes. After the pull, B holds revision 1.
  2. A renames a ticket to "Prepare (saved on A)", then saves and flushes revision 2 (`rv_…n19y`). B renames the other ticket in its draft.
  3. The pull lands. B's `save_plan` answers `pending` (`rv_…85rm`, revision 2). B has not reconciled yet; its server reconciles on a 15-second heartbeat. The save's export is refused, so B's change waits: `get_storage_status` shows `pending 1` with the error "tracked state and pointer hold records this machine has not imported … choose which to keep in the desktop app's Storage card: keep the tracked records or write local".
  4. B's `flush_portable_state` returns `{"flushed":0,"failed":1}` with the same error for `snapshot rv_…85rm`. The sha256 of every tracked file of the epic in B matches A's exactly: `current.json`, `state.json` and A's two snapshots. B's own snapshot was never written.
  5. B's `reconcile_repository` imports nothing. It reports one conflict: "Tracked records for epic … changed while local changes are waiting to be exported, so neither was applied. Choose which to keep in the desktop app's Storage card: keep the tracked records … or write local …".
  6. `get_storage_status` lists that conflict with `resolvable: true`. B still holds revision 1.
  7. No agent can choose:
     - None of the built server's 63 tools names a conflict or a resolution.
     - An orchestrator `Workspace` calling `resolveEpicConflict` gets `unauthorized: This orchestrator session is not permitted to perform "repo.resolve_conflict"`.
  8. The person's desktop `resolveEpicConflict {keep: 'tracked'}` returns `{"kept":"tracked","abandonedRevisionIds":["rv_…85rm"],"error":null}`. Afterwards:
     - B holds A's revision 2 (`rv_…n19y`), with tickets `["Prepare (saved on A)","Deliver"]` and no conflict.
     - The tracked files still match A's exactly.
     - The next flush returns `failed 0`. The reconcile lists the epic as unchanged with no conflicts, and the storage status lists no conflict for it.

  The unit tests pass in the full suite (all in `importer.test.ts`):
  - `a local epic change and pulled records of the epic > a flush leaves the tracked files as pulled, and the conflict stays and names the choice`
  - `the person's choice … > choosing to import keeps the pulled revision and drops the local change`
  - `… > choosing to overwrite writes local over the pulled records`
  - `… while a local save waits to be written > choosing to import drops a local save still waiting to be written, and its snapshot is never written`
  - `refusing a choice … > refuses when there is nothing to choose, and to any session but the desktop`
- **c3 (DM-339):** both parts ran against the built server.
  - **Transport.** The script writes raw JSON-RPC lines to the built server's stdin, with `MCP_MESSAGE_MAX_BYTES` = 32,000,000.
    - A `tools/call` line of 32,000,106 bytes with `id` first is answered `{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"A message is at most 32000000 bytes; this one was longer, so it was not read. …"}}`.
    - The next `get_capabilities` request is answered `ok` (schema 11).
    - The same happens for a 32,000,112-byte line with `"id":"big-3"` last, the way the SDK client writes it.
    - A line of exactly 32,000,000 bytes is read and answered `ok`, so the limit is inclusive.
    - `tools/list` still answers afterwards, and the server process keeps running.
    - stderr logs `Refused a message of more than 32000000 bytes without reading it (id 2)` and the same for `"big-3"`.
  - **Total read-back cap.** The script uses the real limit, `READBACK_LIMITS.totalChars` = 100,000,000. A scratch epic's transfer is queued by the desktop and started.
    - It sends 13 non-final parts of 15 issues with 500,000-character descriptions. Each part is about 7,502,235 characters of JSON, under the 8,000,000 per-part cap. All 13 are accepted, for 195 issues and about 97.5 million characters merged.
    - The 14th part would bring the merged read-back to about 105 million characters. It is refused: `error invalid_input: A transfer read-back is at most 100000000 characters of JSON; with this part it would be longer. Nothing from this part was stored, and the parts sent before are kept. …` with details `{"limit":"totalChars","max":100000000}`.
    - A small part sent next is accepted with 196 issues, so the earlier parts were kept.
    - The same oversized part sent as the final part is refused with `invalid_input` and the text "This final part still ended the read-back". A new part after it starts over with 1 issue, so the stored parts were cleared.
  - The unit tests pass in the full suite:
    - `transfers.test.ts > submitTransferReadback merged size > refuses a part that takes the merged JSON past totalChars, naming the limit, and keeps the parts sent before`
    - `… > compares a final part that brings the merged JSON to exactly totalChars, and refuses one past it after ending the read-back`
    - `transport.test.ts > BoundedStdioServerTransport > answers a line over the limit with an error without parsing it, and serves the next request`, together with the rest of `transport.test.ts`.
- **c4 (DM-340):** the full suite passes the following tests ([DM-336-named-tests.log](DM-336-named-tests.log)):
  - `src/mcp/skills.test.ts > the Linear transfer runbook > gives each Linear setup line verbatim in its setup table, once` (the runbook pin).
  - `… > SKILLS_VERSION > moved past 1.6.1 when the Linear guide reworded the final read-back part`.
  - `… > skill content requirements > linear-transfer keeps its required rules`. This test holds the new phrases "An accepted final part ends the read-back", "the stored parts are still cleared" and "over the per-part size changes nothing, final or not".
  - `… > SKILLS > gives each Linear setup line of dm transfer and the app verbatim in the transfer guide`.

  The built server has no `get_skill` tool, so the served guide was read in two ways:
  - Its `get_capabilities` returns `skillsVersion 1.6.2`.
  - `prompts/get darkmechanicus-linear-transfer` serves the new final-part line: "An accepted final part ends the read-back: it is verified, or its mismatches are reported and the stored parts are cleared. A final part that takes the merged read-back past an item limit or the total size is refused, but the stored parts are still cleared. …" The old wording "A final part always ends the read-back, whatever the result" is absent.
- **c5 (DM-341):** see [DM-336-rules.log](DM-336-rules.log).
  - `cmp .agents/… .claude/…` and `cmp .claude/… .cursor/skills/delivery-standards/SKILL.md` print nothing and exit 0. The three copies share the sha256 `0043f9dd…cdb6b`.
  - `grep -n ""` of the three files shows the same line 13 in each: "This skill exists as three identical copies, `.agents/skills/delivery-standards/SKILL.md`, `.claude/skills/delivery-standards/SKILL.md` and `.cursor/skills/delivery-standards/SKILL.md`. Keep all three byte-identical … `.cursor/rules/delivery-standards.mdc` is a shorter Cursor rule … it is not a copy of this file."
  - `git ls-files` lists exactly those three copies plus the `.mdc` rule.

## Observations

- In c2, B's `get_storage_status` showed the waiting export's error, which already names the choice, before any reconcile. The `conflicts` list (and so the Storage card's `resolvable` choice) appeared only after `reconcile_repository`. An open session's heartbeat reconciles (`Workspace.heartbeat`; the MCP server's heartbeat runs every 15 seconds), so the choice shows up after the next heartbeat or reconcile. This is not a Definition of Done finding, and no criterion depends on it.
