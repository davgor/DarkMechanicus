# Scorecards and corrective work

What a person and the agents do once a sprint has a scorecard: read the grades, turn a retro's experiments into corrective work in this repository or in the Dark Mechanicus source, measure whether the work helped, and recover when a request stops part way. The grading rules are in [space-grading.md](../space-grading.md); the records behind each step are in [architecture.md](../architecture.md#sprint-retros).

Nothing in these flows saves, adopts, starts, approves or reopens anything on the person's behalf. A low grade never starts work by itself, and no agent can create work in another project.

## Who does what

| Step | Person (desktop) | Agents (MCP) |
|------|------------------|--------------|
| Usage | — | The orchestrator runs `dm usage --run <run id>` after each row, or relays real numbers, or marks a host unavailable ([MCP setup](mcp-setup.md#reporting-token-and-time-usage)); a worker whose host is not read reports its own attempt |
| Ratings, rescue time, planned review time | Records them in the desktop app, on the sprint report's and the ticket's Scorecard tabs (minutes at least 1 and at most 2,400 when given) | Never |
| Escaped defects | No desktop control yet (the `recordEscapedDefects` command exists for a future one): tell the orchestrator | `record_attempt_metrics` with metric `escaped_defect`: any reporter may add an unassigned or candidate report; only an orchestrator (review authority) may attribute one or record a later duplicate, reassessment, fix or withdrawal |
| Verification | — | The reviewer or orchestrator accepts with per-criterion results |
| Report and scorecard | Approves the checkpoint | The orchestrator submits the report, which freezes the scorecard |
| Experiments | Reads them on the Improvement tab | The reporter writes them from `get_retro_findings`; the orchestrator records their statuses and results |
| Corrective work in this repository | Previews, creates, then saves, adopts and runs it | A planner or orchestrator may preview and create the same DRAFT work |
| Corrective work in the Dark Mechanicus source | Chooses the checkout, creates, opens, saves and runs it there, brings its grades back | Records results citing the grades brought back |

## Reading the grades

- **Desktop.** A sprint report's **Scorecard** tab shows the scorecard frozen with that revision (live and provisional before the sprint has a report); its **Improvement** tab shows the findings, experiments, their outcomes and the corrective work. An epic's **Scorecard** view shows its grade and each run. The **Metrics** link directly below the MCP line in the sidebar footer opens the folder's dashboard (see [space-grading.md](../space-grading.md#the-metrics-dashboard)).
- **Agents.** The twelve read-only scorecard and metrics tools ([MCP setup](mcp-setup.md#scorecards-and-project-metrics)) answer the same JSON. Relay it as returned: never regrade, average letters, or read a missing value as 0.
- A frozen scorecard never changes. Late usage, ratings, defects or a newer policy show only in a dated reassessment beside it (**Reassess now** on the report's Scorecard tab, `reassess_report_scorecard`).

## Flow 1: corrective work in this repository

For an experiment whose destination is this project's repository (`source_repository`):

1. Open the sprint report's **Improvement** tab and tick the experiments to act on. The destination shows this project's repository.
2. Choose where the work goes: a new sprint after the draft's last one (the default), or an existing later sprint of the draft. For a completed epic the work goes to a follow-up epic linked to it; the completed epic itself stays completed and gets no draft.
3. Keep the Fireguard ticket (the default for corrective work) or untick it; the panel asks for no reason, so when you drop it, say why in the plan rationale. Edit each work item's title, body, criteria and prerequisites if needed.
4. Press **Preview corrective work** (**Preview again** after a change) and read the tickets, criteria and covers, dependencies, destination and the draft's validation. Then **Create draft work**.
5. **Open the draft to review and Save.** Save, adopt (or Approve retro & redraft at a checkpoint) and run it with the normal controls. The corrective sprint has its own acceptance node and human checkpoint; a follow-up epic has its own branch and runs.

An agent does the same with `preview_corrections` and then `create_corrections` (the preview's `expectedDraftRevision`, or null when it found no draft).

**When it refuses:**

| What it says | What to do |
|--------------|------------|
| The draft changed since the preview (`conflict`) | Preview again; your selections and edits are kept |
| Work is unsized or vague (blocked) | Fix the work item in the edits, or have the reporter restate the experiment in a new report revision, with its `id` and original `{ reportId, assessmentId }` (the preview shows the restatement) |
| A newer report revision replaced this one | Preview from the latest revision; experiments it restated keep their ids, the ones it left out are withdrawn |
| The named sprint is missing, passed or in progress | Choose a new sprint or another later sprint |
| Same experiment, different payload (`idempotency_mismatch`) | The work already exists in another form: the preview names it under the experiment's `existing` (its `epicId`, keys and whether a draft or a saved revision holds it), and the refusal's details list the same per experiment. Open that epic and edit the work there |

A repeat of a created request adds nothing and answers where the work is.

## Flow 2: corrective work in the Dark Mechanicus source

For an experiment whose destination is the Dark Mechanicus source (`darkmechanicus_source`), the Improvement tab shows its own panel instead. Only the person can use it; no MCP tool, grant or `dm` session reaches another project.

1. **Choose the target checkout** (local target selection). Pick this folder, another tracked folder, or **Choose another folder…** in the dialog. The app checks that it is a Git checkout of the Dark Mechanicus source with a project record, not an installed copy of the app. The choice is stored on this machine only: records name the target project by its id, never by a path, and every other machine chooses its own checkout.
2. Read what **Create** would write there: a new backlog epic owned by that project, its tickets with keys planned there, a Fireguard ticket, the plan check, who asked, and the request key. Nothing is written yet.
3. Press **Create**. The source keeps a machine-local receipt for the request and the target project holds the epic.
4. **Open** leads to the epic in the target folder. Save, start and approve it there with that project's own controls: it has its own branch, runs, checkpoints and approvals, separate from the source epic's run. Its header links back to the epic that asked for it.
5. Once the correction epic has frozen grades, press **Bring back its grades** on the source's panel. The orchestrator then records the experiment's result with `record_experiment_event`, citing one of the listed grades by `{ reportId, assessmentId }`, on the machine that owns the experiment's run. **Before / after** sets that result against the source baseline.

When the active repository is itself the Dark Mechanicus source and is chosen as its own target, the correction epic is a local epic of this project and is measured like Flow 1's follow-up; nothing is carried.

## Recovery

### The checkout is missing or changed

Nothing clones, searches or redirects. A checkout that moved, vanished or changed is **Unavailable**, with the problem and a recovery step:

| Problem | Meaning | Recovery |
|---------|---------|----------|
| `missing` | The path is gone (moved, renamed or deleted) | Choose the checkout again where it is now, or clone and track it, then choose it |
| `renamed` | The same folder in another letter case | Choose it again under its new name |
| `relocated` | A link or junction on the path now leads elsewhere | Choose the real checkout |
| `untracked` | The folder is no longer tracked | Track it again, or choose another |
| `project_mismatch` | Another project now sits at the path | Choose the right checkout |
| `not_initialized`, `unreadable_project` | The checkout has no readable project record | Set it up (initialize) or repair `project.json`, then choose it |
| `installed_app`, `not_dm_source` | Not a source checkout of Dark Mechanicus | Choose a real source checkout |

While the target is unavailable, the request stays **Pending** on the source with its full draft. Once the checkout is back, **Retry the request**; or **Withdraw the request**. When the target cannot be checked, withdrawing asks you to confirm (**Withdraw anyway**) and records that it was withdrawn without checking: the target may already hold the work, and a later request with the same payload links to it.

### A request stopped part way

| Panel state | What happened | What to do |
|-------------|---------------|------------|
| **Pending** (the receipt is pending) | Requested here and not linked yet: the target was unavailable or refused for now, or it accepted the epic but recording the link here failed. The receipt keeps the draft, and the epic the target accepted when it did | **Retry the request** once the cause is fixed. When the target already accepted the work, the retry links that very epic and never writes a second one |
| **Created**, no link here | The target project holds the work, but this checkout has no receipt for it (another machine or checkout asked, or this database was rebuilt) | **Record the link here**: it records the link and writes nothing new in the target, even once the experiment closed |
| **Created**, linked | The target holds the epic and the receipt names it | Nothing to recover: **Open** it, or **Bring back its grades** once it has frozen grades |
| **Epic missing** | The chosen checkout no longer holds the epic this request reached (deleted there, or another checkout of the project holds it) | Choose the checkout that holds it, or press **Create a new epic in …**, which asks for confirmation |
| **Conflict** | Requested before with another payload, or for another target project | No main button: keep the earlier request, or withdraw it before asking again |
| **Blocked** | A request the target never accepted for an experiment that can no longer take new work (withdrawn, finished, aimed elsewhere, or its work not specific) | No main button: withdraw a pending request; it is never retried. A pending request the target already accepted stays **Pending**, and its retry still links it |

Every create and retry is idempotent by request key: a repeat returns the same epic on both sides and writes nothing new. The receipt counts attempts and keeps the last failed step with its error code, never a message or path. Two checkouts of one project each have their own database, so a duplicate epic is still possible when a request is repeated from a machine or checkout that lacks the first one's receipt or records; once the first checkout's saved records arrive, the shared key on both epics shows it ([architecture.md](../architecture.md#sprint-retros), residual cases).

### What is never changed

- The source epic, its draft, runs, reports and frozen scorecards are only read. A completed source epic stays completed, and its run is never reopened or taken over to record a result.
- Experiment events are appended in order beside the report that defines the experiment; the approved report, its hash and its scorecard stay as approved.
- The correction epic and any follow-up epic run separately: their own runs, branches, checkpoints and approvals. Their results are measured in their own frozen scorecards and only cited by the source experiment.
- A result carried from another project is sealed: an edited copy is refused on import, and its accepted times, scope starts and planned sizes are labeled as the target's word.

### Usage gaps

- A grade with T or K missing (`partial_coverage`, `not_reported`) usually means `dm usage` has not run since the last row, or a thread was still working. Run it again from outside the working thread; it records only what is new.
- A host that cannot report usage: `dm usage --run <run id> --unavailable <host>` marks the empty buckets unavailable (repeatable, never touching real numbers). The component then reads missing, never perfect.
- A frozen report keeps the coverage it had. Usage recorded later appears in a reassessment, not in the approved scorecard.
