# DarkMechanicus

Local planning and execution coordination for agentic development: an **MCP server** for agents and an **Electron desktop app** for people, both operating on the same repository-owned state with the same rules.

An agent helps you shape an epic, decomposes it into tickets with acceptance criteria and capability profiles, wires dependencies and sprint checkpoints, and writes the plan as a draft. You review and edit the plan graph in the desktop app and press **Save**. An orchestrator agent then runs the saved revision: it claims ready tickets for its own workers, records submissions and acceptance, and stops at each sprint checkpoint until you approve.

- Product specification: [`docs/product-plan.md`](docs/product-plan.md)
- Implementation architecture: [`docs/architecture.md`](docs/architecture.md)
- Connecting an agent host: [`docs/runbooks/mcp-setup.md`](docs/runbooks/mcp-setup.md)
- Agent skills (provider-neutral, also served as MCP prompts): [`skills/`](skills/)

## Using it

1. **Track a folder** — press **+** in the sidebar and pick a repository. Each tracked folder expands into **In progress**, **Backlog**, and **Completed** epics.
2. **Initialize** — a new folder shows the setup screen; initializing creates `.darkmechanicus/` (Git-tracked plans and history, plus a Git-ignored `local/` working database). Nothing is committed for you.
3. **Connect an agent** — copy the MCP snippet from the setup screen into your agent host. The server runs headless: agents can plan and execute with the desktop closed. `--allow-save` lets an agent save plans; without it, you save in the app.
4. **Plan** — agents (or you) edit a **draft**; the saved plan only changes on Save. Invalid edits are rejected with a concrete reason (cycles, a prerequisite in a later sprint, …). Reusable capability requirements live in named profiles (`.darkmechanicus/profiles/`): pick one with **Start from profile** in the ticket editor, or let agents use `list_profiles` and `save_profile`.
5. **Run** — press **Start run** (or let the orchestrator start one). Runs pin a saved revision; tickets become ready when their prerequisites are accepted.
6. **Checkpoint** — at the end of each sprint the orchestrator files a report; you review it and **Approve & advance**. The final checkpoint completes the epic, which then becomes read-only history that agents can search.
7. **Comment** — people and agents leave Markdown notes on tickets (the ticket panel's **Comments** tab, or `add_comment` over MCP): blockers, decisions, review notes. Comments travel with the repository and show up in history search.

Epic-flow process and CI/CD mirrored from [CapitalGains](https://github.com/davgor/CapitalGains) (itself aligned with [AI-DND-Matrix](https://github.com/davgor/AI-DND-Matrix) packaging/deploy).

## Engineering process

- **TDD-first.** Tests are written before the implementation that satisfies them for main/preload/renderer logic, shared helpers, and anything else with testable behavior. See `.cursor/skills/delivery-standards/SKILL.md`.
- **Strict lint.** oxlint with zero warnings. Rules are never relaxed to make code pass — fix the code. After edits: follow [`.ai-instructions.md`](.ai-instructions.md).
- **TypeScript strict mode.** No `any` escapes used to dodge a type problem.
- **Ticket board.** Work is tracked as markdown tickets under `/board` (`backlog/` → `in-progress/` → `done/`). Epics are `NNN-*.md`, sub-tickets `NNN.M-*.md`, each with checkable acceptance criteria. The `complete-ticket` and `collapse-epic` skills in `.cursor/skills/` (mirrored in `.claude/skills/`) drive the workflow.
- **No secrets committed.** `.env` stays gitignored.

AI/agent delivery rules: [`.ai-instructions.md`](.ai-instructions.md) and
[`.claude/skills/delivery-standards/SKILL.md`](.claude/skills/delivery-standards/SKILL.md).

## Board workflow

Work is tracked as markdown tickets under [`board/`](board/):

- `board/backlog/` — not started
- `board/in-progress/` — active
- `board/done/` — completed (epics may collapse sub-tickets)

Each ticket has a description and checkable acceptance criteria. Implementation follows TDD, then lint, unit tests, typecheck, deadcode, and build before criteria are checked off. See the [complete-ticket](.claude/skills/complete-ticket/SKILL.md) skill for the full flow.

## Stack

- Electron + React + TypeScript
- SQLite via built-in `node:sqlite` (one repository-local database shared by the desktop and headless MCP processes)
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
npm run smoke:mcp    # drive the built MCP server end to end over stdio
npm run spike:claims # multi-process competing-claim stress proof
```

## CI

`.github/workflows/pr-checks.yml` (**CI Checks**) runs on every PR targeting `main` and on every push to `main`:

- `test` — `npm test` (app Vitest + fireguard's own suite)
- `fireguard` — grades **new** Vitest unit tests vs `main` (AST + 100× flake + mutation); letter **F** fails the job; posts/updates a sticky PR comment with the grade
- `lint` — `npm run lint`
- `build` — `npm run typecheck` && `npm run build`

Treat `test`, `fireguard`, `lint`, and `build` as **required status checks** in branch protection / rulesets for `main`.

Also mirrored:

- `.github/workflows/deadcode.yml` — `ts-prune`; fails on new findings not listed in `.tsprune-ignore`
- `.github/workflows/security-audit.yml` — `npm audit`, fails PRs on moderate+ vulnerabilities
- `.github/workflows/auto-revert.yml` — reverts `main` when CI Checks fails (skips if HEAD is already a revert)
- `.github/workflows/deploy.yml` — after successful CI Checks on `main`, bumps minor version, packages Win + Mac, publishes a GitHub Release

Commits with `[skip ci]` in the message skip the push-triggered CI Checks / deadcode jobs and the deploy gate (used by version-bump commits so deploy does not loop).

## Releases / auto-update

Successful merges to `main` (CI Checks green, not `[skip ci]`) trigger **Deploy**:

1. Bump `package.json` minor (`0.0.1` → `0.1.0`) and push `chore: release vX.Y.Z [skip ci]`
2. Package on `windows-latest` (`DarkMechanicus-Setup-*.exe` NSIS + portable) and `macos-latest` (`.dmg`)
3. Create a GitHub Release with top-level `release/` files only (including `latest.yml` for updater)

macOS builds are ad-hoc signed (no Developer ID / notarization yet), so the first launch of a downloaded `.dmg` is blocked by Gatekeeper. See [first launch on macOS](docs/runbooks/auto-update.md#first-launch-on-macos).

In-app updates use `electron-updater` against GitHub Releases. See [`docs/runbooks/auto-update.md`](docs/runbooks/auto-update.md).
