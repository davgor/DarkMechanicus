# EPIC: Persistence foundation (milestone 1)

Milestone 1 of [`docs/product-plan.md`](../../docs/product-plan.md): choose the SQLite driver and prove the desktop and the headless MCP process can share one repository-local, migrated database; draft isolation; complete-snapshot Save with crash-safe finalization and reconstruction from Git-tracked records. Architecture: [`docs/architecture.md`](../../docs/architecture.md).

Sub-tickets: 009.1–009.6.

## Acceptance criteria

- [x] All sub-tickets 009.1–009.6 are done
- [x] Lint, tests, fireguard, typecheck, deadcode, and build pass

## Verification — 2026-09-30

Every sub-ticket below was verified and checked off individually. Gate on commit `cf63a23`: `npm run lint` clean, `npm run typecheck` clean, `npm test` (2,932 app + 105 fireguard tests), `npm run deadcode` clean, `npm run build` ok. Fireguard graded the whole milestone diff against `main`: **A (score 100)**, AST 4,666 asserts / 0 mocks, flake 100/100, mutation 99% (1,908 of 1,923 killed). The 13 survivors that were real test gaps got tests in `c9b703e`; the other two were equivalent mutants, removed by simplification in `471b022`.

## Sub-tickets

### 009.1 — Domain contracts, ids, hashing, errors

Shared vocabulary for every entry point: three-state statuses, plan bundle types, read-model views, `CommandApi`, error codes; collision-resistant ids, canonical-JSON content hashes, `DomainError`.

#### Acceptance criteria

- [x] `src/shared/domain/{status,bundle,views,api,errors}.ts` define the contracts used by core, MCP, and desktop
- [x] Stable ids are collision-resistant (`<prefix>_<time><random>`), validated by `STABLE_ID_PATTERN` (tested)
- [x] `contentHash` is stable across object key order and `prettyJson` output is key-sorted (tested)
- [x] Unknown thrown values map to `internal`; domain errors keep code/message/details (tested)

#### Verification — 2026-09-30

Contracts live in `src/shared/domain/`. `src/core/ids.test.ts` (61 tests), `canonical.test.ts` (23), and `errors.test.ts` (15) pin id format/prefixes, key-order-independent hashing, sorted pretty JSON, and error mapping.

### 009.2 — SQLite driver, database wrapper, migrations

Use built-in `node:sqlite` (present in Electron 42's Node 24 and system Node ≥ 22.13). WAL, foreign keys, busy timeout, `BEGIN IMMEDIATE` transactions with savepoints, schema v1 with a migration lock; refuse newer schemas. Record the decision.

#### Acceptance criteria

- [x] `docs/decisions/0001-sqlite-driver.md` records the choice, alternatives, and the Electron-runtime verification
- [x] `openDatabase` applies WAL/foreign keys/busy timeout; `tx` commits, rolls back on error, and nests via savepoints (tested)
- [x] `migrate` creates schema v1 once, is idempotent, and refuses a database newer than the build with `incompatible_schema` (tested)
- [x] Two connections to one file database see each other's committed writes and serialize writers (tested)

#### Verification — 2026-09-30

Decision record `docs/decisions/0001-sqlite-driver.md`. `src/core/db/database.test.ts` (62) covers pragmas, commit/rollback/savepoints, bounded BEGIN retries, and two connections to one file; `migrations.test.ts` (82) covers v1 creation, idempotence, refusal of newer schemas, and the partial unique indexes.

### 009.3 — Repository layout, initialization, path containment

`.darkmechanicus/` layout with `project.json`, `.gitignore` (`local/`), `local/machine.json`; explicit, repeatable initialization that never commits; owned paths built from validated ids and verified to stay inside `.darkmechanicus/` (symlinks/junctions included).

#### Acceptance criteria

- [x] Initializing creates the layout and is repeatable without changing an existing project id (tested)
- [x] `.darkmechanicus/.gitignore` ignores `local/` so the live database never enters Git (tested)
- [x] Owned path helpers reject malformed ids, traversal, and symlinked escapes with `unsafe_path` (tested)
- [x] Repository root discovery walks up to `.darkmechanicus/project.json` or `.git` (tested)

#### Verification — 2026-09-30

`src/core/repo/initialize.test.ts`, `paths.test.ts`, `discovery.test.ts`, and the lifecycle integration test (`src/integration/lifecycle.test.ts`) cover layout creation, repeatability, `.gitignore`, containment (symlinks, traversal, malformed ids), and root discovery.

### 009.4 — Portable records and crash-safe Save finalizer

Outbox-driven finalizer writes complete immutable snapshots, then atomically replaces the pointer; epic state and run history use the same machinery. Interruption at every write boundary preserves the last good state and retries idempotently.

#### Acceptance criteria

- [x] Snapshot, pointer, epic-state, and run-history files are key-sorted JSON validated by schemas (tested)
- [x] A fault injected at each write boundary (temp write, fsync, rename, read-back, pointer rename, DB commit) leaves the previous pointer and snapshot intact and the entry pending (tested)
- [x] Re-running the flush after a fault completes the save with identical content (tested)
- [x] Save reports `saved` only after the new revision is recoverable from repository records; otherwise `pending` with the draft kept (tested)

#### Verification — 2026-09-30

`src/core/repo/finalizer.test.ts` injects faults at every write boundary and verifies intact prior state and idempotent retry; `src/core/workspace.test.ts` shows a failing snapshot write returns `pending` with the draft kept, and a later flush completes the save.

### 009.5 — Reconstruction and transactional import

Rebuild the local database from tracked records on first open/clone; detect changed tracked state on pull/branch change; stage and validate the full import before one transactional swap; surface conflicts instead of overwriting unexported local changes.

#### Acceptance criteria

- [x] Copying `.darkmechanicus/` without `local/` to another directory reconstructs epics, revisions, statuses, and run history (tested)
- [x] An invalid or partial import changes nothing and reports why (tested)
- [x] Tracked changes to an epic with pending local exports are reported as a conflict and not applied (tested)
- [x] A changed checkout branch pauses active runs and blocks save/dispatch until reconciled (tested)

#### Verification — 2026-09-30

`src/core/repo/importer.test.ts` and `importer.hostile.test.ts` (28 hostile cases); the lifecycle test reconstructs a clone without `local/`; `src/core/workspace.test.ts` proves a branch switch holds exports and blocks dispatch until reconciled.

### 009.6 — Desktop + headless process share one database

Prove the Electron runtime and a separate Node process open and migrate the same repository-local database, and that competing writers never duplicate claims.

#### Acceptance criteria

- [x] `node:sqlite` loads inside Electron's runtime (`ELECTRON_RUN_AS_NODE=1`) and system Node (verified, recorded in 0001)
- [x] A multi-process stress script races claims on one ticket and observes exactly one winner (`scripts/spike/claim-stress.ts`, run and recorded)
- [x] Opening a database while another process holds the write lock waits (busy timeout) instead of failing (tested)

#### Verification — 2026-09-30

Electron 42.11.9 (Node 24.19) and Node 22.22 both load `node:sqlite` (recorded in 0001). `npm run spike:claims`: 8 processes × 25 rounds, exactly one winner every round, 0 busy errors (recorded in 0001). `npm run smoke:mcp` passes under Node and under Electron's runtime.
