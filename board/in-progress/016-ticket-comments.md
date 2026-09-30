# EPIC: Ticket comments

The product plan lists Markdown comments among the supporting records, but v1 ships without them. Add comments on tickets and epics that people (desktop) and agents (MCP) can write and read, exported with the epic's portable records and indexed for history search. Follow-up from epics 010–013.

## Acceptance criteria

- [x] `add_comment` / `list_comments` commands (MCP tools + desktop IPC) with the usual validation, authorization, and events (tested)
- [x] Comments travel in `.darkmechanicus/` records, survive reconstruction, and are searchable (tested)
- [x] The ticket panel shows and adds comments; Markdown renders through the safe renderer (tested)

## Verification — 2026-09-30

- Commands: `src/core/services/comments.test.ts` (author from the session, ticket in saved plan or draft, `completed_epic`, `comment.write`, branch guard, `comment.added` event, idempotency, 10,000-comment cap, listing order), `src/core/commands/comments.test.ts` (20,000 characters accepted, 20,001 and blank rejected, author never taken from input), `src/core/schemas.test.ts` (`commentBody`), `src/core/authz.test.ts`; MCP `src/mcp/tools/comments.test.ts` and `src/mcp/server.test.ts` (52 tools); desktop IPC and MCP over a real Workspace in `src/integration/desktop.test.ts` and `src/integration/mcp.test.ts`.
- Records, reconstruction, search: `src/core/repo/finalizer.test.ts` (one immutable file per comment, conflicts, first-save release, flush passes), `src/core/repo/portable.test.ts`, `src/core/repo/paths.test.ts`, `src/core/repo/importer.test.ts` and `src/core/repo/importer.hostile.test.ts` (traversal names, oversized body and file, id/file mismatch, wrong epic, links, non-regular files, malformed JSON, merge markers, too many files, duplicate ids with different content), `src/core/commands/comments.test.ts` (export, delete the local database, reconstruct, list and search), `src/core/services/history.test.ts`, `src/core/services/searchIndex.test.ts`, `src/renderer/src/home/HistorySearch.test.tsx`.
- Ticket panel: `src/renderer/src/ticket/TicketPanel.test.tsx` (list with author, role and time; hostile Markdown; add and refresh; disabled while blank or busy; refusal shown; read-only for completed epics) and `src/renderer/src/ticket/commentsView.test.ts`.
- `npm run smoke:mcp` against the built server lists 52 tools and round-trips a ticket comment. Lint, typecheck, test, deadcode, and build pass. Not yet exercised in the real Electron app.
