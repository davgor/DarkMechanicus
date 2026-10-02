# Dark Mechanicus — initial product and architecture plan

Status: working specification, updated with user decisions on 2026-09-29. Confirmed product decisions are distinguished from proposed implementation details. This document does not implement the product.

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

A desired outcome spanning tickets and sprints. Fields: project ID, title, Markdown intent, success criteria, status, owner role, plan reference, and feature branch. Exactly three statuses: `backlog`, `in_progress`, `completed`. The orchestrator maintains decomposition and progress; the user can revise unfinished epics. Completion requires the epic's success criteria, not merely a count of closed tickets. Completed epics are closed permanently: no reopen, editing, or transition back to another status. Follow-up work creates a new epic and plan with fresh IDs and optional provenance links to the original.

### Ticket

An individual work item with stable identity. Fields: epic ID, title, unrestricted Markdown body, structured acceptance criteria, lifecycle status, tags, priority, capability requirements, attachments/references, revision, timestamps. Keep narrative flexible; do not force every paragraph into a schema. Structured acceptance criteria give execution and review a stable contract.

Tickets also have exactly three statuses: `backlog`, `in_progress`, `completed`. Blocked, failed, paused, and awaiting review describe execution conditions, not additional ticket or epic statuses. Attempts preserve those operational details. Completion inside an unfinished epic is recorded by the orchestrator's acceptance command; starting work moves the ticket and epic to In progress. Completing an epic requires all required tickets to be Completed and the orchestrator's outcome report. Tickets belonging to a completed epic are read-only.

Ticket content describes what to do. Scheduling and blocking dependencies belong to the plan. Nonblocking relationships such as related-to or duplicate-of are stored separately and never interpreted as execution edges.

### Plan and plan revision

A plan is the execution definition for an epic. A revision contains ticket-version references, sprint membership and order, dependency edges, gate policies, concurrency limits, and planning rationale. It is more than a Markdown narrative.

Confirmed editing contract: creating or editing a plan produces a draft. The saved plan stays unchanged until the user presses **Save**, or an explicitly authorized MCP `save_plan` call performs the equivalent action. Save validates the whole draft and replaces the current saved plan; there is no separate Publish step. Discard restores the last saved plan. Optional local draft recovery does not publish or execute unfinished changes.

Proposed implementation: each save creates a complete immutable internal snapshot and advances the current saved revision pointer. This preserves the user's overwrite behavior while retaining the exact inputs referenced by runs. Save compares the draft's base revision and rejects stale overwrites. It is idempotent and all-or-nothing from the consumer's perspective. Draft is an editing state, not a fourth epic/ticket status.

Running agents continue to use their pinned saved snapshot. Saving an edited plan does not silently rewrite active assignments. The orchestrator can adopt the new saved version at a checkpoint with no active attempts, explicitly reconciling completed work; execution reads carry the run/revision so they cannot accidentally return the latest editor version. Completed epics cannot create new drafts or save changes.

For the first version, a ticket appears once in a plan revision and belongs to one sprint in that revision. One active run per epic prevents conflicting execution against alternate plans. Store graph layout separately from semantic edges.

### Sprint

An ordered body of work inside an epic's plan revision. Fields: stable logical ID, goal, ordinal, ticket membership, entry criteria, exit criteria, concurrency cap, checkpoint policy. A sprint is an execution phase, not necessarily a calendar timebox.

Default checkpoint policy: the orchestrator finishes required ticket acceptance, performs the checks it considers necessary, writes the sprint report, then waits for the user to advance. Automatic continuation may be explicitly authorized in the saved policy. The final sprint closes the run only after the orchestrator records epic-level completion. Dark Mechanicus enforces the state and authorization contract, not code correctness.

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
10. The orchestrator owns workspace management, merge ordering, tests, and execution correctness. Cloud workers merge their changes into the epic's feature branch under its coordination. When integration needs explicit work, the orchestrator creates a subsequent integration ticket and links its prerequisites. Dark Mechanicus stores dependencies, branch/commit references, evidence, and reported outcomes; it does not implement an integration engine or certify the code.

## Epic feature branches

Confirmed: each epic has its own feature branch. Store its repository identity, branch name, and starting commit. Cloud spin-ups and isolated workers target that branch for integration, not the default branch. The orchestrator coordinates merges, resolves conflicts, and records outcomes; a dedicated integration ticket represents substantial integration work. Merging the epic into the default branch is a separate repository workflow, not an automatic consequence of changing its status.

Use a dedicated coordinating checkout/worktree for the epic where practical. Worker code branches may differ, but their assignments identify the epic target branch. Dark Mechanicus must verify the coordinating repository and branch before saving/exporting or dispatching work; an unexpected branch change pauses those operations and preserves drafts for reconciliation. Per-epic branches reduce normal branch switching but do not make filesystem/database writes atomic with external Git commands.

The folder sidebar must still show epics across branches. Proposed implementation: retain a local index of known epic snapshots and inspect tracked snapshots on locally available branch refs without switching the working checkout. Bind each editable epic to its owning checkout. After a clone, discovery is limited to fetched refs; show that scope rather than claiming unseen remote epics are absent. Never rebuild the entire project database solely from whichever branch happens to be checked out.

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
  epics/<id>/current.json      # saved snapshot pointer and epic branch identity
  epics/<id>/snapshots/*.json  # complete immutable bundles, including Markdown bodies
  history/<run-id>/            # durable attempts, results, reports, provenance
  profiles/                   # provider-neutral capability requirements
  local/                      # Git-ignored runtime state
    state.sqlite
    machine.json
    drafts/                   # optional unsaved draft recovery, never executable
```

Portable state includes ticket content, versions, plan graphs, model requirements, durable run progress, accepted outputs, decisions, and sprint reports. Machine state includes absolute paths, credentials, worker process IDs, leases, heartbeats, and temporary logs. Historical records may include the selected model identity and host type, but never credentials or live ownership tokens.

Draft edits stay local until Save. Proposed portable format: a complete versioned JSON bundle per epic containing Markdown ticket bodies, graph, metadata, and the records required to reconstruct that saved state. Keep the prior bundle intact; write and validate the new bundle before atomically replacing its current pointer. Do not replace the constituent files of the previous good snapshot in place. Run history referenced by a bundle must already be durably present and immutable. Status/evidence updates use the same durable commit machinery without publishing pending editorial drafts.

SQLite handles local working state and transactional requests. A Save request records a pending snapshot and outbox entry; a cross-process serialized finalizer persists the complete bundle and pointer, then marks it current locally. Recovery reconciles interruption between these steps using request IDs and content hashes. Execution cannot consume a pending revision. The UI reports Saved only when the new saved version is recoverable from repository records; otherwise it shows Save pending/failed and retains the draft. Git commit/push remains separate. Fault-injection testing is required before relying on this proposed protocol; explicit Save alone does not resolve crash consistency.

On clone or first open, validate portable records and reconstruct the local database. On pull or branch change, compare the tracked generation against the last imported/exported generation. Stop scheduling during reconciliation; do not overwrite unexported local changes. Surface conflicts for resolution and revalidate the graph before enabling execution. Two computers editing the same draft is a merge scenario, not automatic last-writer-wins synchronization. Immutable revisions use collision-resistant IDs rather than machine-local counters.

State moves between computers through the repository's normal commit, push, and pull workflow. Merely placing a database in a folder does not synchronize it. Dark Mechanicus should show whether state is locally saved, exported, or committed; automatic Git commits/pushes are outside the initial scope.

An imported in-progress run is historical/recoverable state, never proof that a worker is still active. Resuming on another computer requires explicit takeover, artifact availability checks, and reconciliation. Local leases cannot prevent simultaneous execution on disconnected computers; v1 assumes one executing computer per epic and does not claim distributed locking.

For worktrees, the orchestrator's designated repository workspace owns run state; workers report through its MCP endpoint rather than independently writing planning records in every worktree. Separate clones remain independent until synchronized. Branch changes in the coordinating workspace require a paused run and completed export/reconciliation.

Completion preserves the pinned plan, ticket versions, outcomes, acceptance evidence, selected model metadata, sprint summaries, and relevant code commit references. Keep these records queryable through MCP, including keyword search by outcome, ticket, or affected area. Completed epics and their records are read-only. An agent may read an old epic to create fresh work, but must create new IDs, a new plan, and a new epic branch; do not copy completion states, approvals, claims, or old run ownership into the new work. Store compact evidence and relative artifact references; remote-only artifacts must be labeled because they may not remain available offline.

If tracking the SQLite binary itself is required, use an explicit closed/checkpointed snapshot workflow and a single-writer policy. That alternative sacrifices readable diffs and practical merges; the portable-record approach is recommended for normal branch-based development.

## Proposed MCP contract

Keep tool names explicit and publish schemas with structured errors and versioned results. Names below are proposals.

- Discovery: `get_capabilities`, `list_projects`, `get_project`.
- Authoring: `create_epic`, `get_epic`, `list_tickets`, `create_ticket`, `get_ticket`, `update_ticket`. Editorial changes target a draft; execution status commands operate on the current saved entities. All reject mutations to completed epics.
- Planning: `get_plan`, `update_plan_draft`, `validate_plan`, `save_plan`, `discard_plan_draft`. Draft bundles can contain client-local ticket references, sprints, and edges. Save returns stable IDs and the saved revision, or a clear pending/failure/conflict result. Saved and draft reads are explicit; agents cannot execute draft-only tickets.
- Execution: `start_run`, `get_run`, `get_ready_tickets`, `claim_ticket`, `heartbeat_attempt`, `submit_attempt`, `accept_attempt`, `fail_attempt`, `pause_run`, `resume_run`, `cancel_run`.
- Checkpoints and recovery: `get_run_events`, `get_sprint_report`, `submit_sprint_report`, `advance_sprint`, `reconcile_attempt`.
- Repository lifecycle and memory: `initialize_repository`, `get_storage_status`, `flush_portable_state`, `reconcile_repository`, `search_history`. Initialization is explicit and repeatable; it creates repository metadata and ignores local database/WAL files without committing anything.
- Status: `set_ticket_status`, `set_epic_status`, using only Backlog, In progress, Completed. Completed-epic transitions are rejected. Completion follows the same acceptance and checkpoint rules as other command paths; these tools cannot bypass them.

Mutations use expected entity revision and request/idempotency key. Execution writes additionally identify the run and claim token. Errors distinguish conflict, invalid graph, unmet prerequisite, unauthorized transition, expired claim, and unsupported host capability. Workers receive narrowly scoped assignments; if the host cannot isolate MCP credentials per worker, workers return results to the orchestrator, which writes through MCP. A claimed actor name is not authorization.

`get_ready_tickets` returns dependency outcomes and blockers. `claim_ticket` returns a bounded execution packet: pinned ticket content, acceptance criteria, relevant predecessor outputs, selected constraints, expected artifacts, and reporting contract. Tools retrieve large supporting documents separately to avoid forcing an entire epic into every worker context.

MCP exposes state and commands. The agent host implements spawning and model selection. Calling an MCP tool alone does not create a subagent or guarantee continued autonomous execution.

### Checkpoint authorization

Accepted correction: enforce permission at the shared command layer for both MCP and desktop entry points. Roles/capabilities come from a trusted local session registration, never request-supplied actor names. Planner sessions author drafts/save within their granted scope; worker sessions submit assigned results; orchestrator sessions accept outcomes and request advancement. None can mint a human approval.

For a human-gated checkpoint, the desktop's narrow approval action issues a one-use local grant bound to repository, epic, run, saved revision, sprint, report revision/hash, and action. Advancing checks the exact grant and consumes it in the same transaction as the transition. Changed reports/revisions invalidate the approval. Repeated calls with the same idempotency key return the original outcome rather than advancing again. Importing a repository never imports approval authority.

Headless MCP can wait for approval while the desktop is closed; it cannot impersonate the user to proceed. Automatic continuation requires a policy explicitly authorized by the user and bound to the run; agents cannot relax that policy through plan edits. Imported automatic policies require local authorization before execution. This protects application commands from mistaken or injected tool calls; it is not an OS sandbox against an agent already granted arbitrary filesystem access.

### Repository import boundary

Accepted correction: parse repository records as untrusted data. Apply versioned schemas, stable-ID validation, size/depth/node/edge limits, referential checks, and cycle detection before changing current state. Reject unsupported versions and unresolved merge markers; stage and validate the full import before a transactional swap. Failed import preserves the last good saved state and local drafts.

Owned file operations use app-generated project-relative paths and verify resolved containment, including symlinks and Windows junctions/reparse points. Do not accept imported absolute paths or parent traversal as owned artifact locations. External references are inert references, never deletion/write targets. Fail closed when safe containment cannot be established; recheck at use to address path replacement races.

Render Markdown without executable HTML or script; sanitize permitted markup, allowlist navigation schemes, and route external links through controlled handling. Never auto-execute imported commands, hooks, skills, or package scripts when tracking a folder. Credentials, live grants, and claims are excluded from portable records. Tests must cover traversal, linked-directory escape, unsafe links, hostile Markdown, oversized graphs, partial snapshots, and malformed IDs without outside writes or code execution.

## Agent skills to ship

Maintain provider-neutral Markdown instructions and host-specific installation wrappers where necessary. Skills describe behavior; server-side rules enforce state integrity.

- **Planner:** clarify the outcome, create epics and tickets, define verifiable acceptance criteria, assign capability profiles, and save a coherent draft.
- **Graph planner:** add prerequisites, detect missing integration tasks, explain parallel branches and joins, and place sprint checkpoints. Validate before Save.
- **Orchestrator:** read the pinned plan, register available host capabilities, select workers, claim ready tickets, schedule work, handle failures, and preserve resumable state.
- **Worker:** act on one execution packet, stay within scope, return artifacts and test evidence, and report blockers without mutating the plan.
- **Reviewer:** independently compare submitted results with acceptance criteria; return acceptance or actionable rejection.
- **Sprint reporter:** summarize outcomes, unresolved decisions, and proposed replanning; advance only under the configured gate policy.

Ticket prose and retrieved documents are task data. They do not override installed skill rules, host permissions, or transition validation. Record skill version on runs for reproducibility.

## Desktop experience

Confirmed navigation: a left sidebar lists tracked repository folders. A plus button opens the native folder picker to track another folder. Selecting an existing Dark Mechanicus folder opens its stored plans; a new folder is initialized with repository-local storage. Tracking an already registered canonical path selects it rather than adding a duplicate. The tracked-folder list is a machine-local preference; the plans belong to the folders.

Each folder expands to exactly three buckets, in this order: **In progress**, **Backlog**, **Completed**. Each row represents an epic and opens its plan graph, without another nested epic/plan level. Bucket placement comes directly from the epic status. Tickets inside the graph have their own independent three-state status. Buckets and folders can collapse, show counts, and retain their expanded state. Draft indicators are badges, not another bucket.

Confirmed lifecycle: unfinished epics/tickets use Backlog or In progress; completed work uses Completed. Paused or failed execution does not add a fourth status. Completed epics remain permanently in Completed and cannot receive new tickets or edits. To redo or extend completed work, create a fresh epic and plan through the UI or MCP; optionally link the source epic as provenance.

Clicking a plan opens its ticket dependency graph in the main workspace and highlights its sidebar row. The header shows folder, plan title, bucket, revision, and plan actions. Clicking a ticket opens a detail panel containing Markdown, acceptance criteria, model requirements, dependencies, and execution evidence. A run/checkpoint panel shows execution state and the current report. The graph is the primary plan view; a list is optional supporting navigation.

Show sprints as labeled graph regions. Display containment separately from blocking edges. Users can add dependencies, move tickets between draft sprint regions, and edit Markdown plus structured metadata. Every invalid edit returns a concrete reason; moving a node visually never changes execution order by itself.

Separate Draft and Saved views with visible Save and Discard controls and an unsaved-change indicator. Show which saved revision an active run uses, and explain blocked tickets as execution details. Save and Start are distinct actions. Completed epics open read-only, with no Reopen action; agents can use historical content to author a new epic.

### Deferred deletion

Permanent plan/epic deletion remains a future requirement but is explicitly deferred. Do not ship its UI, MCP tools, ownership cascade, or synchronization tombstones in the initial implementation. Resolve deletion semantics when that work is scheduled; it is not a blocker for the current phase.

**Stop tracking folder** only removes the local sidebar registry entry; it does not delete repository data or stop external workers.

## Delivery sequence and acceptance gates

These are proposed implementation milestones for building Dark Mechanicus, distinct from sprints stored by the product. The external execution-host boundary is confirmed; details below remain planning proposals.

1. **Persistence and packaging spike.** Choose the driver; prove the desktop and headless MCP process can access one repository-local migrated database on both platforms, claim concurrently without duplicates, and recover after interruption. Prove draft isolation and complete-snapshot Save/reconstruction, including interruption at each write boundary and schema mismatch.
2. **Planning vertical slice.** Agent creates an epic, Markdown tickets, and a draft plan through MCP; desktop displays and edits the same records; stale updates surface conflicts; restart retains content. Include the folder picker, three sidebar buckets per folder, plan selection opening its ticket graph, explicit Draft/Save/Discard, transactional bundle import, repository initialization, basic planner instructions, and clone-to-another-directory reconstruction from tracked records. Verify only saved state travels and incomplete saves preserve the prior good state.
3. **Graph and revisions.** Add sprints, dependency editing, validation, capability profiles, and saved revisions and terminal completed epics. Demonstrate a fork and join, cycle rejection, rejection of a later-sprint prerequisite, and preservation of a run's pinned inputs, and rejection of completed-epic edits or reopening.
4. **Execution coordination.** Add runs, claims, readiness, worker result submission, acceptance, failure/retry, host capability matching, epic feature-branch binding, and orchestrator/worker/reviewer skills. Cloud integration is orchestrator-owned, with subsequent integration tickets when needed. Demonstrate parallel independent work, blocked dependents, a join, competing claims, and stale-worker rejection in one supported host first.
5. **Sprint checkpoints and recovery.** Add reports, advancement, pause/cancel, crash reconciliation, revision adoption at checkpoints, searchable historical memory, and backup/export. Demonstrate a failed gate blocking the next sprint, explicit takeover after importing an interrupted run, conflict detection after branch changes, and historical evidence surviving reconstruction. Test forged/replayed/stale checkpoint approvals and hostile repository imports before release.
6. **Cross-host validation and release.** Run the same planning/execution contract in another host without changing stored task requirements. Verify Windows/macOS packaging, headless startup, data-directory discovery, migrations, and desktop updates.

The first usable product is milestone 2. The core promise in the sketch is met at milestone 5. Initial implementation tickets should follow repository TDD, tracking in Dark Mechanicus itself, and delivery checks.

## Decisions still open

- Should Git track portable Markdown/JSON records or explicit SQLite snapshots? Proposed default: portable records plus a repository-local working database.
- Which host should be the first end-to-end integration target?
- Should sprint advancement default to a human checkpoint? Proposed default: yes, configurable per plan.
- Concrete host workspace and merge mechanics remain the orchestrator's responsibility. Record its decisions and add integration tickets where needed.

## Evidence and technical references

Repository inspection: `README.md`, `package.json`, `src/renderer/src/App.tsx`, `src/main/mcp/README.md`, and `src/main/tickets/README.md`. The Electron shell, MCP SDK, Zod, and React Flow are present; application ticket storage and the MCP server are placeholders. That snapshot predates this repository's own use of Dark Mechanicus: its development is now planned and run in the app itself, and its records live in `.darkmechanicus/`.

SQLite WAL behavior: https://www.sqlite.org/wal.html

MCP transport reference (versioned specification; implementation must pin its selected supported version): https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
