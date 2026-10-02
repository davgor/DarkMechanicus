# Connect an agent host over MCP

Dark Mechanicus ships a headless MCP server: `out/main/mcp.js`. An agent host launches it as a child process and talks to it over stdio. It opens the repository's `.darkmechanicus/local/state.sqlite` directly, so it works with the desktop app closed and shares the same data when the app is open.

One process is one session with one role. Start one server entry per role you want to give an agent (see [Roles](#roles-and---allow-save)). Every server offers the 6 shipped skills as prompts and lists only the tools its role may call (see [Tools per role](#tools-per-role)).

## Requirements

- A local folder for the repository, on local disk. Do not use a network share or a cloud-sync folder: the database runs in WAL mode.
- Packaged app: nothing else. The app's runtime has SQLite built in.
- Dev checkout: **Node 22.13 or newer** (`node --version`). The database driver is the built-in `node:sqlite`. Older Node fails with `No such built-in module: node:sqlite`.

## Launch options

`node out/main/mcp.js [--repo <path>] [--role <role>] [--allow-save] [--label <text>] [--help]`

| Option | Meaning |
|--------|---------|
| `--repo <path>` | Repository root to coordinate. Default: `$DARKMECHANICUS_REPO`, else the current directory. Relative paths resolve against the current directory. Point every session of an epic at the same coordinating checkout. |
| `--role <role>` | `orchestrator` (default), `planner`, `worker`, or `reviewer`. `desktop` is reserved for the app and is refused. |
| `--allow-save` | Lets a `planner` or `orchestrator` session call `save_plan`. Without it the agent has to ask a person to press Save in the desktop app. |
| `--label <text>` | Name shown for the session in the desktop app. Default: `<role> via MCP`. |
| `--help` | Print usage on stdout and exit. |

Exit codes: `0` clean shutdown, `1` startup or shutdown failure, `2` bad arguments.

## Connect the host

### Write it from the app

For Claude Code, the desktop app writes the config for you. It adds a `darkmechanicus` server to `.mcp.json` at the repository root, the project config file Claude Code reads. Other hosts still use the copy-paste snippet and the sections below.

- **Folder home:** the MCP card has a **Claude Code** section. It shows the target file, the role (`planner` by default, or `orchestrator`), and whether the agent may save plans (`--allow-save`, on by default). Press **Connect Claude Code**.
- **Onboarding:** **Also write .mcp.json so Claude Code can connect** is on by default. Initialize then writes the file after it creates `.darkmechanicus/`, as a `planner` with `--allow-save`.

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
| `planner` | Read, create epics, edit drafts, comment, save named capability profiles (`save_profile`). `save_plan` only with `--allow-save`. |
| `orchestrator` (default) | Everything a planner can, plus register hosts, start and control runs, claim tickets, review attempts, submit sprint reports, and advance sprints. Never approves. |
| `worker` | Heartbeat, submit, and fail for the claim it holds; comment. |
| `reviewer` | Accept or reject submitted attempts; comment. |

Every role can read and add comments (`list_comments`, `add_comment`): append-only Markdown notes on an epic or one of its tickets, signed with the session's role and label. Completed epics refuse new comments.

Some actions exist only in the desktop app and are not available over MCP for any role: approving a checkpoint, authorizing auto-continue, granting a retry, and queueing a run.

Suggested setup: planning sessions as `planner` without `--allow-save` (the person reviews and presses Save), execution as `orchestrator`. Add `--allow-save` only when you want an agent to save without you.

## Tools per role

A session lists only the tools its role may call. Each tool adapts one command, and each command declares the capability it needs (`src/core/commands/capabilities.ts`); a tool is listed when the role holds that capability. Calling an unlisted tool anyway gets `unauthorized` and runs nothing.

| Tools | planner | orchestrator | worker | reviewer |
|-------|:-------:|:------------:|:------:|:--------:|
| Read-only (24): `get_capabilities`, `get_project`, `list_projects`, `get_storage_status`, `search_history`, `list_branch_epics`, `list_sessions`, `list_epics`, `get_epic`, `list_tickets`, `get_ticket`, `get_plan`, `validate_plan`, `list_revisions`, `match_capabilities`, `get_run`, `get_ready_tickets`, `get_sprint_report`, `get_checkpoint`, `get_run_events`, `list_comments`, `list_profiles`, `get_profile`, `preview_board_import` | yes | yes | yes | yes |
| Comments: `add_comment` | yes | yes | yes | yes |
| Profiles: `save_profile` | yes | yes | | |
| Repository and drafts: `initialize_repository`, `flush_portable_state`, `reconcile_repository`, `create_epic`, `import_board`, `create_ticket`, `update_ticket`, `open_plan_draft`, `update_plan_draft`, `discard_plan_draft` | yes | yes | | |
| `save_plan` | with `--allow-save` | with `--allow-save` | | |
| Epic and ticket status: `set_epic_status`, `set_epic_branch`, `set_ticket_status` | | yes | | |
| Runs: `register_host`, `start_run`, `pause_run`, `resume_run`, `cancel_run`, `takeover_run`, `adopt_revision` | | yes | | |
| Claims and reporting: `claim_ticket`, `reconcile_attempt`, `carry_forward_ticket` | | yes | | |
| `heartbeat_attempt`, `submit_attempt`, `fail_attempt` | | yes | yes | |
| `accept_attempt`, `reject_attempt` | | yes | | yes |
| Checkpoints: `submit_sprint_report`, `advance_sprint` | | yes | | |
| **Total** | 36 (37 with `--allow-save`) | 56 (57 with `--allow-save`) | 28 | 27 |

`--allow-save` has no effect for `worker` and `reviewer`. No role lists a tool for the desktop-only actions.

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

## Skills

The six shipped skills are served as MCP prompts: `darkmechanicus-planner`, `darkmechanicus-graph-planner`, `darkmechanicus-orchestrator`, `darkmechanicus-worker`, `darkmechanicus-reviewer`, and `darkmechanicus-sprint-reporter`. Load the one that matches the job before starting. `get_capabilities` reports the skills version, and runs record it.

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
| `unauthorized` | The session's role lacks the capability (the tool is not in its list either). Check `get_capabilities` and relaunch with the right `--role`. `save_plan` also needs `--allow-save`. |
| A tool from the docs or a skill is missing from the host's tool list | The role does not include it. See [Tools per role](#tools-per-role). |
| `not_initialized` | Call `initialize_repository`. |
| `approval_required` or `gate_blocked` on `advance_sprint` | Waiting for a person's approval, or a gate condition is unmet. `get_checkpoint` lists what is missing. |
| `stale_claim` or `expired_claim` | The claim was superseded or its lease ran out. Stop the worker. The orchestrator reconciles the attempt before any retry. |
| `invalid_input` | The arguments do not match the tool's input schema; nothing ran. `details.issues` lists each field by path with what is wrong. |
| Long plans are cut off by the host | Use `list_tickets` and `get_ticket` instead of `get_plan` for large plans. |
| `list_sessions` shows old sessions | Sessions that were killed cannot close themselves. They fall out of the active list after 60 seconds and are harmless. |
