# DarkMechanicus

Local planning and execution coordination for agentic development: an **MCP server** for agents and an **Electron desktop app** for people, both operating on the same repository-owned state with the same rules.

An agent helps you shape an epic, decomposes it into tickets with acceptance criteria and capability profiles, wires dependencies and sprint checkpoints, and writes the plan as a draft. You review and edit the plan graph in the desktop app and press **Save**. An orchestrator agent then runs the saved revision: it claims ready tickets for its own workers, records submissions and acceptance, and stops at each sprint checkpoint until you approve.

- Product specification: [`docs/product-plan.md`](docs/product-plan.md)
- Implementation architecture: [`docs/architecture.md`](docs/architecture.md)
- Connecting an agent host: [`docs/runbooks/mcp-setup.md`](docs/runbooks/mcp-setup.md)
- Agents the app hosts (Claude Code, Codex, Cursor): [`docs/runbooks/agents.md`](docs/runbooks/agents.md)
- Handing a saved epic to Linear: [`docs/runbooks/linear-transfer.md`](docs/runbooks/linear-transfer.md)
- Working across a folder of Git repositories: [`docs/runbooks/multi-repo-folders.md`](docs/runbooks/multi-repo-folders.md)
- Signing in to GitHub for Source control: [`docs/runbooks/github-sign-in.md`](docs/runbooks/github-sign-in.md)
- Agent skills (provider-neutral, also served as MCP prompts): [`skills/`](skills/)

## Using it

1. **Track a folder** — press **+** in the sidebar and choose **Add existing folder…** to pick a repository, or **Clone repository…** to clone one (see [Source control](#source-control)). Each tracked folder expands into its **In progress** and **Backlog** epics, its **Kanban** board (with a count of open cards), its **Completed** epics, and its **Agents** chats.
2. **Initialize** — a new folder shows the setup screen, where you choose where its plans and history are stored:
   - **In this repository** (default) — initializing creates `.darkmechanicus/` (Git-tracked plans and history, plus a Git-ignored `local/` working database), so the plan travels with the code. Nothing is committed for you.
   - **Database only** — nothing at all is written into the repository: no `.darkmechanicus/`, no `.mcp.json`, no skills. Epics, tickets, plan revisions, run history and comments live in one machine-local database under `~/.darkmechanicus/projects/`, for a checkout whose history should not carry planning data. It stays on this machine, a clone sees none of it, and moving or renaming the folder orphans it — see the limitations in [`docs/decisions/0002-storage-modes.md`](docs/decisions/0002-storage-modes.md).
3. **Or drive it from a terminal** — `node out/main/cli.js --list` runs any command and prints JSON, with nothing configured in the agent's host (useful where an enterprise MCP policy blocks server registration). A `dm` session reads only until you issue it a role from the folder's **Agent access** card; see [Use the `dm` CLI](docs/runbooks/cli.md).
4. **Connect an agent host** — copy the MCP snippet from the setup screen into your agent host. The server runs headless: agents can plan and execute with the desktop closed. `--allow-save` lets an agent save plans; without it, you save in the app. Connect the agent session you work with as `orchestrator`: that role includes everything a planner can do, so the same session plans epics and runs them (see [the working model](docs/runbooks/mcp-setup.md#working-model-your-session-is-the-orchestrator)).
5. **Add an agent** — to work with an agent inside the app instead, press **+** next to **AGENTS** in the sidebar. **Find** a Skitarii (OMP, `omp`), Claude Code, Codex, Cursor or Autonomous (`a8s`) CLI that is already installed, **Download** one of the first three from its official source after a confirmation, or **Add a custom CLI**: any agent program and its arguments, run in a chat's terminal (you confirm its exact command first). Then **Sign in** with the CLI's own login (the app never sees a password). Open a chat from a folder's **Agents** group; it runs in that folder and its edits and commands wait for your approval in the chat. A folder's page can set its **Default agent**. Connecting, custom CLIs, sign-in prompts, approvals and troubleshooting are in [the agents runbook](docs/runbooks/agents.md).
6. **Plan** — agents (or you) edit a **draft**; the saved plan only changes on Save. Invalid edits are rejected with a concrete reason (cycles, a prerequisite in a later sprint, …). Reusable capability requirements live in named profiles (`.darkmechanicus/profiles/`): pick one with **Start from profile** in the ticket editor, or let agents use `list_profiles` and `save_profile`.
7. **Run** — press **Start run**, then either **Run with an agent** (one of the agents from step 4, signed in, with a model: it starts as the run's orchestrator in a chat you can follow, and it cannot save plans) or **Leave pending** (an external orchestrator, such as the session from step 3, picks the run up). If an agent's login expires, its run pauses and keeps its open leases until you sign in and resume ([details](docs/runbooks/agents.md#a-run-paused-for-sign-in)). An orchestrator can also start a run itself. Runs pin a saved revision; tickets become ready when their prerequisites are accepted.
8. **Checkpoint** — at the end of each sprint the orchestrator files a report; you review it and **Approve & advance**. The final checkpoint completes the epic, which then becomes read-only history that agents can search.
9. **Kanban** — an isolated ticket (one change, no prerequisites, nothing depending on it, done in one attempt) skips the epic: it is a card on the folder's **Kanban** board, with the lanes Backlog, In progress, Ready for review and Done. You (**New card**) or an agent (`create_kanban_card`) add cards to Backlog. Press **Play** to start an orchestrator chat, or explicitly ask an authorized external orchestrator to call `launch_kanban_cards` with named `cardIds` (one or several), without opening desktop chats. It then claims each card, has a worker do it on the checked-out branch, and submits it to Ready for review. Only you **Approve**, **Kick back** with a comment, or delete a card; agents cannot approve checkpoints either. Launch is atomic and duplicate pending launches are no-ops; active, submitted and completed work is protected. Cards are stored under `.darkmechanicus/kanban/` in a repository folder, or in the database only. See [the Kanban decision](docs/decisions/0004-kanban-cards.md) and [external launch](docs/runbooks/cli.md#launch-named-kanban-cards).
10. **Comment** — people and agents leave Markdown notes on tickets (the ticket panel's **Comments** tab, or `add_comment` over MCP): blockers, decisions, review notes. Comments travel with the repository and show up in history search.
11. **Hand off to Linear** — instead of running an epic here, press **Transfer to Linear** to move its saved plan, once, to a Linear project in execution order. An agent with Linear's own MCP server creates the project, milestones and issues and reads them back; a read-back that matches the plan completes the epic. Runs and Save are locked while the transfer is open. See [Transfer an epic to Linear](docs/runbooks/linear-transfer.md).

CI/CD mirrored from [CapitalGains](https://github.com/davgor/CapitalGains) (itself aligned with [AI-DND-Matrix](https://github.com/davgor/AI-DND-Matrix) packaging/deploy).

## Source control

Each folder's **Source control** tab works on the Git repository the folder is in, in the manner of GitHub Desktop: its changes (the working tree compared with HEAD) with their diffs, commits of whole files or of chosen lines and hunks, undo of the last unpushed commit, discard (a copy of what is discarded goes to the trash first), history, fetch, pull (merge only, never rebase) and push (never forced), branches and stashes, merge conflicts, clone (from the sidebar's **+** menu), and pull requests: the branch's pull request, the open ones to check out, and a link that creates one on GitHub. It writes to Git only when you ask; agents and MCP never reach it. The design is in [`docs/decisions/0005-source-control-in-main.md`](docs/decisions/0005-source-control-in-main.md).

- **Git on `PATH`.** It runs the `git` it finds on `PATH`; without one the view says that Source control needs Git on this computer.
- **Signing in.** GitHub features use this computer's GitHub CLI login: install the GitHub CLI (<https://cli.github.com>), run `gh auth login -h github.com` once, then press **Sign in to GitHub** at the bottom of the sidebar. The app copies the token `gh auth token` prints (it needs the `repo` scope; `workflow` to push workflow files) and keeps it encrypted with the OS (`safeStorage`) in `userData/github-account.json`. SSH remotes and other hosts use your machine's own credentials.
- **Signing out doesn't revoke.** **Sign out** deletes only the app's copy; the token stays valid on GitHub. To revoke it, run `gh auth logout -h github.com` or use **Manage access on GitHub** (<https://github.com/settings/applications>).

Details, scopes and troubleshooting: [Sign in to GitHub](docs/runbooks/github-sign-in.md).

## Engineering process

- **TDD-first.** Outside an epic, tests are written before the implementation that satisfies them for main/preload/renderer logic, shared helpers, and anything else with testable behavior. Inside an epic, tests-first applies only when the epic's plan states it; each ticket lists its tests, and its worker writes and runs them in that ticket. See `.cursor/skills/delivery-standards/SKILL.md`.
- **Strict lint.** oxlint with zero warnings. Rules are never relaxed to make code pass — fix the code. After edits: follow [`.ai-instructions.md`](.ai-instructions.md).
- **TypeScript strict mode.** No `any` escapes used to dodge a type problem.
- **No secrets committed.** `.env` stays gitignored.

AI/agent delivery rules: [`.ai-instructions.md`](.ai-instructions.md) and
[`.claude/skills/delivery-standards/SKILL.md`](.claude/skills/delivery-standards/SKILL.md).

## Planning workflow

This repository is planned and run in Dark Mechanicus itself. Its epics, tickets, plan revisions, history, and comments are the portable records in [`.darkmechanicus/`](.darkmechanicus/), tracked in Git next to the code.

- **Agents** connect through a project `.mcp.json` that runs the installed app's MCP server (see [`docs/runbooks/mcp-setup.md`](docs/runbooks/mcp-setup.md)). The role guides for planning, orchestrating, working, reviewing, and sprint reports are in [`skills/`](skills/); the server also serves them as MCP prompts.
- **The agent session you work with is the orchestrator.** Connect it with `--role orchestrator --allow-save`. When you ask it to run an epic, it runs it in that session: it claims each ready ticket, spins up a subagent as the worker, reviews the result, and stops at each sprint checkpoint for your approval. It never does a ticket itself, and it doesn't hand the run to another session.
- **Isolated tickets go on the Kanban board.** One change with no prerequisites and nothing depending on it, done in one attempt, becomes a card (`create_kanban_card`) instead of a new epic. Work that needs two or more tickets, ordering or sprints stays an epic.
- **People** review each draft plan in the desktop app and press **Save**, then approve every sprint checkpoint there.

Implementation follows the engineering process above: tests first (outside an epic, or when the epic's plan states it), then lint, typecheck, unit tests, fireguard, deadcode, and build. Inside an epic a ticket writes and runs the tests its **Tests** section lists and runs only its targeted checks; fireguard runs only when the epic's plan states it, and the full gate once at the sprint checkpoint.

## Stack

- Electron + React + TypeScript
- SQLite via built-in `node:sqlite` (one database per project, shared by the desktop and headless MCP processes: beside the records in the repository, or under `~/.darkmechanicus/projects/` for a database-only folder)
- `@modelcontextprotocol/sdk` stdio server, React Flow plan graph, zod validation
- electron-vite / electron-builder for build and packaging
- Vitest for unit tests
- oxlint for lint
- GitHub Actions for PR checks and release deploy (Win + Mac)

## Commands

For development without internet, see [Flight development](docs/runbooks/offline-development.md). Dependencies should already be installed in the prepared checkout; start with `npm run dev`.

```bash
npm install
npm run dev          # Electron + React dev
npm test             # Vitest (app + fireguard)
npm run fireguard    # Grade new unit tests (A–F); F fails CI
npm run lint         # oxlint (strict)
npm run typecheck
npm run build
npm run package:win  # Windows NSIS + portable
npm run package:mac  # macOS .dmg
npm run deadcode     # ts-prune vs .tsprune-ignore
npm run deadcode:refresh
npm run mcp -- --repo <path>   # headless stdio MCP server (after npm run build)
npm run dm -- --list           # the dm CLI: one command, JSON out (after npm run build)
npm run smoke:mcp    # drive the built MCP server end to end over stdio
npm run spike:claims # multi-process competing-claim stress proof
```

## CI

`.github/workflows/pr-checks.yml` (**CI Checks**) runs on every PR targeting `main` or `feature/**` and on every push to `main`:

- `test-shards` — four parallel Windows jobs: two native Vitest shards for app/scripts, two for Fireguard's own suite; each caps Vitest at two workers and uploads a JSON file inventory. The required `test` aggregate fails unless every shard succeeds.
- `fireguard-shards` — two parallel Ubuntu jobs grade disjoint flake runs (50 each of the configured 100) and changed production-module partitions, using one pinned HEAD/base. The required `fireguard` aggregate validates every report, sums raw mutation counts before grading, and alone posts/updates the sticky PR comment. Missing/failed shards and tool errors fail the check. See [shard reproduction](fireguard/README.md#ci-sharding).
- `lint` — `npm run lint`
- `build` — `npm run typecheck` && `npm run build`

Treat `test`, `fireguard`, `lint`, and `build` as **required status checks** in branch protection / rulesets for `main`.

CI does not collect coverage or enforce coverage thresholds. `npm run coverage` remains an opt-in local command with its existing thresholds. To reproduce a test shard locally, run `node node_modules/vitest/vitest.mjs run --config vitest.config.ts --shard 1/2 --maxWorkers 2`; repeat with `2/2` and with `--config fireguard/vitest.config.ts`. These four invocations collectively replace `npm test` in CI, not four copies of the full suite.

Also mirrored:

- `.github/workflows/deadcode.yml` — `ts-prune`; fails on new findings not listed in `.tsprune-ignore`
- `.github/workflows/security-audit.yml` — `npm audit`, fails PRs on moderate+ vulnerabilities
- `.github/workflows/deploy.yml` — after successful CI Checks on `main`, bumps minor version, packages Win + Mac, publishes a GitHub Release

Commits with `[skip ci]` in the message skip the push-triggered CI Checks / deadcode jobs and the deploy gate (used by version-bump commits so deploy does not loop).

## Releases / auto-update

Successful merges to `main` (CI Checks green, not `[skip ci]`) trigger **Deploy**:

1. Bump `package.json` minor (`0.0.1` → `0.1.0`) and push `chore: release vX.Y.Z [skip ci]`
2. Package on `windows-latest` (`DarkMechanicus-Setup-*.exe` NSIS + portable) and `macos-latest` (`.dmg`)
3. Create a GitHub Release with top-level `release/` files only (including `latest.yml` for updater)

macOS builds are ad-hoc signed (no Developer ID / notarization yet), so the first launch of a downloaded `.dmg` is blocked by Gatekeeper. See [first launch on macOS](docs/runbooks/auto-update.md#first-launch-on-macos).

In-app updates use `electron-updater` against GitHub Releases. See [`docs/runbooks/auto-update.md`](docs/runbooks/auto-update.md).
