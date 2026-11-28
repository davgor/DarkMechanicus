# DarkMechanicus

Local planning and execution coordination for agentic development: an **MCP server** for agents and an **Electron desktop app** for people, both operating on the same repository-owned state with the same rules.

An agent helps you shape an epic, decomposes it into tickets with acceptance criteria and capability profiles, wires dependencies and sprint checkpoints, and writes the plan as a draft. You review and edit the plan graph in the desktop app and press **Save**. An orchestrator agent then runs the saved revision: it claims ready tickets for its own workers, records submissions and acceptance, and stops at each sprint checkpoint until you approve.

- Product specification: [`docs/product-plan.md`](../docs/product-plan.md)
- Implementation architecture: [`docs/architecture.md`](../docs/architecture.md)
- Proposed agent-desktop integration: [`docs/design/agent-desktop-integration.md`](../docs/design/agent-desktop-integration.md)
- Connecting an agent host: [`docs/runbooks/mcp-setup.md`](../docs/runbooks/mcp-setup.md)
- Agents the app hosts (Claude Code, Codex, Cursor): [`docs/runbooks/agents.md`](../docs/runbooks/agents.md)
- Handing a saved epic to Linear: [`docs/runbooks/linear-transfer.md`](../docs/runbooks/linear-transfer.md)
- Working across a folder of Git repositories: [`docs/runbooks/multi-repo-folders.md`](../docs/runbooks/multi-repo-folders.md)
- Signing in to GitHub for Source control: [`docs/runbooks/github-sign-in.md`](../docs/runbooks/github-sign-in.md)
- Orchestrator knowledge layers and authoring facts: [`docs/runbooks/knowledge.md`](../docs/runbooks/knowledge.md)
- Agent skills (provider-neutral, also served as MCP prompts): [`skills/`](../skills/)

## Using it

1. **Track a folder** — press **+** in the sidebar and choose **Add existing folder…** to pick a repository, or **Clone repository…** to clone one (see [Source control](#source-control)). Each tracked folder expands into its **In progress** and **Backlog** epics, its **Kanban** board (with a count of open cards), its **Completed** epics, and its **Agents** chats.
   The Kanban count includes Backlog, In progress and Ready for review only. Approving or deleting a card updates it immediately; completed cards stay available in the paged Done lane without increasing the open count.
2. **Initialize** — a new folder shows the setup screen, where you choose where its plans and history are stored:
   - **In this repository** (default) — initializing creates `.darkmechanicus/` (Git-tracked plans and history, plus a Git-ignored `local/` working database), so the plan travels with the code. Nothing is committed for you.
   - **Database only** — nothing at all is written into the repository: no `.darkmechanicus/`, no `.mcp.json`, no skills. Epics, tickets, plan revisions, run history and comments live in one machine-local database under `~/.darkmechanicus/projects/`, for a checkout whose history should not carry planning data. It stays on this machine, a clone sees none of it, and moving or renaming the folder orphans it — see the limitations in [`docs/decisions/0002-storage-modes.md`](../docs/decisions/0002-storage-modes.md).
   - **Change it later** — the folder’s **Storage** card offers a confirmed switch in either direction. It verifies the destination before deleting the old store. Finish active work and close other sessions first; repository-to-database switching requires committed `.darkmechanicus/` records and deletes that entire directory (including `local/`) and DM’s ignore entry. `.mcp.json`, installed skills and past Git history are left alone. [Migration and interruption safety](../docs/decisions/0002-storage-modes.md#switching-an-existing-folder).
3. **Or drive it from a terminal** — `node out/main/cli.js --list` runs any command and prints JSON, with nothing configured in the agent's host (useful where an enterprise MCP policy blocks server registration). A `dm` session reads only until you issue it a role from the folder's **Agent access** card; see [Use the `dm` CLI](../docs/runbooks/cli.md).
4. **Connect an agent host** — copy the MCP snippet from the setup screen into your agent host. The server runs headless: agents can plan and execute with the desktop closed. `--allow-save` lets an agent save plans; without it, you save in the app. Connect the agent session you work with as `orchestrator`: that role includes everything a planner can do, so the same session plans epics and runs them (see [the working model](../docs/runbooks/mcp-setup.md#working-model-your-session-is-the-orchestrator)).
5. **Add an agent** — to work with an agent inside the app instead, press **+** next to **AGENTS** in the sidebar. **Find** a Skitarii (OMP, `omp`), Claude Code, Codex, Cursor or Autonomous (`a8s`) CLI that is already installed, **Download** one of the first three from its official source after a confirmation, or **Add a custom CLI**: any agent program and its arguments, run in a chat's terminal (you confirm its exact command first). Then **Sign in** with the CLI's own login (the app never sees a password). Press the folder's **Agents +**, enter the first prompt in the popup, then **Start**. Cancel creates nothing. The complete prompt is saved and submitted once when the CLI is ready; the selected agent infers a short intent title through a narrow authenticated metadata channel, with no extra model account. Later input belongs in the terminal, not an app composer. A folder's page can set its **Default agent**. Connecting, custom CLIs, sign-in prompts, approvals and troubleshooting are in [the agents runbook](../docs/runbooks/agents.md).
   - **Every chat under its agent, and agents with no project** — each agent's row in **AGENTS** expands (its chevron) to list all its chats that are not deleted, newest first, labelled with their folder or **No project**; open, rename and delete them there. The row's **+** summons the agent **without a project**: a chat in its own scratch folder under app data, as an orchestrator with Allow save holding one grant in **every** tracked, set-up folder, so it can read and change all of their records (wide open by design; the server still checks each grant). Folders tracked later are reached from its next start. See [Every chat under its agent](../docs/runbooks/agents.md#every-chat-under-its-agent-and-agents-with-no-project).
6. **Plan** — agents (or you) edit a **draft**; the saved plan only changes on Save. Invalid edits are rejected with a concrete reason (cycles, a prerequisite in a later sprint, …). Reusable capability requirements live in named profiles (`.darkmechanicus/profiles/`): pick one with **Start from profile** in the ticket editor, or let agents use `list_profiles` and `save_profile`.
7. **Run** — press **Start run**, then either **Run with an agent** (one of the agents from step 4, signed in, with a model: it starts as the run's orchestrator in a chat you can follow, and it cannot save plans) or **Leave pending** (an external orchestrator, such as the session from step 3, picks the run up). If an agent's login expires, its run pauses and keeps its open leases until you sign in and resume ([details](../docs/runbooks/agents.md#a-run-paused-for-sign-in)). An orchestrator can also start a run itself. Runs pin a saved revision; tickets become ready when their prerequisites are accepted.
8. **Checkpoint** — at the end of each sprint the orchestrator files a report; you review it and **Approve & advance**. The final checkpoint completes the epic, which then becomes read-only history that agents can search.
9. **Kanban** — an isolated ticket (one change, no prerequisites, nothing depending on it, done in one attempt) skips the epic: it is a card on the folder's **Kanban** board, with the lanes Backlog, In progress, Ready for review and Done. You (**New card**) or an agent (`create_kanban_card`) add cards to Backlog. Press **Play** to start an orchestrator chat, or explicitly ask an authorized external orchestrator to call `launch_kanban_cards` with named `cardIds` (one or several), without opening desktop chats. It then claims each card, has a worker do it on the checked-out branch, and submits it to Ready for review. Only you **Approve**, **Kick back** with a comment, or delete a card; agents cannot approve checkpoints either. Launch is atomic and duplicate pending launches are no-ops; active, submitted and completed work is protected. Cards are stored under `.darkmechanicus/kanban/` in a repository folder, or in the database only. See [the Kanban decision](../docs/decisions/0004-kanban-cards.md) and [external launch](../docs/runbooks/cli.md#launch-named-kanban-cards).
10. **Comment** — people and agents leave Markdown notes on tickets (the ticket panel's **Comments** tab, or `add_comment` over MCP): blockers, decisions, review notes. Comments travel with the repository and show up in history search.
11. **Hand off to Linear** — instead of running an epic here, press **Transfer to Linear** to move its saved plan, once, to a Linear project in execution order. An agent with Linear's own MCP server creates the project, milestones and issues and reads them back; a read-back that matches the plan completes the epic. Runs and Save are locked while the transfer is open. See [Transfer an epic to Linear](../docs/runbooks/linear-transfer.md).
12. **Skitarii mail** — Skitarii chats in one folder can message each other: durable, local-only direct messages and replies through native tools (`dm_agent_peers`, `dm_message_send`, `dm_inbox_read`, `dm_inbox_ack`). New full bodies arrive automatically in idle, busy or resumed same-chat contexts; automatic turns may spend tokens. **Messages** shows insertion progress/blockers separately from what you have not seen and what its agent has not explicitly acknowledged. Mail is not in Git and cannot be rebuilt from records: back up the local database before any rebuild. See [Skitarii mail](../docs/runbooks/agents.md#skitarii-mail), the [design record](../docs/design/skitarii-messaging.md) and its [current verification procedure](../docs/design/skitarii-messaging.md#verification).

### Optional scoped YOLO

Agent access defaults are unchanged. For a named **active chat**, **Enable YOLO…** opens a main-owned native warning naming its grant, chat start, folder, current run, exact powers and fixed expiry. Only a live person's native confirmation enables it; chat text, CLI/MCP requests and renderer booleans do not. Cancel is the default.

YOLO adds only plan Save, retry grant and checkpoint approve/advance within that bound scope; it does not change the role to desktop, waive evidence gates, approve Kanban cards, issue/revoke grants, manage mail, record human feedback, export all mail, expose credentials or grant OS permissions. It permits unreviewed workflow changes: enable only if you accept that risk. **Revoke YOLO** stops elevated commands immediately; revoking the parent grant does too. It ends on chat exit, a new chat generation, desktop restart, or the earlier of 24 hours and the parent grant's expiry at approval. Parent renewals do not renew consent.

Every elevated command verifies a main-owned desktop-instance fence and obtains a fresh, domain-separated signed challenge from that specific live desktop. The ephemeral signing key stays only in main; a live or reused PID alone grants nothing. Missing/unreadable fences, replaced instances, closed endpoints, wrong signatures and dead processes deny elevation even if the folder was unavailable at startup. Scope, revocation and expiry are checked again after the challenge. Startup does not open every tracked folder to invalidate former approvals.

The expandable audit is a local, durable append-only ledger, including admitted-command failures without payloads, secrets or raw errors. An interrupted process may leave an `admitted` entry without a result; this is not proof of success. Audit survives revocation/restart but is not exported into portable history automatically. Affected run retros contain the server-derived complete run log through report submission; later commands appear in subsequent reports and the live audit. Agents must supply one specific safer-role recommendation for each used elevated capability in retro Actions, using `[YOLO plan.save] planner: proposed scope and reason` (substitute the capability and planner/orchestrator/worker/reviewer role). These suggestions grant no authority. Kanban-only submissions use the same recommendation lines in completion-evidence notes; the server appends complete card history across its grants and attempts through submission, ordered by audit ID, instead of inventing a sprint retro. Clock rollback does not omit earlier or current card usage, and unrelated cards are excluded.

Elevated workflow commands use the ordinary `dm` CLI (`save_plan`, `grant_retry`, `approve_checkpoint`, `approve_and_advance`, `advance_sprint`); `get_capabilities` reports separate eligible `yolo` scope while its role/capabilities remain unchanged, explicitly requiring a fresh desktop challenge on actual admission. Discovery alone is not authorization. The MCP tool catalogue remains role-filtered and does not advertise these extra desktop workflow tools. Use the desktop-bound CLI grant for elevated workflow, not a different MCP session.

CI/CD mirrored from [CapitalGains](https://github.com/davgor/CapitalGains) (itself aligned with [AI-DND-Matrix](https://github.com/davgor/AI-DND-Matrix) packaging/deploy).

## Source control

Each folder's **Source control** tab works on the Git repository the folder is in, in the manner of GitHub Desktop: its changes (the working tree compared with HEAD) with their diffs, commits of whole files or of chosen lines and hunks, undo of the last unpushed commit, discard (a copy of what is discarded goes to the trash first), history, fetch, pull (merge only, never rebase) and push (never forced), branches and stashes, merge conflicts, clone (from the sidebar's **+** menu), and pull requests: the branch's pull request, the open ones to check out, and a link that creates one on GitHub. It writes to Git only when you ask; agents and MCP never reach it. The design is in [`docs/decisions/0005-source-control-in-main.md`](../docs/decisions/0005-source-control-in-main.md).

- **Git on `PATH`.** It runs the `git` it finds on `PATH`; without one the view says that Source control needs Git on this computer.
- **Signing in.** GitHub features use this computer's GitHub CLI login: install the GitHub CLI (<https://cli.github.com>), run `gh auth login -h github.com` once, then press **Sign in to GitHub** at the bottom of the sidebar. The app copies the token `gh auth token` prints (it needs the `repo` scope; `workflow` to push workflow files) and keeps it encrypted with the OS (`safeStorage`) in `userData/github-account.json`. SSH remotes and other hosts use your machine's own credentials.
- **Signing out doesn't revoke.** **Sign out** deletes only the app's copy; the token stays valid on GitHub. To revoke it, run `gh auth logout -h github.com` or use **Manage access on GitHub** (<https://github.com/settings/applications>).

Details, scopes and troubleshooting: [Sign in to GitHub](../docs/runbooks/github-sign-in.md).

## Engineering process

- **TDD-first.** Outside an epic, tests are written before the implementation that satisfies them for main/preload/renderer logic, shared helpers, and anything else with testable behavior. Inside an epic, tests-first applies only when the epic's plan states it; each ticket lists its tests, and its worker writes and runs them in that ticket. See `.cursor/skills/delivery-standards/SKILL.md`.
- **Strict lint.** oxlint with zero warnings. Rules are never relaxed to make code pass — fix the code. After edits: follow [`.ai-instructions.md`](../.ai-instructions.md).
- **TypeScript strict mode.** No `any` escapes used to dodge a type problem.
- **No secrets committed.** `.env` stays gitignored.

AI/agent delivery rules: [`.ai-instructions.md`](../.ai-instructions.md) and
[`.claude/skills/delivery-standards/SKILL.md`](../.claude/skills/delivery-standards/SKILL.md).

## Forge World repository discovery

When a code repository moves its tickets into a Forge World, Dark Mechanicus leaves `.forge-world.json` in the code repository:

```json
{
  "version": 1,
  "worldRepository": "https://github.com/owner/Forge-World.git",
  "projectFolder": "MyProject"
}
```

Commit this file with the code so it travels to another computer. Opening that code repository in Dark Mechanicus retrieves or reuses the named Forge World, verifies that its project points back to the code repository's GitHub origin, and connects the checkout to those tickets. It does not initialize a second ticket store in the code repository. GitHub sign-in must allow access to a private world.

Existing `FORGE-WORLD.md` pointers remain supported and gain the JSON configuration when opened. If both files exist, they must identify the same world and project; conflicting files are left unchanged for correction. Restoring tickets to local storage removes both pointers. Local checkout paths and agent credentials stay on the current computer.

Forge World sync commits and pushes all tracked and nonignored files in the dedicated world repository, including recovered attachments, documentation, repository directions, and deletions. `.darkmechanicus/local/` is always private, even if it is accidentally staged. Ordinary Git ignore rules continue to exclude local scratch files.

At startup, Dark Mechanicus checks every tracked Forge World independently. The same health check runs when a world is opened or synced, including after creating or converting projects. It validates the manifest, member ticket metadata, and any available local code checkout. Missing local code is normal on another computer and does not trigger cloning. A verified old checkout gains missing portable configuration and legacy pointers; conflicting paths, repository URLs, or pointers are reported in that world's sync status and are not overwritten. Missing manifest mappings are recovered only when an existing local checkout and its portable pointer identify the exact world and project.

`FORGE-REPOSITORIES.md` contains a versioned, marked section maintained by the app. Future versions can update that section while preserving custom prose before and after it; a fully custom guide receives a separate maintained section. Malformed section markers require correction rather than a destructive rewrite. Existing valid local bindings keep their identity on repeated checks.

Development contract: new Forge requirements belong in the shared `ensureForgeWorld` health path and its startup, existing-world upgrade, idempotence, and second-computer tests. Extend the marked instructions there when guidance changes. Do not implement upgrades only in new-world creation, depend on the developer's live Forge World, or guess missing repository mappings.

## Planning workflow

This repository is planned and run in Dark Mechanicus itself. Its epics, tickets, plan revisions, history, and comments are the portable records in [`.darkmechanicus/`](../.darkmechanicus/), tracked in Git next to the code.

- **Agents** connect through a project `.mcp.json` that runs the installed app's MCP server (see [`docs/runbooks/mcp-setup.md`](../docs/runbooks/mcp-setup.md)). The role guides for planning, orchestrating, working, reviewing, and sprint reports are in [`skills/`](../skills/); the server also serves them as MCP prompts.
- **The agent session you work with is the orchestrator.** Connect it with `--role orchestrator --allow-save`. When you ask it to run an epic, it runs it in that session: it claims each ready ticket, spins up a subagent as the worker, reviews the result, and stops at each sprint checkpoint for your approval. It never does a ticket itself, and it doesn't hand the run to another session.
- **Isolated tickets go on the Kanban board.** One change with no prerequisites and nothing depending on it, done in one attempt, becomes a card (`create_kanban_card`) instead of a new epic. Work that needs two or more tickets, ordering or sprints stays an epic.
- **Every advanced sprint leaves one learning card.** Advancing a checkpoint queues a generated sprint learning card for the same orchestrator, which claims it before ordinary next-sprint polling and runs it as one worker job on isolated `learnings/<cardKey>/<repo|root>` branches; it never holds up the next sprint. The card stops at Ready for review: only your approval in the desktop app integrates every affected repository and publishes its learnings, which you manage (retire or replace) in **Knowledge → Learnings**. See [`docs/runbooks/knowledge.md`](runbooks/knowledge.md#the-sprint-learning-card).
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

For development without internet, see [Flight development](../docs/runbooks/offline-development.md). Dependencies should already be installed in the prepared checkout; start with `npm run dev`.

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

- `shard-plan` — selects independent counts for app/scripts Vitest, Fireguard Vitest, and Fireguard grading. It logs the policy and selected counts and uploads `ci-shard-plan.json`, including each source run ID and its per-shard execution seconds when available.
- `test-shards` — disjoint native Windows Vitest shards for each configuration. Each job caps Vitest at two workers and uploads its JSON test inventory. The `test` aggregate fails unless the plan and every shard succeed.
- `fireguard-shards` — disjoint Ubuntu jobs split the 100 flake runs and changed-module mutation work over one pinned HEAD/base. The `fireguard` aggregate requires the plan, scope and all grading jobs, validates the entire report set, and alone updates the sticky PR comment. See [shard reproduction](../fireguard/README.md#ci-sharding).
- `lint` — `npm run lint`
- `build` — `npm run typecheck` && `npm run build`

Treat `test`, `fireguard`, `lint`, and `build` as the stable CI gate names when configuring required status checks. Coverage is not a GitHub job or artifact; `npm run coverage` still enforces the same local thresholds.

### Shard sizing

Each suite independently uses its latest complete CI sample: `ceil(sum of shard execution seconds / 120)`, clamped to **1–16** per suite (at most 32 Windows jobs and 16 grading jobs, below GitHub's 256-job limit per matrix). The planner reads named execution-step timestamps, not queue time, dependency installation, or installer-tool preparation. Step wall time includes startup, test/grading setup and any reporting within the execution command.

For each unit suite, the planner looks at the latest eight successful first-attempt default-branch push runs of **CI Checks**, including the legacy two-shard unit jobs. Grading time follows the graded diff, so a pull request's grading is sized only from up to eight earlier successful first-attempt runs of **the same pull request branch** (from this repository, to the default branch); every shard must mark that it completed a nonempty flake workload. Another branch's grade is never a sample: one pull request's one-file grade once sized a 107-module sprint diff to one serial shard. Pushes, fork pull requests and a branch's first run have no grading sample. Empty-scope pushes and unmarked legacy grades are not active samples. The planner reads only bounded GitHub job metadata, not executable artifacts. Missing, partial, inconsistent, or unavailable observations fall back independently: two shards per unit suite; grading uses the measured legacy baseline of 1,898 execution seconds ([run 45328911368](https://github.com/davgor/DarkMechanicus/actions/runs/45328911368)), which plans 16 shards.

The branch's sample timed an earlier diff, which may have grown since. `fireguard-scope` counts the files the graded diff adds or modifies under `src`, `lib` and `app` (Fireguard's roots), and the grading matrix has at least one shard per counted file, up to the cap. A diff with none of those files grades nothing and gets one shard.

This is a target for the estimated average, not a per-job deadline. Vitest does not split individual test files, and a complete flake repetition and the mutation work for one production module each stay together. Fixed setup, uneven partitions, workload changes (especially PR grading scope) and the matrix cap can all push individual shards above 120 seconds. All work is still assigned.

To reproduce a unit matrix entry locally, run `node node_modules/vitest/vitest.mjs run --config <config> --shard <index>/<count> --maxWorkers 2`, substituting the values in `ci-shard-plan.json`. Run every entry with its specified configuration/count to reproduce the whole CI unit gate.

For a local Windows fixture-rename `EPERM`, follow the [deployment verification procedure](runbooks/auto-update.md#local-windows-eperm-during-verification), preserving the failed local result separately from exact-revision CI evidence.

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

macOS builds are ad-hoc signed (no Developer ID / notarization yet), so the first launch of a downloaded `.dmg` is blocked by Gatekeeper. See [first launch on macOS](../docs/runbooks/auto-update.md#first-launch-on-macos).

In-app updates use `electron-updater` against GitHub Releases. See [`docs/runbooks/auto-update.md`](../docs/runbooks/auto-update.md).
