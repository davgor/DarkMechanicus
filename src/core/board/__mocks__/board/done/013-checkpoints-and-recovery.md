# EPIC: Sprint checkpoints and recovery (milestone 5)

Reports, advancement with human approval grants, pause/cancel, crash reconciliation, revision adoption, takeover of imported runs, searchable history, backup/export, hostile-import hardening.

Sub-tickets: 013.1–013.6.

## Acceptance criteria

- [x] All sub-tickets 013.1–013.6 are done
- [x] Lint, tests, fireguard, typecheck, deadcode, and build pass

## Verification — 2026-09-30

Every sub-ticket below was verified and checked off individually. Gate on commit `cf63a23`: `npm run lint` clean, `npm run typecheck` clean, `npm test` (2,932 app + 105 fireguard tests), `npm run deadcode` clean, `npm run build` ok. Fireguard graded the whole milestone diff against `main`: **A (score 100)**, AST 4,666 asserts / 0 mocks, flake 100/100, mutation 99% (1,908 of 1,923 killed). The 13 survivors that were real test gaps got tests in `c9b703e`; the other two were equivalent mutants, removed by simplification in `471b022`.

## Sub-tickets

### 013.1 — Sprint reports and gate evaluation

#### Acceptance criteria

- [x] Reports store accepted/failed/blocked work, changes, checks, risks, follow-ups, exit criteria, and (final sprint) epic outcome (tested)
- [x] A failed required ticket or unmet exit criterion blocks advancement with the reason (tested)

#### Verification — 2026-09-30

`src/core/services/reports.test.ts` and `checkpoints.test.ts`.

### 013.2 — Human approval grants and advancement

#### Acceptance criteria

- [x] Human-gated sprints advance only by consuming a desktop-issued grant bound to run, revision, sprint, and report hash (tested)
- [x] Forged, replayed, and stale (report changed / revision adopted) grants are rejected (tested)
- [x] Auto policy advances only when the user authorized auto-continue on that run; agents cannot enable it (tested)
- [x] Advancing the final sprint completes the run and the epic with its outcome (tested)

#### Verification — 2026-09-30

`src/core/services/checkpoints.grants.test.ts` and `checkpoints.control.test.ts` (every forged binding field, replay, stale report/revision, auto policy, final completion); the lifecycle test confirms an agent cannot approve.

### 013.3 — Revision adoption, takeover, reconciliation

#### Acceptance criteria

- [x] A run adopts a newer saved revision only at a checkpoint with no open attempts; unchanged accepted tickets carry over, changed ones need explicit carry-forward (tested)
- [x] An imported in-progress run requires explicit takeover; takeover marks leased attempts for reconciliation (tested)
- [x] Retry grants allow another attempt after the limit (tested)

#### Verification — 2026-09-30

`src/core/services/adoption.test.ts` (incl. the closed-sprint guard), `runs.test.ts` takeover, `checkpoints.control.test.ts` retry grants; the clone test shows an imported run is not owned until taken over.

### 013.4 — Searchable history, backup, branch epic index

#### Acceptance criteria

- [x] `searchHistory` finds tickets, attempt outcomes, and reports by keyword; results survive reconstruction (tested)
- [x] `backupDatabase` writes a consistent snapshot via `VACUUM INTO` (tested)
- [x] Epics on other local branches are listed from Git without switching the checkout (tested)

#### Verification — 2026-09-30

`src/core/services/history.test.ts`, `src/core/repo/backup.test.ts`, `branchEpics.test.ts`; search survives reconstruction in the lifecycle clone test.

### 013.5 — Hostile repository import suite

#### Acceptance criteria

- [x] Traversal ids, symlinked directory escapes, merge markers, malformed ids, oversized graphs, partial snapshots, and hash mismatches are rejected without outside writes (tested)
- [x] Hostile Markdown and unsafe links render inert in the desktop (tested)

#### Verification — 2026-09-30

`src/core/repo/importer.hostile.test.ts` (28 cases) and `src/renderer/src/markdown/parse.test.ts` / `Markdown.test.tsx` (scripts, event handlers, and javascript:/data: links stay inert).

### 013.6 — Desktop checkpoint view, history search, storage footer

#### Acceptance criteria

- [x] Checkpoint view shows the report, gate conditions, approve & advance, retry, and follow-up "add to draft" (tested)
- [x] History search view lists results and opens the epic (tested)
- [x] Sidebar footer shows MCP sessions and export/commit status with a Flush action (tested)

#### Verification — 2026-09-30

`src/renderer/src/checkpoint`, `home/HistorySearch`, and `sidebar/SidebarFooter` tests; in the real app the checkpoint gate approved and advanced to Sprint 2.
