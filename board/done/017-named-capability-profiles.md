# EPIC: Named capability profiles

`initializeRepository` creates `.darkmechanicus/profiles/`, and tickets carry inline capability profiles, but there is no way to save and reuse a named profile ("ui-implementation", "deep-review"). Add named, provider-neutral profiles stored as portable records that tickets can start from. Follow-up from ticket 011.3.

## Acceptance criteria

- [x] `list_profiles`, `get_profile`, `save_profile` commands with schema validation and path containment (tested)
- [x] The ticket editor can apply a named profile to a ticket's capability requirements (tested)
- [x] Profiles import on reconcile like other tracked records, rejecting hostile files (tested)

## Verification — 2026-09-30

- Commands: `src/core/profileNames.test.ts` (1-64 character slug, 64 accepted and 65 rejected, every Windows device name rejected, traversal and separators rejected), `src/core/services/profiles.test.ts` (create/replace revisions, conflicts, `profile.write`, branch guard, idempotency, events, outbox), `src/core/commands/profiles.test.ts` (Workspace: strict input validation, export to `profiles/<name>.json`, no write through a linked `profiles/`, reconstruction on first open of a clone), `src/core/repo/finalizer.test.ts`, `src/core/repo/portable.test.ts`, `src/core/repo/paths.test.ts`, `src/core/authz.test.ts`, `src/core/db/migrations.test.ts` (schema v4), `src/mcp/tools/profiles.test.ts`, `src/mcp/server.test.ts` (53 tools), `src/integration/mcp.test.ts`, `src/integration/desktop.test.ts`.
- Ticket editor: `src/renderer/src/ticket/TicketEditor.profiles.test.tsx` (pick a profile, fields refill, nothing written until Apply, one capability patch on Apply, hint states, save as profile / replace / failure / cancel) and `src/renderer/src/ticket/ticketForm.test.ts`.
- Import: `src/core/repo/profileImport.test.ts` (reconstruction, change detection, conflicts and their resolution) and the profile cases in `src/core/repo/importer.hostile.test.ts` (hostile names, links and junctions, a linked `profiles/`, directories, size and entry limits, merge markers, malformed and polluting records, a record naming another profile); `src/core/repo/storage.test.ts`; `initializeRepository` still creates `profiles/` (`src/core/repo/initialize.test.ts`).
- Gate: `npm run lint`, `npm run typecheck`, `npm test`, `npm run deadcode`, `npm run build` pass. Fireguard is run centrally.

### Integration and gate

Merged into `claude/dazzling-sagan-03on5q` with epics 016–018 together (schema migrations v2–v4, one capability table for every command). Full gate on the merged head: lint and typecheck clean, `npm test` green, deadcode clean, build ok, `npm run smoke:mcp` passes (55 tools for an orchestrator with `--allow-save`). Checked in the real app under Xvfb with separate orchestrator and worker MCP processes: comments render and are added from the desktop, a profile applied in the ticket editor reaches the draft, the worker's tool list is filtered, bad arguments answer `invalid_input`, and the IPC guard refused nothing from the app page. Fireguard over the three epics (`cf63a23..6eac375`): **A (score 99)**, flake 100/100, mutation 97% (522 of 540; the survivors sit on pre-existing lines graded in the first run, plus one equivalent mutant).

### Review follow-ups

An independent review found Apply in the draft ticket editor rewriting capability groups it does not show (it now writes only the groups the person changed, through a field or a profile, `a413dc2`), a file or link at `profiles/` failing the whole reconcile and so opening (now reported and read as empty, `4a878a7`; the same for `epics/` and `history/`, `4c8b35d`), leftover temp files reported as rejected forever (now ignored, `036e1ae`), a stale revision after a conflicting "Save as profile…" (the list now reloads, `c315e84`), and every reconcile re-reading every profile (stamp cache, `00f9f56`). Fireguard over the fixes (`6eac375..4c8b35d`): **A (score 100)**, mutation 100% (320 of 320).
