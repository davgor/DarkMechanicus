# EPIC: Graph and revisions (milestone 3)

Sprints, dependency editing with validation, capability profiles, immutable saved revisions, terminal completed epics. Demonstrates fork and join, cycle rejection, later-sprint prerequisite rejection, preserved pinned inputs, and rejected edits/reopen of completed epics.

Sub-tickets: 011.1–011.5.

## Acceptance criteria

- [x] All sub-tickets 011.1–011.5 are done
- [x] Lint, tests, fireguard, typecheck, deadcode, and build pass

## Verification — 2026-09-30

Every sub-ticket below was verified and checked off individually. Gate on commit `cf63a23`: `npm run lint` clean, `npm run typecheck` clean, `npm test` (2,932 app + 105 fireguard tests), `npm run deadcode` clean, `npm run build` ok. Fireguard graded the whole milestone diff against `main`: **A (score 100)**, AST 4,666 asserts / 0 mocks, flake 100/100, mutation 99% (1,908 of 1,923 killed). The 13 survivors that were real test gaps got tests in `c9b703e`; the other two were equivalent mutants, removed by simplification in `471b022`.

## Sub-tickets

### 011.1 — Whole-plan DAG validation

#### Acceptance criteria

- [x] Fork and join plans validate (tested)
- [x] Cycles are rejected with the cycle path; self-edges, missing references, duplicate edges rejected (tested)
- [x] A prerequisite in a later sprint is rejected with a concrete reason naming both tickets and sprints (tested)
- [x] Warnings flag isolated tickets, empty sprints, and missing criteria without blocking Save (tested)

#### Verification — 2026-09-30

`src/core/plan/graph.test.ts` (108 tests) and `draftOps.test.ts` (111).

### 011.2 — Immutable revisions and terminal completed epics

#### Acceptance criteria

- [x] Each Save creates a new immutable revision; earlier revisions stay readable (tested)
- [x] A run keeps its pinned revision after a newer Save (tested)
- [x] Completed epics reject drafts, saves, status changes, and new runs (tested)

#### Verification — 2026-09-30

`src/core/services/plans.test.ts`; `src/core/workspace.test.ts` keeps a running run on revision 1 after revision 2 is saved; completed-epic rejections in `epics/drafts/runs` tests and the lifecycle test.

### 011.3 — Capability profiles and matching

Provider-neutral task requirements separate from model selection; hard constraints filter host models, preferences rank them; unknown requirements escalate.

#### Acceptance criteria

- [x] Profiles validate against the schema and merge partial edits (tested)
- [x] Matching filters by modalities, tools, reasoning depth, context size, and override; ranks by preferences (tested)
- [x] Unknown required capabilities are reported instead of silently passing (tested)

#### Verification — 2026-09-30

`src/core/schemas.test.ts`, `plan/normalize.test.ts`, and `plan/capabilities.test.ts`.

### 011.4 — Plan graph UI

React Flow vertical flowchart: epic containment at the top (no edges), sprint regions with labels, checkpoint dividers, ticket cards with state label + color, solid (met) vs dashed (waiting) dependency edges; draft editing by connecting handles and moving tickets between sprints with server-validated rejections.

#### Acceptance criteria

- [x] The pure graph model lays out sprints top to bottom with tickets placed below their prerequisites (tested)
- [x] Edge style reflects whether the prerequisite is accepted (tested)
- [x] Rejected dependency edits show the server's concrete reason (tested)
- [x] Ticket states always pair color with a text label

#### Verification — 2026-09-30

`src/renderer/src/graph/*.test.ts` (graph model, flow elements) and workspace tests for rejection banners; in the real app the graph shows sprint bands, checkpoint dividers, labeled states, and solid/dashed edges.

### 011.5 — Ticket detail panel and editor

Markdown body, acceptance criteria, capability profile, requires/unlocks, attempts and evidence; draft editing of all fields including sprint membership.

#### Acceptance criteria

- [x] Panel shows body, criteria, profile, prerequisites, dependents, attempts, and evidence (tested)
- [x] Draft edits apply through `updatePlanDraft` and surface rejections (tested)
- [x] Tickets pinned to an active run or in a completed epic are read-only with the reason shown (tested)

#### Verification — 2026-09-30

`src/renderer/src/ticket/*.test.ts(x)`; `src/core/services/tickets.test.ts` for read-only reasons; seen in the real app (Markdown body, criteria, capability profile, draft editor).
