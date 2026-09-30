# Dark Mechanicus — implementation architecture

This is the build contract for the product described in [`product-plan.md`](product-plan.md). Where the plan says "proposed", this document records the choice that was implemented. Exact types live in code; this file explains the rules those types carry.

## Processes and modules

```text
External agent host ──stdio──> out/main/mcp.js  (src/mcp)   ─┐
                                                             ├─> src/core  (Workspace: command layer) ─> SQLite + .darkmechanicus/ files
Electron renderer ─> preload (window.dm) ─> main IPC (src/main/desktop) ─┘
```

| Path | Runs in | Responsibility |
|------|---------|----------------|
| `src/shared/domain` | everywhere (renderer-safe) | Vocabulary and contracts: statuses, plan bundle types, error codes, read-model views, the `CommandApi` interface |
| `src/core` | Node (Electron main and the MCP process) | The only place business rules live: database, migrations, services, portable records, import, finalizer, authorization |
| `src/mcp` | Node child process launched by an agent host | Stdio MCP server; each tool validates input and calls one `CommandApi` method |
| `src/main` | Electron main | Window, auto-update, folder registry, native dialogs, IPC handlers that call `CommandApi` |
| `src/preload` | Electron preload (sandboxed) | Narrow typed bridge `window.dm` |
| `src/renderer` | Chromium renderer | React UI; never touches the database or filesystem |
| `skills/` | shipped as text | Provider-neutral agent instructions, exposed as MCP prompts |

No renderer database access and no duplicated business rules: MCP handlers and IPC handlers are adapters only.

## Storage decision

SQLite through the built-in **`node:sqlite`** module (`DatabaseSync`). It ships inside Electron 42's Node 24 runtime and in system Node ≥ 22.13, so the desktop and the headless MCP process open the same database with no native `.node` binary to rebuild per ABI. See [`docs/decisions/0001-sqlite-driver.md`](decisions/0001-sqlite-driver.md).

- Database: `<repo>/.darkmechanicus/local/state.sqlite` (Git-ignored). WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=FULL`.
- Every write runs in `db.tx()` = `BEGIN IMMEDIATE` (nested calls use savepoints). Concurrent processes serialize on the write lock.
- `PRAGMA user_version` is the schema version. `migrate()` runs under the write lock; a database newer than the build is refused with `incompatible_schema`, never downgraded.
- Backups use `VACUUM INTO` (a consistent snapshot), never a raw file copy.

## The command layer (`src/core`)

A **Workspace** is opened per repository root and implements `CommandApi` (`src/shared/domain/api.ts`). Each public command follows the same sequence:

1. **Validate** the untrusted input with the zod schemas in `src/core/schemas.ts` (`parseInput`). Limits (`LIMITS`) bound string sizes, list lengths, and graph sizes.
2. **Authorize** with `requireCapability(ctx.session, capability)`. Capabilities come from the session's role, fixed when the session registered (desktop launch, or the MCP process's launch flags). A caller-supplied name is never authority. The capability each command requires is declared once in `COMMAND_CAPABILITIES` (`src/core/commands/capabilities.ts`, exhaustive over `CommandName`); a test proves the services enforce exactly that table for every role.
3. **Branch guard** — commands that save, export, or dispatch work call `ctx.assertBranch()`; it throws `branch_changed` if the coordinating checkout's branch differs from the one recorded at the last reconcile. Flushing portable records is guarded the same way (pending exports belong to the recorded branch), and a Workspace opened after a branch switch does not reconcile automatically: the person (or agent) reconciles explicitly, which pauses active runs and records the new branch.
4. **Transact** — the whole mutation runs in one transaction, optionally wrapped by `withIdempotency` (same key + same request ⇒ original response; same key + different request ⇒ `idempotency_mismatch`).
5. **Record** — append an event (`appendEvent`) and enqueue portable-record work (`enqueueOutbox`) inside that same transaction.
6. **Flush** — after commit, the Workspace runs the finalizer to write portable records. Flush failure never rolls back the command; it leaves the outbox entry `pending/failed` and storage status shows it.

Service functions take a `Ctx` (`src/core/context.ts`: db, clock, ids, session, machineId, projectId, assertBranch) and never read globals, so tests drive time and ids deterministically.

Errors are `DomainError(code, message, details)` with codes from `src/shared/domain/errors.ts`; adapters convert them with `toErrorShape`.

### Sessions and roles

| Role | Registered by | Notable capabilities |
|------|---------------|----------------------|
| `desktop` | Electron main (the person) | Everything editorial, `plan.save`, run control, **checkpoint approval, auto-continue authorization, retry grants, queue run** (human-only) |
| `planner` | MCP `--role planner` | read, create epics, edit drafts, save named profiles; `plan.save` only with `--allow-save` |
| `orchestrator` (MCP default) | MCP `--role orchestrator` | planner + runs, claims, reviews, reports, advance (never approve) |
| `worker` | MCP `--role worker` | heartbeat/submit/fail for a claim token it holds |
| `reviewer` | MCP `--role reviewer` | accept/reject submissions |

See `src/core/authz.ts` for the exact sets. No agent role receives a human-only capability. Every role holds `comment.write` (see [Comments](#comments)).

## Domain rules

### Statuses

Epics and tickets have exactly three statuses: `backlog`, `in_progress`, `completed`. Paused/failed/awaiting review are run or attempt conditions, never statuses.

- Starting work (a claim, or a run starting) moves the ticket and its epic to `in_progress`.
- A ticket becomes `completed` only through an accepted attempt (or explicit carry-forward) — `setTicketStatus(completed)` succeeds only if that evidence exists in the epic's active or latest run.
- An epic becomes `completed` only when the final sprint checkpoint advances: all required tickets accepted, the final sprint report carries an epic outcome whose success criteria are all met, and the checkpoint policy's authorization is present. `setEpicStatus(completed)` enforces the same rule.
- `completed` is terminal for epics: no status change, no draft, no save, no new run. Tickets of a completed epic are read-only.
- `in_progress` → `backlog` is allowed for an epic without an active run, and for a ticket without an open attempt.

### Drafts and saved revisions

- An epic has at most one draft (`drafts` table) with a `draft_revision` counter for optimistic concurrency and a `base_revision_id`.
- `createEpic` creates the epic (`backlog`) plus an initial draft (one empty sprint). Until the first Save the epic has no saved revision.
- `openDraft` creates a draft from the current saved bundle if none exists. `updatePlanDraft` also creates it implicitly.
- `updatePlanDraft(ops, expectedDraftRevision)` applies `DraftOp`s through `applyDraftOps` (`src/core/plan/draftOps.ts`): all-or-nothing, and every rejected op returns a concrete reason (e.g. "Dependency not added. DM-203 is in Sprint 2 and can't require DM-301 in Sprint 3…"). A stale `expectedDraftRevision` fails with `conflict`. Client-local refs map to stable ids in `refMap`.
- `savePlan(expectedDraftRevision)` validates the whole bundle (`validatePlan`; errors ⇒ `invalid_plan`), rejects a draft whose base is no longer current (`stale_draft`), then records a **pending** revision + outbox entry in one transaction. The finalizer writes the snapshot and pointer; only then is the revision `saved`, the epic's `current_revision_id` advanced, `ticket_status` rows created for new tickets, the draft removed, and the result `saved`. If the finalizer fails the result is `pending`, the draft stays, and the next flush retries. Saving a draft identical to the current revision returns `unchanged`.
- Execution reads only saved revisions. A pending revision is never executable.
- `discardPlanDraft` deletes the draft (for a never-saved epic it resets to the initial bundle).
- Revision ids are collision-resistant stable ids; `number` is display-only (max + 1 per epic).

### Plan validity (`src/core/plan/graph.ts`)

Errors (block Save): duplicate ids, empty titles, no sprints, non-contiguous sprint ordinals, a ticket in zero or several sprints, unknown ticket in a sprint, edges to unknown tickets, self-edges, duplicate edges, **a prerequisite in a later sprint**, cycles (reported as a path), bad relations, duplicate criterion ids, invalid policies. Warnings: isolated tickets, empty sprints, missing acceptance/success criteria, required ticket depending on an optional one.

An edge `{from: A, to: B}` means **B requires A's accepted result**. Relations (`related_to`, `duplicate_of`) are never execution edges. Layout is not stored; the desktop derives positions.

### Runs, readiness, and attempts

- One active run per epic (`queued|running|awaiting_checkpoint|paused`), enforced by a partial unique index.
- `queueRun` (desktop) creates a `queued` run pinned to the current saved revision; `startRun` (orchestrator) picks up the queued run or creates one, binds the epic branch (explicit input, else the current checkout branch + HEAD), sets the first sprint active, and moves the epic to `in_progress`.
- A run is pinned to `revision_id`. Saving a new revision never changes an active run; `adoptRevision` switches it only at a checkpoint (or while paused) with no open attempts. Accepted tickets whose content hash is unchanged keep their acceptance; changed tickets need explicit `carryForward` or new work (old attempts get `superseded_at`). A changed ticket in a sprint the run already passed can never be redone in that run, so adoption refuses it unless it is carried forward. The desktop's Saved view shows the revision an active run executes.
- Runs carry `owner_machine_id`. A run imported from another machine rejects execution commands with `run_not_owned` until `takeoverRun`, which marks its leased attempts `lease_expired` (uncertain, needs reconciliation) and pauses the run.
- **Readiness** is computed server-side for the active sprint: a ticket is `ready` when every prerequisite is accepted in this run (or carried forward), it has no open attempt, its last attempt does not need reconciliation, it is under the retry limit, and capacity (sprint cap, plan `maxConcurrency`) allows. Tickets of later sprints are `later_sprint`. Blockers explain why (`prerequisite`, `concurrency`, `retry_limit`, `lease_expired`, `run_state`). There is no global wave barrier inside a sprint.
- **Claim** (`claimTicket`) is transactional: re-computes readiness, creates an attempt (`claimed`) with `fencing_token` = previous claims + 1, a lease, and a secret; returns a claim token (`<attemptId>.<secret>`) and a bounded execution packet (pinned ticket content, acceptance criteria, predecessor outputs, constraints, reporting contract). The partial unique index on open attempts makes duplicate concurrent claims impossible.
- Heartbeat extends the lease (first heartbeat moves `claimed → running`). Late writes with a superseded or expired token fail with `stale_claim` / `expired_claim`.
- Leases expire lazily: commands that read or write execution state first mark overdue `claimed/running` attempts `lease_expired`. Lease expiry is uncertainty, not failure: the ticket needs `reconcileAttempt` (`abandon`, or `resubmit` with outputs) before another claim.
- `submitAttempt` (worker/orchestrator with the claim token) → `submitted`. Submission never unlocks dependents.
- `acceptAttempt` / `rejectAttempt` (orchestrator/reviewer/desktop) decide a submission. Acceptance completes the ticket and unlocks dependents; rejection leaves the ticket retryable.
- `failAttempt` → `failed`. When a ticket exhausts `retryLimit` (+ user-granted retries), the plan's `onTicketFailure` applies: `continue_independent` (default; dependents stay blocked), `pause_run`, or `fail_run` (terminal; open attempts canceled). A failed dependency is never treated as complete.
- `carryForwardTicket` records a `carry_forward` attempt (state `accepted`) for a ticket already `completed` by an earlier run, with an explicit note.
- `cancelRun` cancels open attempts; `pauseRun` stops new claims (open attempts may still report).

### Sprint checkpoints

- `submitSprintReport` stores report revision n+1 (content hash recorded) and moves a `running` run to `awaiting_checkpoint`; no new claims while awaiting a checkpoint.
- Gate conditions (`getCheckpoint`): report submitted for the active sprint · no open leases in the sprint · every required ticket accepted · every exit criterion reported met · (final sprint) epic outcome with all success criteria met · authorization.
- Authorization: sprint `checkpoint.mode = human` (default) needs a one-use **approval grant** issued by the desktop (`approveCheckpoint`), bound to project, epic, run, pinned revision, sprint, report id, report hash, and action. `advanceSprint` consumes the exact grant in the same transaction as the transition. A new report revision, an adopted revision, or a consumed grant invalidates it (forged/replayed/stale grants fail). `auto` mode only takes effect when the person enabled `authorizeAutoContinue` on that run; plan edits cannot relax this, and imported runs never carry the authorization.
- `approveAndAdvance` is the desktop's single-click path (issue + consume atomically).
- Advancing the final sprint completes the run and the epic (records the outcome). The final gate checks every required ticket of the plan, not only the final sprint's.
- Checkpoint reads and advances first expire overdue leases, so the gate never shows an expired claim as still holding a lease.
- `grantRetry` (desktop) allows one more attempt for a ticket in this run and returns an `awaiting_checkpoint` run to `running`.
- Idempotency keys make repeated advance calls return the original outcome.

### Comments

- Comments are append-only Markdown notes on an epic (`ticketId` null) or one of its tickets, written by people (desktop) and agents (MCP). There is no edit or delete (deletion stays deferred product-wide). Table `comments` (schema v3), ids with the `cm` prefix.
- `addComment({ epicId, ticketId?, body, idempotencyKey? })` needs capability `comment.write`, which every role holds; `listComments({ epicId, ticketId? })` needs `read` and returns comments oldest first (`created_at`, then id): without `ticketId` every comment of the epic, epic-level and ticket-level; with it only that ticket's.
- The author is the calling session's role and label (the label cut to 200 characters), never input. The body is Markdown, not blank, at most 20,000 characters (`commentBody`). A `ticketId` must be in the epic's current saved plan or its draft (else `not_found`). Completed epics refuse new comments with `completed_epic`; their comments stay readable. The branch guard applies, and an epic holds at most 10,000 comments (`capacity_exceeded`), the most a reconcile reads back.
- Each comment appends a `comment.added` event (payload: comment id and author) and a search document of type `comment` (title "Comment by <label>", body the Markdown), so `search_history` finds comments and labels them.
- Export: one immutable file per comment, `epics/<epicId>/comments/<commentId>.json` (format `darkmechanicus.comment` v1), so writers on different machines never touch the same file. A `comment` outbox entry (epic id, entity id = comment id) is queued in the same transaction; the finalizer writes the file with `writeFileSafely`. An existing file must hold the same comment (else `conflict`, never rewritten). Comment entries never block, or wait for, their epic's plan records. A checkout whose tree lacks the epic's `current.json` (a branch without the epic) gets no comment file, since a folder holding only `comments/` would be rejected by every reconcile: the entry fails with a retryable message and is exported once the epic's records are back (for example, after checking out the epic's branch); the epic's records are never written there for it. Like the epic itself, comments of a never-saved epic stay local: completing the epic's first save queues every comment without an export record, and the finalizer runs up to three passes so entries queued while flushing are written by the same flush.
- Import: for every epic whose own records are not rejected, the importer reads `comments/` as untrusted input: containment and link checks, regular files only, at most 256 KiB per file and 10,000 files per epic, names `<commentId>.json` built from validated ids (dot entries and other names such as temp files are ignored), the strict schema, and an id and epic matching the path. Each bad file is rejected on its own. New comments are inserted, indexed, and recorded in `sync_state` (kind `comment`); an id that already exists with different content is a conflict (reported with its epic, never overwritten) that clears once the file matches again. A comment waiting for export does not count as an unexported epic change.
- Desktop: the ticket panel's Comments tab lists a ticket's comments (author, role, time, body through the safe Markdown renderer) and, for open epics, adds one.

### Named capability profiles

- A named profile is a reusable, provider-neutral `CapabilityProfile` preset (for example `ui-implementation` or `deep-review`) that tickets start from. It names no vendor or model; an exact model stays the `preferences.modelOverride` preference, as on tickets.
- **Names** double as file names (`profiles/<name>.json`), so they are portable on Windows, macOS, and Linux: 1-64 lowercase letters, digits, and hyphens, starting and ending with a letter or digit, and never a Windows device name (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`). `src/core/profileNames.ts` holds the rule; the owned-path builder, the command schemas, and the record schema all apply it.
- **Commands:** `listProfiles` (sorted by name) and `getProfile` (`not_found` when missing) need `read`. `saveProfile` needs `profile.write` (desktop, planner, orchestrator), honours the branch guard and idempotency keys, and replaces the whole profile: it creates at revision 1 when `expectedRevision` is absent or 0 and replaces only at the current revision; anything else is `conflict`. The description has at most 500 characters (omitted means empty); the capability is complete and validated with the ticket schema, and its skills are normalized like a ticket's. Each save appends `profile.saved` and queues a `profile` outbox entry keyed by name (`outbox.entity_id`).
- **Revision** is the local database's optimistic-concurrency counter and is not tracked: a clone starts at 1 and every import bumps it.
- **Tickets copy profiles.** Applying one (the desktop editor's "Start from profile", or an agent passing a profile's `capability` to `create_ticket`/`update_ticket`) copies the requirements into the ticket; later profile saves never change existing tickets or saved revisions. The desktop writes only on Apply, and "Save as profile…" stores the requirements shown under a name. Apply writes only the requirement groups the person changed since the editor loaded the ticket (through a field or a profile; `context` per field); the others keep the draft's latest values, so it never reverts an agent's concurrent `update_ticket`.
- Deleting profiles is deferred like every other deletion.

## Repository-owned persistence

```text
.darkmechanicus/
  .gitignore                          # "local/" — the live database never enters Git
  project.json                        # project id, name, key prefix, format version
  epics/<epicId>/current.json         # saved-revision pointer + content hash + generation
  epics/<epicId>/state.json           # epic status, branch, outcome, ticket statuses (durable)
  epics/<epicId>/snapshots/<revId>.json  # complete immutable plan bundles
  epics/<epicId>/comments/<commentId>.json  # one immutable file per comment
  history/<runId>/run.json            # run, attempts, reports, checkpoints (no leases, tokens, or grants)
  profiles/<name>.json                # named capability profiles (darkmechanicus.profile records)
  local/                              # Git-ignored: state.sqlite(+wal/shm), machine.json
```

- Files are pretty, key-sorted JSON (`prettyJson`) for reviewable diffs; hashes use canonical JSON (`contentHash`).
- **Finalizer** (flush): processes `outbox` entries in id order under the database write lock. Snapshot files are written to a temp file, fsynced, renamed, read back and hash-checked; the pointer is replaced by atomic rename last. A previous snapshot is never rewritten in place. Interruption at any boundary leaves the last good pointer intact and the entry pending; a retry is idempotent. The filesystem is injected so tests can fail each write boundary.
- **Initialize** is explicit and repeatable: creates the layout, `project.json`, `.darkmechanicus/.gitignore`, and `local/machine.json`; never commits.
- **Reconcile / import** (open, clone, pull, branch change): every tracked file is untrusted — size limits, merge-marker rejection, zod schemas, stable-id checks, snapshot hash verification, full graph validation, and path containment. The whole import is staged and validated before one transactional swap; a failure leaves the last good state and drafts untouched. An epic whose tracked state changed while it also has unexported local changes is a **conflict** (surfaced, not overwritten). A branch change pauses active runs until reconciled. Unchanged records are not re-read on every heartbeat: an epic whose pointer and state match the last sync skips its snapshots, and each workspace remembers the stamp (size, modification and change times, inode; `FsAdapter.fileStamp`, which never follows a link) and hash of every comment and profile file it read, so a file keeping its stamp with a synced hash costs one `lstat` (`src/core/repo/fileHashes.ts`). A changed stamp, a link, or a hash that is not synced means a full read with every check.
- **Profiles** are exported by the finalizer like the other records (`writeFileSafely`, export hash in `sync_state` with `kind = 'profile'`; a failed write blocks later writes of that profile only) and imported by `src/core/repo/profileImport.ts` inside the same reconcile transaction. Dot entries are ignored; an entry that is not `<valid-name>.json`, a link, a junction resolving outside, a directory, an empty file, a file over 256 KiB, or a record that fails the strict schema or names another profile than its file is rejected and reported without stopping the rest; more than 1,000 entries rejects the directory unread. A `profiles` that is a link, resolves outside, or is not a directory is rejected and reported the same way and read as empty, so the rest of the reconcile goes on and opening the repository (which reconciles) never fails on it. A file whose hash matches the last export or import is unchanged; a changed one is imported (content and dates from the record) unless the local profile has an unexported save. That is a conflict, reported in `profileConflicts` (reconcile result and storage status): the local profile is kept and its next export wins, which clears it, as for epics.
- Owned file operations use app-generated relative paths from validated ids and verify the resolved real path stays inside `.darkmechanicus/` (symlinks/junctions included); failures are `unsafe_path`. Imported references are inert strings.
- Machine-local state (leases, claim secrets, approval grants, auto-continue authorizations, sessions, absolute paths) is never exported.

## MCP server (`src/mcp`)

`node out/main/mcp.js --repo <path> [--role orchestrator|planner|worker|reviewer] [--allow-save] [--label <name>]` (packaged: the app executable with `ELECTRON_RUN_AS_NODE=1`). Diagnostics go to stderr. Tool results are JSON (`{ ok: true, data }` or `{ ok: false, error: { code, message, details } }`) in both `content` text and `structuredContent`, with `isError` on failures; arguments that fail a tool's input schema are `invalid_input`. A session lists only the tools its role may call. Skills are exposed as MCP prompts.

## Desktop (`src/main`, `src/preload`, `src/renderer`)

- Tracked folders are a machine-local list in `userData/folders.json`, keyed by canonical real path (tracking an existing path selects it instead of duplicating). Stop tracking removes only that entry.
- The main process caches one Workspace (desktop session) per folder. IPC channels `dm:*` validate payloads and call `CommandApi`, and only after the sender check below. The renderer polls `listEvents` with a cursor (bounded interval) and refetches what changed; unsaved form edits survive refreshes and conflicts.
- Markdown is rendered by a small safe renderer (no raw HTML); links are allow-listed (`http`, `https`, `mailto`) and opened through the main process. Navigation and new windows are denied.

## Bridge hardening

Defense in depth on both adapters; the command layer's authorization stays the real boundary.

- **IPC sender check** (`src/main/ipcGuard.ts`). `index.ts` wraps `ipcMain` once with `guardIpc` and passes the result to every registrar (`dm:*`, auto-update, app version); nothing else touches `ipcMain`, and a test scans `src/main` to keep it that way. A call runs only when `event.senderFrame` is live, attached, top-level, and shows the app's own page: `isAppUrl` (shared with the navigation guard) compares the dev server's origin in development, and in production the packaged `index.html` by parsed protocol, host, and resolved path (query and hash ignored, never a prefix). Anything else gets `{ ok: false, error: { code: 'unauthorized' } }`, the handler never runs, and main logs the refusal.
- **Tools per role** (`src/mcp/tools/define.ts`). Each tool adapts one command (its camel-cased name, or an explicit `command` the compiler requires otherwise). `createMcpServer` grants the server the session's capabilities (`capabilitiesForRole(role, { allowSave })`), and `registerTools` registers a tool only when that set holds `COMMAND_CAPABILITIES[command]`. Read-only tools need `read`, which every role has; `save_plan` needs `plan.save`, which only `--allow-save` adds for planner and orchestrator. A withheld tool is still known to the server: calling it answers `unauthorized` without running anything.
- **Structured validation errors.** The SDK validates tool arguments before the tool callback and answers failures as plain text. The server replaces the SDK's `tools/call` handler with one that parses each tool's zod shape itself and answers failures with `invalid_input` (`details.issues`: path and message per field). `tools/list` stays the SDK's, so advertised JSON schemas are unchanged; a test pins each one to its fingerprint from before the change.

## Verification tooling

- `npm run smoke:mcp` launches the built `out/main/mcp.js` over real stdio (set `MCP_SMOKE_COMMAND` to Electron's binary to use its runtime) and plans, saves, and runs a ticket end to end.
- `npm run spike:claims` races claims on one ticket from 8 processes (exactly one winner per round).
- `src/integration/` exercises the real Workspace through the command table, MCP tools (in-memory transport), and desktop IPC handlers.
- Fireguard scopes mutants to the graded tests that import the mutated module and bounds each test run with `testTimeoutMs`, so milestone-sized branches grade in hours, not days, and an infinite-loop mutant counts as killed.

## Decisions taken during implementation

The product plan's open decisions were settled as follows (all revisitable):

- **Git tracks portable records**, not SQLite snapshots: JSON records under `.darkmechanicus/` plus a Git-ignored working database, rebuilt on clone.
- **First host:** any stdio MCP host; a Claude Code skill wrapper ships (`installSkills`) and the six skills are also plain MCP prompts, so no host-specific API is assumed.
- **Sprint advancement defaults to a human checkpoint** (`checkpoint.mode = human`); `auto` needs per-run authorization in the desktop.
- **Deletion stays deferred**, as the plan requires: no delete UI or tools ship (mockup 06 is not implemented).
- **Named profiles are records like the others:** `format: darkmechanicus.profile`, `formatVersion: 1`, strict schema, key-sorted pretty JSON, imported on reconcile; tickets copy them rather than reference them, so a profile edit never rewrites plans.

## Testing conventions

- TDD with Vitest. Core tests use `createTestCtx()` (`src/test/testContext.ts`): in-memory migrated DB, fixed clock, sequential ids. Repository tests use temp directories. Renderer component tests use `// @vitest-environment jsdom` + Testing Library.
- Fireguard grades changed tests: keep mocks rare (fakes over `vi.fn`), assert on outputs/state rather than `toHaveBeenCalled*`, no empty tests, deterministic (100 isolated runs), and kill ≥ 75 % of mutants in changed modules (operators `+ - * / < > <= >= === !==`, `if` inversion, boolean/number returns).
