# Connect an agent host over MCP

Dark Mechanicus ships a headless MCP server: `out/main/mcp.js`. An agent host launches it as a child process and talks to it over stdio. It opens the project's database directly, so it works with the desktop app closed and shares the same data when the app is open.

Which database that is follows the folder's [storage mode](../decisions/0002-storage-modes.md), which the server resolves from the repository path — there is no flag to keep in sync:

- **`repo`** (the default): the repository's own `.darkmechanicus/local/state.sqlite`, beside the Git-tracked records.
- **`db`**: `~/.darkmechanicus/projects/<key>/local/state.sqlite`, and nothing is written into the repository at all. Set `DARKMECHANICUS_HOME` to move that directory — set it for **both** the app and the agent host, or the two will look in different places. The snippet the app gives you already pins it, so copy the snippet rather than writing the entry by hand.

One process is one session with one role. Start one server entry per role you want to give an agent (see [Roles](#roles-and---allow-save)). Every server offers the 8 shipped skills as prompts and lists only the tools its role may call (see [Tools per role](#tools-per-role)).

## Requirements

- A local folder for the repository, on local disk. Do not use a network share or a cloud-sync folder: the database runs in WAL mode.
- Packaged app: nothing else. The app's runtime has SQLite built in.
- Dev checkout: **Node 22.13 or newer** (`node --version`). The database driver is the built-in `node:sqlite`. Older Node fails with `No such built-in module: node:sqlite`.

## Launch options

`node out/main/mcp.js [--repo <path>] [--role <role>] [--allow-save | --no-allow-save] [--label <text>] [--help]`

| Option | Meaning |
|--------|---------|
| `--repo <path>` | Repository root to coordinate. Default: `$DARKMECHANICUS_REPO`, else the current directory. Relative paths resolve against the current directory. Point every session of an epic at the same coordinating checkout. |
| `--role <role>` | `orchestrator` (default), `planner`, `worker`, or `reviewer`. `desktop` is reserved for the app and is refused. |
| `--allow-save` | Lets a planner save plans. Orchestrators may save by default; worker/reviewer roles never gain saving. |
| `--no-allow-save` | Explicitly starts without general saving permission. Existing orchestrators may use `request_save_permission`, inspect `list_save_permission_requests`, and recheck `get_capabilities` after a human or authorized other orchestrator decides. |
| `--label <text>` | Name shown for the session in the desktop app. Default: `<role> via MCP`. |
| `--help` | Print usage on stdout and exit. |

Environment: `DARKMECHANICUS_REPO` supplies the default `--repo`, and `DARKMECHANICUS_HOME` the Dark Mechanicus home directory (default `~/.darkmechanicus`) that database-only projects live in.

Exit codes: `0` clean shutdown, `1` startup or shutdown failure, `2` bad arguments.

## Connect the host

### Write it from the app

For Claude Code, the desktop app writes the config for you. It adds a `darkmechanicus` server to `.mcp.json` at the repository root, the project config file Claude Code reads. Other hosts still use the copy-paste snippet and the sections below.

- **Folder home:** the MCP card has a **Claude Code** section. It shows the target file, the role (`planner` by default, or `orchestrator`), and whether the agent may save plans (`--allow-save`, on by default). Pick `orchestrator` so the session can run epics as well as plan them (see [Working model](#working-model-your-session-is-the-orchestrator)), then press **Connect Claude Code**.
- **Onboarding:** **Also write .mcp.json so Claude Code can connect** is on by default. Initialize then writes the file after it creates `.darkmechanicus/`, as a `planner` with `--allow-save`. A **Database only** folder is not offered the option, and both writing `.mcp.json` and installing the skills are refused for it with `unsupported_capability`: that mode writes nothing into the repository, so copy the snippet into your host's own configuration (for Claude Code, `~/.claude.json`) instead.

The entry is built for the app you are running, like the copy-paste snippet, plus `--role`, `--allow-save` when allowed, and `--label "Claude Code"` (the session name in the app). For the packaged macOS app:

```json
{
  "mcpServers": {
    "darkmechanicus": {
      "command": "/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus",
      "args": [
        "/Applications/DarkMechanicus.app/Contents/Resources/app.asar/out/main/mcp.js",
        "--repo",
        "/Users/you/work/my-repo",
        "--role",
        "planner",
        "--allow-save",
        "--label",
        "Claude Code"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

A development build writes `node` and the checkout's `out/main/mcp.js` instead, with no `env`.

How the file is written:

| `.mcp.json` | What happens |
|---|---|
| Missing | Created with just the `darkmechanicus` server. |
| Has other servers or keys | The server is added. Every other server and top-level key is kept; the file is rewritten as two-space JSON. |
| Already has the same `darkmechanicus` entry | Nothing is written. |
| Has a different `darkmechanicus` entry | The folder home shows the current entry and asks before it replaces it. Onboarding never replaces it; it keeps the entry and says so. |
| Not valid JSON, or not shaped like an MCP config | Nothing is written. Fix or remove the file, then try again. |
| A symbolic link, a directory, or a path that resolves outside the repository | Refused; nothing is read or written. |

The file contains this machine's path to the Dark Mechanicus app, and the repository's absolute path. It works as is only on this machine. Whether to commit it is up to you; the app never commits anything. If teammates install the app elsewhere or keep the repository at another path, each of them can write their own from the app.

Turn off **Let it save plans** if you want to review drafts and press Save yourself (see [Roles](#roles-and---allow-save)). Start Claude Code in the repository afterwards; it asks you to approve the project's servers from `.mcp.json` the first time.

### Packaged app

Use the app executable as the command and run it as plain Node with `ELECTRON_RUN_AS_NODE=1`. No window opens.

| | Windows (installer build) | macOS |
|---|---|---|
| `command` | `%LOCALAPPDATA%\Programs\DarkMechanicus\DarkMechanicus.exe` | `/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus` |
| `<resources>` | `%LOCALAPPDATA%\Programs\DarkMechanicus\resources` | `/Applications/DarkMechanicus.app/Contents/Resources` |
| `args` | `["<resources>\\app.asar\\out\\main\\mcp.js", "--repo", "<repo>"]` | `["<resources>/app.asar/out/main/mcp.js", "--repo", "<repo>"]` |
| `env` | `ELECTRON_RUN_AS_NODE=1` | `ELECTRON_RUN_AS_NODE=1` |

Use the installer (Setup) build on Windows. The portable build unpacks itself to a temporary folder on every launch, so it has no stable path for a host to point at. Expand `%LOCALAPPDATA%` yourself if your host does not do it. If you installed the app elsewhere, use that folder.

### Dev checkout

```bash
npm install          # once
npm run build        # emits out/main/mcp.js
node out/main/mcp.js --repo /path/to/repo
```

### Hosts that use `mcpServers` JSON

Windows, packaged:

```json
{
  "mcpServers": {
    "darkmechanicus": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\DarkMechanicus\\DarkMechanicus.exe",
      "args": [
        "C:\\Users\\you\\AppData\\Local\\Programs\\DarkMechanicus\\resources\\app.asar\\out\\main\\mcp.js",
        "--repo",
        "C:\\work\\my-repo",
        "--role",
        "orchestrator"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

macOS, packaged:

```json
{
  "mcpServers": {
    "darkmechanicus": {
      "command": "/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus",
      "args": [
        "/Applications/DarkMechanicus.app/Contents/Resources/app.asar/out/main/mcp.js",
        "--repo",
        "/Users/you/work/my-repo"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Dev checkout:

```json
{
  "mcpServers": {
    "darkmechanicus": {
      "command": "node",
      "args": ["/path/to/DarkMechanicus/out/main/mcp.js", "--repo", "/path/to/repo"]
    }
  }
}
```

Give each role its own entry name (for example `darkmechanicus-planner` with `--role planner`). Arguments are passed as a list, so paths with spaces need no extra quoting. In JSON, write Windows backslashes doubled.

### First use

Ask the agent to call `get_capabilities`. It reports the role, the repository root, the skills version, and whether the repository is `initialized`. A new folder needs `initialize_repository` once (planner and orchestrator roles). That creates `.darkmechanicus/` and never commits anything.

To check a build without a host, run `npm run build && npm run smoke:mcp`. It launches the built server against a temporary repository, plans and saves an epic, runs one ticket through claim, submit, and accept, and adds and lists a ticket comment.

To check an installed app the same way, point the script at the app executable and the server inside `app.asar`:

```bash
MCP_SMOKE_COMMAND="<app executable>" MCP_SMOKE_SERVER="<resources>/app.asar/out/main/mcp.js" npm run smoke:mcp
```

## Roles and `--allow-save`

Roles are fixed at launch. Nothing a tool call says can change them.

| Role | Can do |
|------|--------|
| `planner` | Read, create epics, edit drafts (including corrective DRAFT work from a retro's experiments, `create_corrections`), comment, save named capability profiles (`save_profile`), set the project's Definition of Done (`set_definition_of_done`), and version project delivery standards (`set_delivery_standards`). `save_plan` only with `--allow-save`. |
| `orchestrator` (default) | Everything a planner can except set the Definition of Done (it reads it with `get_project`, and holds work to it when it accepts), plus register hosts, start and control runs, claim tickets, review attempts, record usage for any attempt of its run and the run's overhead, submit sprint reports, record experiment statuses and results (`record_experiment_event`), redraft the next sprint from a retro (`redraft_next_sprint`), retry a ticket at its retry limit itself (`retry_ticket`, at most the plan's `autoRetryLimit` times per ticket over all the epic's runs, so a new run does not reset it), advance sprints, launch named Kanban cards, and carry out a Linear transfer the person queued (`epic.transfer`; see [Linear transfer](#linear-transfer)). With `--no-allow-save` it still saves the plan of an epic whose active run (queued, running, awaiting its checkpoint or paused) this machine owns, so it can fix the sprint it runs and adopt the revision (`adopt_revision` with a `reason`) without you. That save may not change the policies of the epic's latest saved revision, or remove a ticket with spent attempts in the run or move one to a later sprint, and it cannot adopt a revision that does either (so it cannot raise its own retry limits; past `autoRetryLimit`, retries are yours to grant). It edits such a ticket in place, splits work into new tickets, or retries it with `retry_ticket`. Never approves human checkpoints, retry grants or card outcomes. |
| `worker` | Heartbeat, submit, and fail for the claim it holds; report that attempt's usage (`record_attempt_metrics` with its claim token); comment. |
| `reviewer` | Accept or reject submitted attempts; report review overhead usage (`record_run_metrics`); comment. |

Every role can read and add comments (`list_comments`, `add_comment`): append-only Markdown notes on an epic or one of its tickets, signed with the session's role and label. Completed epics refuse new comments. Every role can also read and add Kanban card messages (`list_kanban_messages`, `add_kanban_message`), stage an image (`add_attachment`), name its chat (`name_chat`), and read every scorecard and metric (see [Scorecards and project metrics](#scorecards-and-project-metrics)).

Some actions exist only in the desktop app and are not available over MCP for any role: approving a checkpoint, authorizing auto-continue, granting a retry, queueing a run, queueing or canceling a Linear transfer, recording a person's rating, rescue time or planned review time, labelling a budget as a person's estimate, and creating corrective work in another project (the Dark Mechanicus source). A person's escaped-defect records (`recordEscapedDefects`) are desktop-only too, but no desktop control calls that command yet; escaped defects are recorded over MCP with `record_attempt_metrics` instead (see [Scorecards and project metrics](#scorecards-and-project-metrics)).

Suggested setup: connect the agent session you work with as `orchestrator`, which starts with Allow save by default. Use `--no-allow-save` to opt out. Use `planner` only for a session that must never run anything, adding `--allow-save` only when it may save. See [Allow save requests](agents.md#roles-and-allow-save) for the narrowly scoped, audited approval flow; acquired permission never delegates authority.

### Working model: your session is the orchestrator

The agent session you talk to is the orchestrator. It plans epics, and when you ask it to run one, it runs the epic in that same session. It does not hand the run to another session.

It never does a ticket itself. For each ready ticket it:

1. Claims the ticket and picks the worker's model and effort (the `recommended` result of `match_capabilities`, then `claim_ticket`).
2. Spins up a subagent as the worker at that model and effort, with the ticket's content and the worker guide ([`skills/worker.md`](../../skills/worker.md)). The worker runs only targeted checks, in its own worktree branched from the sprint integration branch. In Claude Code, [Dispatch a worker in Claude Code](claude-code-host.md) has the model catalog and the agent definitions.
3. Keeps the claim token and heartbeats while the subagent works, unless the subagent can make the reporting calls itself. Then it submits the subagent's outputs and evidence.
4. Reviews the result against the ticket's own criteria and the worker's targeted evidence, with no full sweep, and accepts or rejects it. It merges accepted work into a separate worktree on the sprint integration branch, so the coordinating checkout stays on the epic branch, and records a row check (`record_row_check`) when a row is fully accepted.

When the sprint's acceptance node is ready, it runs the project's Definition of Done on the combined work, verifies each item the node's criteria cover, squashes the sprint into one commit on the epic branch, and submits that commit as the node's increment. Then it files the sprint report and waits until you approve the checkpoint in the desktop app (the rules behind this are under [the sprint cadence](../architecture.md#runs-readiness-and-attempts)). The full loop is in the kernel guide [`skills/orchestrator.md`](../../skills/orchestrator.md) and its built-in knowledge facts in [`skills/knowledge/orchestrator/`](../../skills/knowledge/orchestrator/), which reach the orchestrator as pushed `context` and through `get_context` (see [Knowledge layers](knowledge.md)).

A session's role is fixed when it starts. If its `get_capabilities` says `planner`, change the entry to `--role orchestrator` and start a new session. A running session doesn't pick up the change.

### Reporting token and time usage

Usage is reported by the session that did the work, never estimated. Two routes, both on the orchestrator's grant:

- **Your host writes session files (OMP, Claude Code).** Run `dm usage --run <run id>` from the orchestrating session. It reads the host's session (OMP: `$PI_SESSION_FILE`; Claude Code: pass `--session-file <session>.jsonl`), and records each subagent's tokens and active time to the attempt whose claim token it was spawned with (or was handed later in a message, or presented in an attempt call), the main thread as `orchestration` overhead for the part of the session that orchestrated this run, and any other thread of the run (a reviewer) as `unattributed` overhead. Running it again records only what is new. A thread still working keeps its number so far as a lower bound and reads `partial` until it has been quiet for 15 minutes, so run it after each row. The orchestrating session is always working while it runs the command, so its own orchestration reads `partial` from inside: make the final read from outside the session (a terminal with the same grant, with `--session-file` naming the session's main file) at least 15 minutes after the run's last work. `--billing subscription` (or `api_key`) states how the account pays, so the host's list price is never read as a marginal cost; `--dry-run` shows the attribution without recording.
- **Your host cannot read its usage (Codex, Cursor Agent, Autonomous, custom agents).** Relay real numbers with `record_attempt_metrics` (per attempt, without the claim token as the orchestrator) and `record_run_metrics`, or run `dm usage --run <run id> --unavailable <host>` after each row: it marks the orchestration bucket and every attempt that holds nothing as `unavailable` instead of unreported, never touches a bucket with real numbers, and can be repeated. `get_run_metrics` shows each attempt, the overhead per kind (`overheadByKind`) and whether the totals are complete. Which agents can be read is `HOST_USAGE_SUPPORT` in `src/shared/domain/hostUsage.ts`; the rules are in [space-grading.md](../space-grading.md#host-usage-tokens-and-active-time-at-the-boundary).

#### Measurement capabilities not verified

The desktop **Metrics** dashboard ends with a **Measurement capabilities** table built from `HOST_USAGE_SUPPORT`: each agent's tokens and active time read either *Read from the host* or *Not readable*. These limits are labelled, not claimed as measured or verified:

| Capability | State |
|------------|-------|
| Codex, Cursor Agent, Autonomous and custom agents: tokens and active time | Not readable from the host. Usage reads `unavailable` (never 0, never estimated) unless real numbers are relayed with `record_attempt_metrics` / `record_run_metrics`. |
| Hosts that report only some token categories | The missing categories read `unavailable` with the reported part as a lower bound (`≥ … tokens reported`); totals are not summed across overlapping categories. |
| Claude Code and OMP session reading (`dm usage`) | Read from the host, covered by deterministic transcript fixtures; the DM-193 loop relays its usage through MCP, so no live host session was read there. |
| Packaged macOS app (`npm run package:mac`) | Not exercised by the DM-193 end-to-end verification: that ran the packaged **Windows** app (`npm run package:win`) on a Windows execution host ([DM-193 evidence](../verification/DM-193.md)). macOS packaging is covered only by its contract tests (`scripts/mac-packaging.test.mjs`). |

## Tools per role

A session lists only the tools its role may call. Each tool adapts one command, and each command declares the capability it needs (`src/core/commands/capabilities.ts`); a tool is listed when the role holds that capability. Calling an unlisted tool anyway gets `unauthorized` and runs nothing. The table below was generated from a live `tools/list` of the built server (`out/main/mcp.js`) launched once per role, with and without `--allow-save`; when tools change, regenerate it the same way rather than counting by hand.

| Tools | planner | orchestrator | worker | reviewer |
|-------|:-------:|:------------:|:------:|:--------:|
| Read-only (35): `get_capabilities`, `get_project`, `list_projects`, `get_storage_status`, `get_context`, `search_history`, `list_branch_epics`, `list_sessions`, `list_epics`, `get_epic`, `list_tickets`, `get_ticket`, `get_attachment`, `get_plan`, `validate_plan`, `list_revisions`, `match_capabilities`, `get_run`, `get_ready_tickets`, `get_run_events`, `get_run_metrics`, `get_planned_baselines`, `get_sprint_report`, `get_checkpoint`, `get_retro_findings`, `get_experiment`, `preview_corrections`, `list_comments`, `list_profiles`, `get_profile`, `preview_board_import`, `get_transfer`, `list_kanban_cards`, `get_kanban_card`, `list_kanban_messages` | yes | yes | yes | yes |
| Scorecards and metrics (12, read-only): `get_ticket_grade`, `get_sprint_grade`, `get_run_grade`, `get_epic_grade`, `get_report_scorecard`, `reassess_report_scorecard`, `get_space_signals`, `get_ticket_performance`, `get_escaped_defects`, `get_run_efficiency`, `get_run_timing`, `get_metrics_summary` | yes | yes | yes | yes |
| Comments, Kanban messages, images and chat names: `add_comment`, `add_kanban_message`, `add_attachment`, `name_chat` | yes | yes | yes | yes |
| Profiles: `save_profile` | yes | yes | | |
| Definition of Done: `set_definition_of_done` | yes | | | |
| Delivery standards: `set_delivery_standards` | yes | | | |
| Repository and drafts: `initialize_repository`, `rescan_repositories`, `flush_portable_state`, `reconcile_repository`, `create_epic`, `import_board`, `create_ticket`, `update_ticket`, `open_plan_draft`, `update_plan_draft`, `discard_plan_draft` | yes | yes | | |
| Corrective work: `create_corrections` | yes | yes | | |
| Kanban cards (`kanban.write`): `create_kanban_card`, `update_kanban_card` | yes | yes | | |
| `save_plan` | with `--allow-save` | yes | | |
| Allow save requests: `request_save_permission`, `decide_save_permission` (server checks original approval authority) | | yes | | |
| Allow save request status: `list_save_permission_requests` | yes | yes | yes | yes |
| Epic and ticket status: `set_epic_status`, `set_epic_branch`, `set_ticket_status` | | yes | | |
| Runs: `register_host`, `start_run`, `pause_run`, `resume_run`, `cancel_run`, `takeover_run`, `adopt_revision` | | yes | | |
| Claims and reporting: `claim_ticket`, `reconcile_attempt`, `carry_forward_ticket` | | yes | | |
| Row checks: `record_row_check` | | yes | | |
| `heartbeat_attempt`, `submit_attempt`, `fail_attempt` | | yes | yes | |
| Attempt usage: `record_attempt_metrics` | | yes | yes | |
| `accept_attempt`, `reject_attempt` | | yes | | yes |
| Run overhead usage: `record_run_metrics` | | yes | | yes |
| Checkpoints: `submit_sprint_report`, `redraft_next_sprint`, `advance_sprint` | | yes | | |
| Retrying a ticket at its retry limit (`ticket.auto_retry`): `retry_ticket` | | yes | | |
| Experiments: `record_experiment_event` | | yes | | |
| Linear transfer (`epic.transfer`): `start_transfer`, `record_transfer_item`, `submit_transfer_readback` | | yes | | |
| Kanban launch and claim: `launch_kanban_cards`, `claim_kanban_card` | | yes | | |
| Kanban reporting (`kanban.report`): `heartbeat_kanban_card`, `submit_kanban_card`, `fail_kanban_card` | | yes | yes | |
| Agent mail (`mail.use`; listed, but always `unauthorized` over MCP): `get_agent_identity`, `list_agent_peers`, `send_agent_message`, `read_agent_inbox`, `acknowledge_agent_messages`, `get_agent_mail_status` | yes | yes | yes | yes |
| **Total** | 75 (76 with `--allow-save`) | 110 (110 with `--allow-save`) | 65 | 61 |

An `orchestrator` lists `save_plan` and the narrow permission decision tool with or without Allow save. Explicitly disabled sessions (`--no-allow-save`) gain general saving only after approval; their separate own-run saving rule remains. `decide_save_permission` always checks original explicit authority server-side, so acquired saving cannot delegate it. `--allow-save` has no effect for `worker` and `reviewer`. No role lists a tool for the desktop-only actions: no tool presses Play on a Kanban card, approves one or kicks one back (`kanban.play` and `kanban.review` belong to a person in the desktop app).

The six agent mail tools are listed to every hosted role, but a mailbox belongs to a `dm` CLI grant the desktop bound to a chat, which no MCP session has (not even one that inherited `DM_SESSION_TOKEN`): every call over MCP answers `unauthorized` and changes nothing. Native Skitarii chats use them through the `dm` CLI; see [Agent mail between Skitarii chats](cli.md#agent-mail-between-skitarii-chats).

### Scorecards and project metrics

The scorecard and metrics tools (`src/mcp/tools/metrics.ts`) are read-only (capability `read`, so every role lists them, and a `dm` CLI `reader` session can `dm call` the same commands). Each adapts one score read command and returns its read model unchanged, so it answers the same JSON as the desktop's command channel and `dm call` for the same ids and cutoff. Dark Mechanicus computes every value; agents relay them and never regrade. Scores are in points (0–100), tokens in tokens and time in milliseconds; a missing measure is `null` with its reason, never 0; a grade is `final`, `provisional` (a required component missing or an estimated input) or `ungraded` (verification pending or missing, or fewer than 4 components scored). `get_report_scorecard` takes a sprint report revision id (and optionally its `reportRevision`) and returns the snapshot frozen with that revision, never a live grade; `reassess_report_scorecard` regrades it as of a cutoff without storing anything. Unknown ids fail with `not_found`. The rules are in [space-grading.md](../space-grading.md#reading-scorecards-and-the-desktops-measurement-controls).

Every one of the twelve is listed by every role (planner, orchestrator, worker, reviewer). `cutoff` is an optional ISO 8601 server time (default now; a later time is clamped to now; only records stored by then count).

| Tool | Inputs | Returns |
|------|--------|---------|
| `get_ticket_grade` | `runId`, `ticketId`, `cutoff?` | One ticket's grade in a run, its input and the three source reads |
| `get_sprint_grade` | `runId`, `sprintId`, `cutoff?` | A sprint's grade from its own raw measures, with every ticket grade |
| `get_run_grade` | `runId`, `cutoff?` | The run's grade from its own raw measures, with every ticket grade it was read from |
| `get_epic_grade` | `epicId`, `cutoff?` | The epic's grade over every run that executed work |
| `get_report_scorecard` | `reportId`, `reportRevision?` | The scorecard frozen with that report revision (`frozen`), or `legacy` for a report from before scorecards; never a live grade |
| `reassess_report_scorecard` | `reportId`, `reportRevision?`, `cutoff?` | The frozen snapshot untouched, regraded at its own cutoff and at the reassessment's, with the cause of each difference; stores nothing |
| `get_space_signals` | `level` (`ticket`, `sprint`, `run`, `epic`), `id`, `runId` (required for a ticket or sprint), `cutoff?` | The S, A and C inputs with the records behind them |
| `get_ticket_performance` | `runId`, `ticketId`, `cutoff?` | The P input: verification state, each criterion and check with its basis, charged and unassigned regressions |
| `get_escaped_defects` | `epicId`, `cutoff?` | The epic's escaped defects resolved from the ledger, with anomalies |
| `get_run_efficiency` | `runId`, `ticketId?`, `cutoff?` | The E, T and K inputs per ticket, sprint and run, with coverage and baselines |
| `get_run_timing` | `runId`, `ticketId?`, `cutoff?` | The run's time projection: elapsed, active, waits and effort, each with its coverage |
| `get_metrics_summary` | `epicIds?`, `since?`, `until?` | The project summary the Metrics dashboard shows: per-epic rows, totals, distribution, sprint trend, gaps and coverage |

The desktop's **Metrics** link, directly below the MCP line in the sidebar footer, opens a dashboard of the same `get_metrics_summary` answer for the selected folder ([space-grading.md](../space-grading.md#the-metrics-dashboard)). Two more reads cover usage and budgets: `get_run_metrics` (`runId`, `attemptId?`, `includeObservations?`) and `get_planned_baselines` (`epicId`, `runId?`).

No tool records a person's rating, rescue time or planned review or playtesting time: `recordHumanFeedback` needs `feedback.record`, which only the desktop session holds (rescue and planned review minutes are optional, and at least 1 and at most 2,400 when given). A person's escaped-defect records (`recordEscapedDefects`, also `feedback.record`) have no desktop control yet, so escaped defects are recorded with `record_attempt_metrics` (metric `escaped_defect`): any reporter may add an unassigned or candidate report, and only a session holding `attempt.review` (the orchestrator) may attribute one or record a later duplicate, reassessment, fix or withdrawal. A ticket's budget is a draft edit (`update_plan_draft`) saved by `save_plan`. An agent may not introduce the `person_estimate` label, or change the amounts of a budget while it keeps that label (`unauthorized`, nothing written); it may leave a person's budget as it is, replace it with a `planner_estimate` or `prior_tickets` budget, or clear it, and the plan diff shows that change to the person before Save.

### Retro findings, experiments and corrective work

A sprint report's retro may carry experiments drawn from its frozen scorecard; the whole flow, for the person and the agents, is in [Scorecards and corrective work](corrective-work.md).

| Tool | Roles | Inputs | What it does |
|------|-------|--------|--------------|
| `get_retro_findings` | every role (read) | `reportId`, `reportRevision?` | Ranks the measured gaps of that revision's frozen scorecard, with magnitude, coverage, hypotheses and the records behind each; writes nothing |
| `get_experiment` | every role (read) | `experimentId` | The experiment's latest definition, status, events, corrective tickets, outcome, and any grades brought back from a correction epic in another project (`crossRepoResults`) |
| `preview_corrections` | every role (read) | `reportId`, `experimentIds`, `target?` (`new_sprint`, `sprint` with `sprintId`, or `follow_up_epic` with an optional title), `edits?`, `fireguard?` | The DRAFT work creation would write: tickets, criteria, covers, dependencies, destination and the draft's validation, plus the restatement for blocked work; writes nothing |
| `create_corrections` | planner, orchestrator (`draft.edit`; `epic.create` for a follow-up epic) | as `preview_corrections`, plus `expectedDraftRevision` (the preview's, or null when it found no draft) | Writes the work into the epic's draft, or a follow-up epic for a completed one, with a Fireguard ticket per repository unless `fireguard: false`; idempotent per experiment; saves, adopts and starts nothing |
| `record_experiment_event` | orchestrator (`report.submit`, on the machine that owns the run) | `experimentId`, `event` (`kind: status` with `status` `selected`, `scheduled`, `in_progress`, `completed` or `abandoned`; or `kind: result` citing a sealed grade by `{ reportId, assessmentId }` or a stated value with evidence), `idempotencyKey?` | Appends one numbered event; the report, its hash and scorecard stay as approved |

A new report revision withdraws every experiment it does not restate. To keep one, restate it by its `id` with its original source `{ reportId, assessmentId }`; resubmitting the same body by its subject mints a new id and leaves the original's events behind.

Corrective work an experiment aims at the Dark Mechanicus source is created, routed and opened only by the person in the desktop app (the Improvement tab's Dark Mechanicus source panel); no MCP tool or grant reaches another project. Its results come back the same way: once the person presses **Bring back its grades**, `get_experiment` lists them under `crossRepoResults` (each grade with the `{ reportId, assessmentId }` to cite), and `record_experiment_event` records a result citing one of them on the machine owning the experiment's run. The recorded event carries that grade's sealed scorecard, scope starts, corrective tickets and planned sizes, bound to this project's request and the epic it links now, so another machine imports and checks it without the other project's records. A report that is neither this project's nor brought back is `invalid_input`, with a hint to bring the grades back first; grades of an epic the request no longer links (it was recreated) cannot be cited.

### Linear transfer

Moving a saved epic to a Linear project is the person's decision: they queue the transfer, or cancel it, in the desktop app (`queueTransfer`, `cancelTransfer`, capability `transfer.queue`, which only the desktop holds). No MCP tool, grant or `dm` session can queue or cancel one. Carrying out a queued transfer needs `epic.transfer`, which only the `orchestrator` role (and the desktop) holds; every role can follow it with `get_transfer`.

| Tool | Kind | What it does |
|------|------|--------------|
| `get_transfer` | read | Status (`not_started`, `queued`, `in_progress`, `verified`, `canceled`), the packet, the recorded items, the refs still to create, and the last read-back's mismatches. |
| `start_transfer` | idempotent | Starts the queued transfer or resumes one in progress, and returns the packet with what is recorded and what remains. Fails unless the person queued it. |
| `record_transfer_item` | idempotent | Records the Linear item created for one packet ref. The same values again change nothing; a different Linear id needs `replace`. |
| `submit_transfer_readback` | write | One part of the read-back from Linear; parts accumulate until `final: true`, which completes the epic on a full match or returns the mismatches. It takes no `idempotencyKey`: sending a part again is harmless, and a final part always ends the accumulation, so after a refusal the agent reads Linear back again from the start. |

The whole flow, from the app's Transfer to Linear button to what completion records, is in [Transfer an epic to Linear](linear-transfer.md).

## Tool results and errors

Every tool answers with one JSON payload, in `structuredContent` and as the text content: `{"ok": true, "data": ...}`, or on failure `{"ok": false, "error": {"code", "message", "details"}}` with `isError` set. `code` is the stable part; see the table below.

Arguments that do not match a tool's input schema fail with `invalid_input` before anything runs. The message and `details.issues` name each offending field by its path (up to ten):

```json
{
  "ok": false,
  "error": {
    "code": "invalid_input",
    "message": "Invalid arguments for get_plan: view: Invalid option: expected one of \"saved\"|\"draft\"",
    "details": { "tool": "get_plan", "issues": [{ "path": "view", "message": "Invalid option: expected one of \"saved\"|\"draft\"" }] }
  }
}
```

Nested fields use dotted paths such as `ops.0.ticket.title`. Omitted `arguments` count as an empty object.

A message on stdin longer than 32,000,000 bytes (`MCP_MESSAGE_MAX_BYTES`) is not read or parsed. The server answers it with a JSON-RPC error, code `-32600`, and keeps serving the next message. See [Message size](linear-transfer.md#message-size).

## Skills

The eight shipped skills are served as MCP prompts: `darkmechanicus-planner`, `darkmechanicus-graph-planner`, `darkmechanicus-orchestrator`, `darkmechanicus-worker`, `darkmechanicus-reviewer`, `darkmechanicus-sprint-reporter`, `darkmechanicus-linear-transfer`, and `darkmechanicus-collaboration`. Load the one that matches the job before starting. `get_capabilities` reports the skills version, and runs record it.

`heartbeat_attempt` takes an optional `progress` field: a note (at most 280 characters) and an optional step label (at most 64 characters) showing what work is in progress. The worker and orchestrator skills tell agents to send one with each heartbeat. The server stores the last 200 notes per attempt as local working data, never exports them with run history, and masks anything shaped like a claim token before storing. A refused heartbeat stores no note.

For a folder of Git repositories (one project over several repositories, set up with `initialize_repository` and `layout: "multi_repo"`), see [Work across a folder of repositories](multi-repo-folders.md).

## Working with the desktop closed

- All tools work without the desktop. Both processes use the same SQLite database. Writes queue on the write lock, so a busy moment can delay a call by a few seconds but not corrupt anything.
- The server heartbeats its session every 15 seconds so the desktop can show it as active. A session that stops heartbeating drops out of the active list after 60 seconds.
- Sprint checkpoints need a person. The agent submits its report, then waits and polls `get_checkpoint`. The person approves later in the desktop app. A headless agent cannot approve for itself.
- State moves between computers through your normal Git commit, push, and pull. `.darkmechanicus/local/` is not tracked. Run an epic on one computer at a time.

## Troubleshooting

**Read the diagnostics first.** The server writes diagnostics to stderr. Hosts usually show that in their MCP log. Stdout carries only the protocol. On a good start you see one line:

```text
darkmechanicus 0.4.0 ready: repo=/path/to/repo role=orchestrator save=not allowed session=ss_...
```

If the host reports that the connection closed at once, run the same command in a terminal. The reason is printed there.

| Symptom | Cause and fix |
|---------|---------------|
| `Repository folder not found or unreadable` | The `--repo` path does not exist. Fix the path. |
| `Unknown option`, `requires a value`, exit code 2 | Bad launch arguments. The message includes the usage text. |
| `No such built-in module: node:sqlite` | Node is older than 22.13. Upgrade, or use the packaged app. |
| `incompatible_schema` | The repository's database was created by a newer build. Update this app or checkout to the same version as the desktop. Databases are never downgraded. |
| `branch_changed` | The coordinating checkout's Git branch differs from the one recorded at the last reconcile. Saves and dispatch are blocked and active runs are paused. Switch back to the epic branch, or if the change is intended call `reconcile_repository`, then `resume_run`. Drafts are kept. |
| `run_not_owned` | The run was imported from another computer. Make sure the other computer has stopped, call `takeover_run` (it pauses the run and marks leased attempts `lease_expired`), call `reconcile_attempt` for each, then `resume_run`. |
| `unauthorized` | The session lacks authority. Check `get_capabilities`; orchestrators without general Allow save can request it explicitly, but only a human or an originally authorized other orchestrator can approve. Requesting is not granting. |
| A tool from the docs or a skill is missing from the host's tool list | The role does not include it. See [Tools per role](#tools-per-role). |
| `not_initialized` | Call `initialize_repository`. |
| `retry_escalation_required` on `retry_ticket` | The orchestrator used up the plan's `autoRetryLimit` (default 3) retries of that ticket over all the epic's runs (canceling and restarting the run does not reset them). Only the person's Grant retry in the desktop app adds attempts now; the orchestrator tells them why the ticket keeps failing. |
| `approval_required` or `gate_blocked` on `advance_sprint` | Waiting for a person's approval, or a gate condition is unmet. `get_checkpoint` lists what is missing. |
| `stale_claim` or `expired_claim` | The claim was superseded or its lease ran out. Stop the worker. The orchestrator reconciles the attempt before any retry. |
| `invalid_input` | The arguments do not match the tool's input schema; nothing ran. `details.issues` lists each field by path with what is wrong. |
| Long plans are cut off by the host | Use `list_tickets` and `get_ticket` instead of `get_plan` for large plans. |
| `list_sessions` shows old sessions | Sessions that were killed cannot close themselves. They fall out of the active list after 60 seconds and are harmless. |
