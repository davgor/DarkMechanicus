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
