# DarkMechanicus

Electron desktop app (TypeScript + React) — a dark factory shell for coding projects.

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
- electron-vite / electron-builder for build and packaging
- Vitest for unit tests
- oxlint for lint
- GitHub Actions for PR checks and release deploy (Win + Mac)

## Commands

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

In-app updates use `electron-updater` against GitHub Releases. See [`docs/runbooks/auto-update.md`](docs/runbooks/auto-update.md).
