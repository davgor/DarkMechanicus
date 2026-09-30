# Connect an agent host over MCP

Dark Mechanicus ships a headless MCP server: `out/main/mcp.js`. An agent host launches it as a child process and talks to it over stdio. It opens the repository's `.darkmechanicus/local/state.sqlite` directly, so it works with the desktop app closed and shares the same data when the app is open.

One process is one session with one role. Start one server entry per role you want to give an agent (see [Roles](#roles-and---allow-save)). Every server exposes 50 tools and 6 prompts (the shipped skills).

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

To check a build without a host, run `npm run build && npm run smoke:mcp`. It launches the built server against a temporary repository, plans and saves an epic, and runs one ticket through claim, submit, and accept.

To check an installed app the same way, point the script at the app executable and the server inside `app.asar`:

```bash
MCP_SMOKE_COMMAND="<app executable>" MCP_SMOKE_SERVER="<resources>/app.asar/out/main/mcp.js" npm run smoke:mcp
```

## Roles and `--allow-save`

Roles are fixed at launch. Nothing a tool call says can change them.

| Role | Can do |
|------|--------|
| `planner` | Read, create epics, edit drafts. `save_plan` only with `--allow-save`. |
| `orchestrator` (default) | Everything a planner can, plus register hosts, start and control runs, claim tickets, review attempts, submit sprint reports, and advance sprints. Never approves. |
| `worker` | Heartbeat, submit, and fail for the claim it holds. |
| `reviewer` | Accept or reject submitted attempts. |

Some actions exist only in the desktop app and are not available over MCP for any role: approving a checkpoint, authorizing auto-continue, granting a retry, and queueing a run.

Suggested setup: planning sessions as `planner` without `--allow-save` (the person reviews and presses Save), execution as `orchestrator`. Add `--allow-save` only when you want an agent to save without you.

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
| `unauthorized` | The session's role lacks the capability. Check `get_capabilities` and relaunch with the right `--role`. `save_plan` also needs `--allow-save`. |
| `not_initialized` | Call `initialize_repository`. |
| `approval_required` or `gate_blocked` on `advance_sprint` | Waiting for a person's approval, or a gate condition is unmet. `get_checkpoint` lists what is missing. |
| `stale_claim` or `expired_claim` | The claim was superseded or its lease ran out. Stop the worker. The orchestrator reconciles the attempt before any retry. |
| `MCP error -32602: Input validation error ...` | The MCP layer rejected the arguments before anything ran. The message names the field. |
| Long plans are cut off by the host | Use `list_tickets` and `get_ticket` instead of `get_plan` for large plans. |
| `list_sessions` shows old sessions | Sessions that were killed cannot close themselves. They fall out of the active list after 60 seconds and are harmless. |
