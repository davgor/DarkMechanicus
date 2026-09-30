# Dark Mechanicus — initial product and architecture plan

Status: proposal for discussion, 2026-09-29. This document plans the product; it does not implement it.

## Product definition

Dark Mechanicus is a local planning and execution coordination system for agentic development, with an MCP interface for agents and an Electron interface for people on Windows and macOS. Both interfaces operate on the same persisted state and enforce the same rules.

An agent helps the user formulate an epic, decomposes it into tickets, creates dependencies and sprint boundaries, and writes the plan through MCP. The user reviews and edits that plan in the desktop app. An orchestrator retrieves a specific plan revision, selects suitable subagents in its own host environment, executes the available work, and records results. Each sprint ends with an outcome report and a checkpoint before the next sprint.

The supplied sketch establishes the intended hierarchy and branching execution shape. Epic-to-ticket containment is distinct from ticket-to-ticket dependency. Vertical placement alone does not define a dependency.

## Proposed first-version scope

- Local, single-user application; multiple agent sessions and the desktop may access it concurrently.
- Each repository owns its database, plans, tickets, and execution history. The desktop's optional project registry only remembers which repositories to open.
- Confirmed: the existing agent app runs the orchestrator and its own subagents. Dark Mechanicus stores plans and execution order, and supplies data to help the app execute them.
- One host/provider environment per run; no cross-provider agent dispatch in the first version.
- Headless MCP operation must work with the desktop closed.
- No cloud synchronization, team permissions, agent billing, or built-in model inference in the first version.

## Domain model

### Project

The boundary for a repository and its planning state. Fields: stable ID, name, repository reference, local workspace mappings, timestamps. Local paths belong to machine-specific mappings so exported plans do not depend on one user's drive layout.

### Epic

A desired outcome spanning tickets and sprints. Fields: project ID, title, Markdown intent, success criteria, status, owner role, active plan reference. The orchestrator maintains decomposition and progress; the user can revise it. Completion requires the epic's success criteria, not merely a count of closed tickets.

### Ticket

An individual work item with stable identity. Fields: epic ID, title, unrestricted Markdown body, structured acceptance criteria, lifecycle status, tags, priority, capability requirements, attachments/references, revision, timestamps. Keep narrative flexible; do not force every paragraph into a schema. Structured acceptance criteria give execution and review a stable contract.

Ticket content describes what to do. Scheduling and blocking dependencies belong to the plan. Nonblocking relationships such as related-to or duplicate-of are stored separately and never interpreted as execution edges.

### Plan and plan revision

A plan is the execution definition for an epic. A revision contains ticket-version references, sprint membership and order, dependency edges, gate policies, concurrency limits, and planning rationale. It is more than a Markdown narrative.

Use a stable plan ID with immutable published revisions. Draft revisions remain editable. Starting a run pins the published revision and its ticket content. Publishing a new revision does not change an active run. Initially, adopting a new revision requires stopping at a checkpoint and explicitly starting a replacement run; completed work may be carried forward only after its evidence is revalidated against the new revision.

For the first version, a ticket appears once in a plan revision and belongs to one sprint in that revision. One active run per epic prevents conflicting execution against alternate plans. Store graph layout separately from semantic edges.

### Sprint

An ordered body of work inside an epic's plan revision. Fields: stable logical ID, goal, ordinal, ticket membership, entry criteria, exit criteria, concurrency cap, checkpoint policy. A sprint is an execution phase, not necessarily a calendar timebox.

Default checkpoint policy: the orchestrator finishes required ticket acceptance, validates integration, writes the sprint report, then waits for the user to advance. Automatic continuation can be explicitly enabled later or per plan. The final sprint closes the run only after epic-level checks pass.

### Execution run and ticket attempt

A run records the execution of one pinned plan revision: orchestrator session, host environment, state, active sprint, timestamps, and checkpoints. Ticket attempts record claim/lease, worker identity, selected model, rationale, input version, outputs, verification evidence, and failure details. Retries create new attempts rather than overwriting previous outcomes.

Run state: queued → running → awaiting_checkpoint → running → completed; also paused, failed, canceled. Ticket attempt state: claimed → running → submitted → accepted or rejected; also failed, canceled, or lease_expired. Ticket lifecycle status is distinct from attempt state. Readiness is derived from dependencies, gates, and claims, not manually assigned.

### Supporting records

Model profiles, host capability catalogs, worker registrations, Markdown comments, artifact references, acceptance evidence, sprint reports, and append-only audit events. Use relational columns for integrity and querying; versioned JSON for extensible metadata. Keep artifact files outside the database, referenced by ID, location, and optional hash. Do not store provider credentials in tickets or export files.

## Dependency and execution rules

1. An edge A → B means B requires A's accepted result. B waits for every incoming prerequisite, including joins between parallel branches.
2. Validate the entire plan as a directed acyclic graph. Reject cycles, missing references, self-edges, and dependencies on a later sprint. Earlier-sprint prerequisites must have accepted evidence in this run or explicitly revalidated carry-forward evidence.
3. Within a sprint, dispatch any ready ticket, subject to concurrency and workspace constraints. Do not introduce a global wave barrier: B can start after A is accepted while an unrelated long task continues.
4. Scheduling readiness is computed by the server. The orchestrator chooses among eligible tickets; it cannot bypass unmet dependencies by changing a status field.
5. Claiming is transactional. A claim has an owner, expiry, heartbeat, and fencing token. Reject late writes from a superseded claim. Start with one orchestrator per run and ticket-scoped worker access.
6. Lease expiry makes execution uncertain. Require reconciliation before retrying externally visible actions; a lost connection does not prove that work stopped. Persist idempotency keys for mutations, but do not promise exactly-once filesystem or Git effects.
7. Failure blocks dependent tickets. Independent branches may continue under the sprint policy. Retry limits, stop-on-failure, and escalation are explicit plan settings. A failed dependency is never silently treated as complete.
8. Separate worker submission from acceptance. The orchestrator or designated reviewer verifies the criteria and evidence. A worker's self-reported completion does not unlock downstream work automatically.
9. The sprint checkpoint includes accepted work, failed or blocked work, changed files/commits, checks and their results, unresolved risks, and proposed follow-up tickets. The server validates required state before allowing advancement.
10. Workspace collision prevention is part of scheduling: use isolated workspaces when supported, otherwise serialize conflicting changes with explicit resource locks. The external host owns checkout creation, execution, and integration. A result needed by another ticket must identify an accessible artifact or integrated revision.

## Model-agnostic task requirements

Store a task capability profile separately from a concrete model selection. Do not bake vendor names or current model rankings into the ticket schema.

Suggested requirements:

- Work type: implementation, architecture, investigation, testing, review, documentation.
- Reasoning demand: routine, multi-step, deep; include a short rationale.
- Relevant skills: typed tags such as TypeScript, Electron, database design, UI, security review.
- Required modalities and tools: text, images, repository read/write, shell, browser, test execution.
- Context needs: estimated input size and required artifacts; label estimates as estimates.
- Constraints: permitted environment/data location, time or cost ceiling if configured.
- Preferences: quality, latency, cost, autonomy, and optional exact-model override.

Distinguish hard constraints from preferences. The host supplies the models and agent tools actually available in the current session. The orchestrator filters out candidates that fail hard constraints, selects among the remainder, and records the model ID, host ID, catalog revision, and rationale on the attempt. Unknown required capabilities trigger clarification or escalation; they do not silently pass.

Model and host are separate concepts. Shell access, subagent spawning, and permission controls belong to the host/runtime; reasoning and context capabilities belong to the model. A host that cannot select worker models may use its fixed model only if the requirements are satisfied. There is no assumed universal API for changing models across vendors.

## Architecture

Proposed first version:

    External agent host → stdio MCP process ─┐
                                           ├→ shared domain service → SQLite
    Electron renderer → preload → main ────┘

The domain service is reusable code, not a network service in this initial architecture. Each local process calls the same command/query layer and opens the same configured database. No renderer database access and no duplicated business rules in MCP handlers.

Use SQLite with foreign keys, WAL, short transactions, busy timeout and bounded retries. Concurrent readers are supported; writes serialize. Atomic claims, optimistic revisions, and transactional state changes are still necessary. Store the database under the repository's `.darkmechanicus/local/` directory on local disk; do not put a live WAL database on a network share or sync folder. Back up through a supported database snapshot mechanism rather than copying only the main file during writes.

Use database schema versions and a migration lock. Clients must refuse incompatible schemas rather than attempting competing migrations. The desktop discovers changes through a monotonically increasing event cursor with bounded polling in the first version; it refreshes affected records and retains unsaved edits on conflicts.

The MCP entry point is independently packaged and can be launched by an agent host without a running Electron window. Both entry points resolve the same repository root and project identifiers. Validate this on Windows and macOS; do not assume the Node/Electron database binary is interchangeable. Choose the SQLite driver through a packaging spike before committing to a dependency.

Start with stdio for local agent integration and stderr diagnostics. Pin a supported MCP protocol/SDK version and validate against target hosts. A future local daemon with Streamable HTTP can centralize connections if needed; it is not required for the first version.

## Repository-owned persistence and historical memory

Confirmed requirement: install the database into each repository so planning state travels between computers and completed plans remain useful historical information. Proposed implementation: a local SQLite working database plus portable, Git-tracked Markdown/JSON records. The live database binary is ignored by Git; the portable records reconstruct its durable planning state. This storage format is a recommendation, not yet a confirmed user choice.

Proposed layout:

```text
.darkmechanicus/
  project.json                 # stable project ID and portable schema version
  tickets/<id>.md              # Markdown content and structured frontmatter
  epics/<id>.json              # outcomes and epic metadata
  plans/<id>/draft.json        # editable draft graph and sprint definitions
  plans/<id>/revisions/*.json  # immutable published execution definitions
  history/<run-id>/            # durable attempts, results, reports, provenance
  profiles/                   # provider-neutral capability requirements
  local/                      # Git-ignored runtime state
    state.sqlite
    machine.json
```

Portable state includes ticket content, versions, plan graphs, model requirements, durable run progress, accepted outputs, decisions, and sprint reports. Machine state includes absolute paths, credentials, worker process IDs, leases, heartbeats, and temporary logs. Historical records may include the selected model identity and host type, but never credentials or live ownership tokens.

SQLite serves runtime queries and transactions. Each durable mutation also creates a transactional export-outbox entry. A serialized exporter writes a complete generation of portable records using temporary files and atomic replacements, publishing a manifest with hashes last. A mutation response distinguishes committed database state from completed portable persistence; export failure is visible and retryable. The app exposes a flush/check command before committing planning state. Readers reject incomplete manifests and never import a partly written generation. This protocol needs implementation tests; a SQLite transaction alone cannot atomically commit filesystem changes.

On clone or first open, validate portable records and reconstruct the local database. On pull or branch change, compare the tracked generation against the last imported/exported generation. Stop scheduling during reconciliation; do not overwrite unexported local changes. Surface conflicts for resolution and revalidate the graph before enabling execution. Two computers editing the same draft is a merge scenario, not automatic last-writer-wins synchronization. Immutable revisions use collision-resistant IDs rather than machine-local counters.

State moves between computers through the repository's normal commit, push, and pull workflow. Merely placing a database in a folder does not synchronize it. Dark Mechanicus should show whether state is locally saved, exported, or committed; automatic Git commits/pushes are outside the initial scope.

An imported in-progress run is historical/recoverable state, never proof that a worker is still active. Resuming on another computer requires explicit takeover, artifact availability checks, and reconciliation. Local leases cannot prevent simultaneous execution on disconnected computers; v1 assumes one executing computer per epic and does not claim distributed locking.

For worktrees, the orchestrator's designated repository workspace owns run state; workers report through its MCP endpoint rather than independently writing planning records in every worktree. Separate clones remain independent until synchronized. Branch changes in the coordinating workspace require a paused run and completed export/reconciliation.

Completion preserves the pinned plan, ticket versions, outcomes, acceptance evidence, selected model metadata, sprint summaries, and relevant code commit references. Keep these records queryable through MCP, including keyword search by outcome, ticket, or affected area. Historical records are read-only; later corrections append an amendment. Explicit plan deletion is the exception to retention and removes the associated history from current application storage. Store compact evidence and relative artifact references; remote-only artifacts must be labeled because they may not remain available offline.

If tracking the SQLite binary itself is required, use an explicit closed/checkpointed snapshot workflow and a single-writer policy. That alternative sacrifices readable diffs and practical merges; the portable-record approach is recommended for normal branch-based development.

## Proposed MCP contract

Keep tool names explicit and publish schemas with structured errors and versioned results. Names below are proposals.

- Discovery: `get_capabilities`, `list_projects`, `get_project`.
- Authoring: `create_epic`, `get_epic`, `list_tickets`, `create_ticket`, `get_ticket`, `update_ticket`.
- Planning: `get_plan`, `save_plan_draft`, `validate_plan`, `publish_plan`. A draft bundle can contain client-local ticket references, sprint definitions, and edges; saving the bundle is transactional and returns stable IDs. This avoids half-imported plans.
- Execution: `start_run`, `get_run`, `get_ready_tickets`, `claim_ticket`, `heartbeat_attempt`, `submit_attempt`, `accept_attempt`, `fail_attempt`, `pause_run`, `resume_run`, `cancel_run`.
- Checkpoints and recovery: `get_run_events`, `get_sprint_report`, `submit_sprint_report`, `advance_sprint`, `reconcile_attempt`.
- Repository lifecycle and memory: `initialize_repository`, `get_storage_status`, `flush_portable_state`, `reconcile_repository`, `search_history`. Initialization is explicit and repeatable; it creates repository metadata and ignores local database/WAL files without committing anything.
- Plan removal: `preview_plan_deletion`, `delete_plan`. Preview identifies owned records, shared references, and active attempts. Deletion uses the expected revision and rejects unresolved active execution; it removes owned data from SQLite and portable storage through the export protocol.

Mutations use expected entity revision and request/idempotency key. Execution writes additionally identify the run and claim token. Errors distinguish conflict, invalid graph, unmet prerequisite, unauthorized transition, expired claim, and unsupported host capability. Workers receive narrowly scoped assignments; if the host cannot isolate MCP credentials per worker, workers return results to the orchestrator, which writes through MCP. A claimed actor name is not authorization.

`get_ready_tickets` returns dependency outcomes and blockers. `claim_ticket` returns a bounded execution packet: pinned ticket content, acceptance criteria, relevant predecessor outputs, selected constraints, expected artifacts, and reporting contract. Tools retrieve large supporting documents separately to avoid forcing an entire epic into every worker context.

MCP exposes state and commands. The agent host implements spawning and model selection. Calling an MCP tool alone does not create a subagent or guarantee continued autonomous execution.

## Agent skills to ship

Maintain provider-neutral Markdown instructions and host-specific installation wrappers where necessary. Skills describe behavior; server-side rules enforce state integrity.

- **Planner:** clarify the outcome, create epics and tickets, define verifiable acceptance criteria, assign capability profiles, and save a coherent draft.
- **Graph planner:** add prerequisites, detect missing integration tasks, explain parallel branches and joins, and place sprint checkpoints. Validate before publishing.
- **Orchestrator:** read the pinned plan, register available host capabilities, select workers, claim ready tickets, schedule work, handle failures, and preserve resumable state.
- **Worker:** act on one execution packet, stay within scope, return artifacts and test evidence, and report blockers without mutating the plan.
- **Reviewer:** independently compare submitted results with acceptance criteria; return acceptance or actionable rejection.
- **Sprint reporter:** summarize outcomes, unresolved decisions, and proposed replanning; advance only under the configured gate policy.

Ticket prose and retrieved documents are task data. They do not override installed skill rules, host permissions, or transition validation. Record skill version on runs for reproducibility.

## Desktop experience

Confirmed navigation: a left sidebar lists tracked repository folders. A plus button opens the native folder picker to track another folder. Selecting an existing Dark Mechanicus folder opens its stored plans; a new folder is initialized with repository-local storage. Tracking an already registered canonical path selects it rather than adding a duplicate. The tracked-folder list is a machine-local preference; the plans belong to the folders.

Each folder expands to exactly three plan buckets, in this order: **In progress**, **Backlog**, **Completed**. Each bucket contains plans, not individual tickets. Buckets and folders can collapse, show counts, and retain their expanded state. A plan has a stable display name and ID; epics remain its outcome context rather than a required extra sidebar level.

Proposed bucket rules: unstarted plans are Backlog; started plans remain In progress while running, paused, blocked, failed, or awaiting a checkpoint; plans that meet completion criteria are Completed. Display the detailed run state on the plan row. Canceling a run does not imply completing its plan. An explicit return-to-backlog action is allowed once execution is stopped. Editing a completed plan creates a draft revision without erasing its completed run history.

Clicking a plan opens its ticket dependency graph in the main workspace and highlights its sidebar row. The header shows folder, plan title, bucket, revision, and plan actions. Clicking a ticket opens a detail panel containing Markdown, acceptance criteria, model requirements, dependencies, and execution evidence. A run/checkpoint panel shows execution state and the current report. The graph is the primary plan view; a list is optional supporting navigation.

Show sprints as labeled graph regions. Display containment separately from blocking edges. Users can add dependencies, move tickets between draft sprint regions, and edit Markdown plus structured metadata. Every invalid edit returns a concrete reason; moving a node visually never changes execution order by itself.

Separate editing a draft from inspecting a run pinned to an older revision. Show revision differences and explain why a ticket is blocked. Include graph/list views, Markdown preview, capability profile controls, plan validation, revision history, run attempts, and MCP setup/status. Publishing and starting are distinct user actions.

### Permanent plan deletion

Confirmed: a user can fully delete a plan from any bucket, including Completed. Provide **Delete plan…** in the plan's row menu and header menu. A confirmation identifies the plan and the owned records that will be removed; this is permanent application deletion, not a move to Completed or an archive.

Deletion removes the plan, drafts and revisions, sprint definitions, dependency/layout records, runs, attempts, reports, and exclusively owned tickets/artifacts from the current database and portable files. Existing tickets are epic-owned in the domain model, so deletion must compute references: keep tickets used by another plan, and explicitly include otherwise unreferenced tickets in the deletion preview. Never delete repository source code, Git commits, or externally stored artifacts merely because a ticket references them. Keep other plans and the tracked folder intact.

For active work, stop dispatch and require the orchestrator to cancel/reconcile workers before deleting; removing a database record cannot stop an external process. Once execution is resolved, invalidate remaining claims and apply deletion transactionally with a durable export-outbox entry. Prevent reads/late writes from resurrecting deleted records. Complete portable deletion before reporting that repository persistence is up to date, and remove deleted items from search indexes and the selected view.

Git commits and external backups may retain older copies. Delete removes current app/repository state; it does not rewrite Git history. Pulling stale branches must surface a deletion-versus-edit conflict rather than silently reimport the old plan. A minimal deletion marker containing only the entity ID and generation may be retained for synchronization; it contains no plan content or execution history.

Removing a folder from the sidebar is a separate **Stop tracking folder** action. It only removes the local registry entry and does not delete any repository data.

## Delivery sequence and acceptance gates

These are proposed implementation milestones for building Dark Mechanicus, distinct from sprints stored by the product. The external execution-host boundary is confirmed; details below remain planning proposals.

1. **Persistence and packaging spike.** Choose the driver; prove the desktop and headless MCP process can access one repository-local migrated database on both platforms, claim concurrently without duplicates, and recover after interruption. Prototype portable generation export and reconstruction, including interrupted export and schema mismatch.
2. **Planning vertical slice.** Agent creates an epic, Markdown tickets, and a draft plan through MCP; desktop displays and edits the same records; stale updates surface conflicts; restart retains content. Include the folder picker, three sidebar buckets per folder, plan selection opening its ticket graph, safe permanent plan deletion, transactional bundle import, repository initialization, basic planner instructions, and clone-to-another-directory reconstruction from tracked records. Verify deletion survives reopening/reconstruction and preserves other plans and source files.
3. **Graph and revisions.** Add sprints, dependency editing, validation, capability profiles, and immutable publication. Demonstrate a fork and join, cycle rejection, rejection of a later-sprint prerequisite, and preservation of a run's pinned inputs.
4. **Execution coordination.** Add runs, claims, readiness, worker result submission, acceptance, failure/retry, host capability matching, and orchestrator/worker/reviewer skills. Demonstrate parallel independent work, blocked dependents, a join, competing claims, and stale-worker rejection in one supported host first.
5. **Sprint checkpoints and recovery.** Add reports, advancement, pause/cancel, crash reconciliation, revision adoption at checkpoints, searchable historical memory, and backup/export. Demonstrate a failed gate blocking the next sprint, explicit takeover after importing an interrupted run, conflict detection after branch changes, and historical evidence surviving reconstruction.
6. **Cross-host validation and release.** Run the same planning/execution contract in another host without changing stored task requirements. Verify Windows/macOS packaging, headless startup, data-directory discovery, migrations, and desktop updates.

The first usable product is milestone 2. The core promise in the sketch is met at milestone 5. Initial implementation tickets should follow repository TDD, board tracking, and delivery checks.

## Decisions still open

- Should Git track portable Markdown/JSON records or explicit SQLite snapshots? Proposed default: portable records plus a repository-local working database.
- Which host should be the first end-to-end integration target?
- Should sprint advancement default to a human checkpoint? Proposed default: yes, configurable per plan.
- What counts as accepted code: validated workspace changes, a commit, or a merged PR? Proposed default: evidence plus an accessible integrated revision, configurable to the user's workflow.
- Are parallel workers expected to share a checkout or use isolated workspaces? Proposed default: isolation when the host supports it; otherwise serialize conflicting work.

## Evidence and technical references

Repository inspection: `README.md`, `package.json`, `src/renderer/src/App.tsx`, `src/main/mcp/README.md`, and `src/main/tickets/README.md`. The Electron shell, MCP SDK, Zod, and React Flow are present; application ticket storage and the MCP server are placeholders. The development `/board` is separate from future application data.

SQLite WAL behavior: https://www.sqlite.org/wal.html

MCP transport reference (versioned specification; implementation must pin its selected supported version): https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
