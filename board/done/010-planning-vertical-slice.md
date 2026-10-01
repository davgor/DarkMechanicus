# EPIC: Planning vertical slice (milestone 2)

Agent creates an epic, Markdown tickets, and a draft plan through MCP; the desktop shows and edits the same records with explicit Draft/Save/Discard; stale updates surface conflicts; restart and clone retain content. Folder picker and the three sidebar buckets per folder.

Sub-tickets: 010.1–010.6.

## Acceptance criteria

- [x] All sub-tickets 010.1–010.6 are done
- [x] Lint, tests, fireguard, typecheck, deadcode, and build pass

## Verification — 2026-09-30

Every sub-ticket below was verified and checked off individually. Gate on commit `cf63a23`: `npm run lint` clean, `npm run typecheck` clean, `npm test` (2,932 app + 105 fireguard tests), `npm run deadcode` clean, `npm run build` ok. Fireguard graded the whole milestone diff against `main`: **A (score 100)**, AST 4,666 asserts / 0 mocks, flake 100/100, mutation 99% (1,908 of 1,923 killed). The 13 survivors that were real test gaps got tests in `c9b703e`; the other two were equivalent mutants, removed by simplification in `471b022`.

## Sub-tickets

### 010.1 — Authoring services: epics, drafts, save, discard

`createEpic`, `listEpics`, `getEpic`, `openDraft`, `updatePlanDraft` (all-or-nothing ops with client-local refs), `savePlan`, `discardPlanDraft`, `getPlan` (explicit saved/draft views with changes since base), `listTickets`, `getTicket`, `listRevisions`.

#### Acceptance criteria

- [x] A draft bundle using client-local refs returns stable ids and one draft revision (tested)
- [x] A stale `expectedDraftRevision` or stale draft base is rejected with `conflict` / `stale_draft` and nothing changes (tested)
- [x] Saved and draft reads are explicit; saved views never show draft-only tickets (tested)
- [x] Discard restores the last saved plan (tested)

#### Verification — 2026-09-30

`src/core/services/{epics,drafts,plans,tickets}.test.ts` (114 tests) plus the lifecycle and workspace integration tests.

### 010.2 — Headless stdio MCP server

Independently launched MCP process (`out/main/mcp.js`) with role/save flags, session registration and heartbeat, structured JSON results and errors; discovery, repository lifecycle, authoring, and planning tools.

#### Acceptance criteria

- [x] `node out/main/mcp.js --repo <dir>` serves tools over stdio with the desktop closed (smoke-tested with an MCP client)
- [x] Tool inputs are validated; errors return `{ ok: false, error: { code, message } }` with `isError` (tested)
- [x] Roles come from launch flags; a planner without `--allow-save` cannot save (tested)
- [x] An agent can create an epic, add tickets with dependencies to a draft, validate, and (when allowed) save through MCP (tested end to end)

#### Verification — 2026-09-30

`npm run smoke:mcp` drives the built `out/main/mcp.js` over real stdio (50 tools, 6 prompts; plan, save, run, claim, submit, accept) under Node 22 and Electron's runtime. `src/mcp/**` tests (275) and `src/integration/mcp.test.ts` cover validation, structured errors, and role flags end to end.

### 010.3 — Desktop main process and preload bridge

Machine-local tracked-folder registry with canonical-path dedupe, native folder picker, per-folder desktop Workspace, allow-listed `dm:command` IPC with payload validation, MCP config snippet, clipboard, safe external links, navigation lockdown.

#### Acceptance criteria

- [x] Tracking an already-registered canonical path selects it instead of duplicating; stop tracking removes only the registry entry (tested)
- [x] IPC rejects unknown commands and untracked folders (tested)
- [x] External links open only for http/https/mailto; navigation and new windows are denied (tested)
- [x] Preload exposes a typed `window.dm` with contextIsolation and sandbox unchanged

#### Verification — 2026-09-30

`src/main/desktop/*.test.ts` (127 tests) and `src/integration/desktop.test.ts` (real registry + Workspace pool). `src/main/index.ts` keeps `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

### 010.4 — Sidebar folders, buckets, onboarding

Left sidebar of tracked folders with a plus button; each folder expands to In progress, Backlog, Completed (in that order) with counts, collapse state retained, draft badges; new folders show the initialize flow and the MCP connection snippet.

#### Acceptance criteria

- [x] Buckets appear in the order In progress, Backlog, Completed with counts from epic status (tested)
- [x] Folder and bucket collapse state persists across reloads (tested)
- [x] An uninitialized folder shows the initialize flow; initializing reveals its buckets (tested)
- [x] The MCP snippet can be copied

#### Verification — 2026-09-30

`src/renderer/src/{sidebar,app,onboarding}` tests; verified in the real Electron app under Xvfb (track folder → onboarding → initialize → buckets with counts; MCP snippet with Copy).

### 010.5 — Epic workspace with Draft / Save / Discard

Epic header with folder, title, bucket, revision; separate Draft and Saved views with an unsaved-change indicator; Save and Discard; conflicts refresh the draft while keeping unsaved form edits; safe Markdown rendering.

#### Acceptance criteria

- [x] Draft and Saved views are distinct, with visible Save/Discard and a draft badge (tested)
- [x] A save conflict reloads the draft and keeps the user's unsaved field text (tested)
- [x] Markdown renders without executing HTML/script and only allow-listed links are clickable (tested)
- [x] Completed epics open read-only with no reopen action (tested)

#### Verification — 2026-09-30

`src/renderer/src/epic` and `ticket` tests (incl. `TicketEditor.test.tsx` conflict keeps unsaved text) and `markdown/parse.test.ts` hostile input; walked through Draft → Save → Saved in the real app.

### 010.6 — Planner and graph-planner skills

Provider-neutral Markdown instructions for planning agents, exposed as MCP prompts.

#### Acceptance criteria

- [x] `skills/planner.md` and `skills/graph-planner.md` describe clarifying outcomes, verifiable acceptance criteria, capability profiles, dependencies, sprint checkpoints, validate-before-save
- [x] Skills are listed and retrievable as MCP prompts (tested)

#### Verification — 2026-09-30

`skills/planner.md`, `skills/graph-planner.md`; `src/mcp/prompts.test.ts` lists and fetches them as `darkmechanicus-*` prompts.
