---
name: delivery-standards
description: >-
  Enforces TDD-first implementation, lint/typecheck/unit-test/fireguard/
  deadcode/build verification, and Dark Mechanicus epic and ticket tracking
  for all code work in DarkMechanicus. Use for every feature, bug fix,
  refactor, or follow-up unless the user explicitly asks for a read-only
  answer with no code changes.
---

# Delivery standards (all implementation work)

This skill exists as two identical copies, `.claude/skills/delivery-standards/SKILL.md` and `.cursor/skills/delivery-standards/SKILL.md`. Keep them byte-identical when changing workflow rules.

Deploy/CI shape mirrored from [AI-DND-Matrix](https://github.com/davgor/AI-DND-Matrix).

## Standing rules

Any work you do going forward needs to have the lint, unit test, and build confirming, everything needs to be written TDD style, and it needs to be tracked in Dark Mechanicus: either a new epic, or a ticket on the existing epic it relates to.

Read `README.md` and `.ai-instructions.md` for process boundaries. For tickets already in scope, also follow the shipped role guides listed in section 1.

## 1. Dark Mechanicus tracking (before or as you start)

Work in this repository is planned and tracked as Dark Mechanicus epics and tickets. Their records live in `.darkmechanicus/` and are read and written through the `darkmechanicus` MCP server, which a project `.mcp.json` configures (that file is machine-specific, so it may not be in your checkout). Call `get_capabilities` first: it shows your role and what you may do. Never hand-edit `.darkmechanicus/` records, and if the server's tools are not available in your session, tell the person instead of working around it.

**You are the orchestrator.** Connect the Dark Mechanicus server for your session as `--role orchestrator --allow-save` (see [the working model](../../../docs/runbooks/mcp-setup.md#working-model-your-session-is-the-orchestrator)). When the person asks you to run an epic ("next epic", "complete the epic"), run it yourself in this session following the orchestrator guide. Don't hand it to another session. Spin up a subagent as the worker for each ticket you claim. You never do a ticket yourself. If `get_capabilities` reports `planner`, say so right away: the session has to be restarted with the orchestrator role before it can run anything.

The role guides shipped in `skills/` say how each job is done. Follow the one that matches your job:

| Job | Guide |
|-----|-------|
| Turn a goal into an epic with tickets, edited as a draft | [skills/planner.md](../../../skills/planner.md), with [skills/graph-planner.md](../../../skills/graph-planner.md) for sprints and dependencies |
| Run a saved plan: claim tickets, hand out packets, accept or reject results | [skills/orchestrator.md](../../../skills/orchestrator.md), with [skills/sprint-reporter.md](../../../skills/sprint-reporter.md) at each checkpoint |
| Do one claimed ticket from its execution packet | [skills/worker.md](../../../skills/worker.md) |
| Independently verify a submitted attempt | [skills/reviewer.md](../../../skills/reviewer.md) |

| Situation | Action |
|-----------|--------|
| User or orchestrator named a ticket or epic | Read it (`get_ticket`, `get_epic`, `list_comments`) and work it as the worker guide says, staying inside its acceptance criteria |
| Work extends an existing epic | Add a ticket on that epic through a planner draft (`create_ticket` or `update_plan_draft`, then `validate_plan`). A completed epic is read-only: create a new epic with `provenance` set to it instead |
| Standalone bug/feature/refactor | Create a new epic (`create_epic`) with success criteria, and plan its tickets as a draft |
| Exploratory spike with no code | Ticket optional; say so in the report |

**Planning drafts, then Save.** Plans are edited as drafts and execution reads only saved revisions. When the draft validates, either save it (only if your session has the `plan.save` capability and the person has seen the summary) or tell the person it is ready and ask them to review it in the desktop app and press Save. Do not claim tickets or start runs for work that is not saved.

**Ticket content** (what a planner draft must contain):

- `title`: imperative and specific
- `body`: context, what is in and out of scope, files to respect, how to verify. Files and commits go in `references`
- `acceptanceCriteria`: 2 to 6 checkable statements with observable results, and tests or runbook steps named explicitly where relevant
- `expectedArtifacts`: the files or reports the ticket must produce

**Every sprint gets a Fireguard ticket.** It requires every other work ticket in the sprint, and the sprint's acceptance ticket requires it. It runs `npm run fireguard` once on the combined, committed sprint work, with `FIREGUARD_BASE_REF` set to the sprint's start commit. It rewrites any test graded F without touching production code, and records the grade in its evidence. No other ticket runs fireguard. Example: DM-78 in the Scrum cadence epic.

Do not report a criterion as met until section 3 passes.

## 2. TDD-first implementation

For main/preload/renderer logic, shared helpers, and any code with testable behavior:

1. **Red** — write failing test(s) for the acceptance criterion or bug repro
2. **Green** — minimum code to pass
3. **Refactor** — only within scope; no drive-by changes

UI-only criteria: test-first when the criterion says "tested" or when extracting pure logic is natural; otherwise implement to the criterion and cover with component/logic tests when cheap. Prefer Vitest for unit/component coverage.

Standing code rules (never waive):

- TypeScript strict; no `any` to dodge types
- oxlint strict (`npm run lint`) — **fix code, never relax rules**
- Electron security baseline unchanged (contextIsolation, sandbox, narrow typed IPC)
- Minimize diff scope; match surrounding conventions
- No secrets committed; `.env` stays gitignored

## 3. Verification gate (required before done)

**When it runs.** Inside an epic, keep each ticket quick. A ticket runs only targeted checks: the tests it touched (`npx vitest run path/to/foo.test.ts`), plus lint and typecheck when it changed code. The full gate below runs **only at the checkpoint**: once, on the combined work, before you file the sprint report. Fireguard runs in the sprint's Fireguard ticket, just before the acceptance ticket, which takes its grade from there. Don't run the full gate or fireguard after any other ticket. Work outside an epic, such as a standalone fix, runs the full gate before it's done.

Run and fix until clean. **Do not report completion with failing checks.**

```bash
npm run lint
npm test
npm run fireguard   # in the sprint's Fireguard ticket (outside an epic: at the end) — letter grade A–F; F fails
npm run typecheck
npm run deadcode
npm run build
```

**Deadcode (`npm run deadcode`):** compares `ts-prune` output to `.tsprune-ignore` (also CI via `.github/workflows/deadcode.yml`). After intentional export moves/deletes, prefer unexporting truly unused symbols; if the ignore baseline drifts on known intentional exports, refresh with `npm run deadcode:refresh` and keep the diff reviewable. Do not skip this gate.

**Targeted tests during iteration** are fine (`npx vitest run path/to/foo.test.ts`). Whenever the full gate runs, it includes the full `npm test`, unless the user scoped a subset.

**Fireguard (unit-test quality):** Inside an epic, `npm run fireguard` runs only in the sprint's Fireguard ticket (see section 1). Outside an epic, run it once at the end of the work when the change adds or modifies Vitest unit tests (git diff vs `main`). It's slow, so never run it per ticket. Fireguard grades those tests (AST mock/tautology checks, 100× flake isolation, mutation on changed modules). A letter grade **F** is a delivery failure — rewrite the tests and re-grade. See `fireguard/README.md`.

**Native modules / Electron** (new `main`/`preload` wiring or native `.node` deps): unit tests under system Node are not enough — rebuild for Electron's ABI and exercise the path in the real app before calling the ticket done.

## 4. Close out

Evidence goes into the attempt submission (`submit_attempt`, or the same content handed to the orchestrator when you hold no claim token), not into checked boxes:

- `outputs`: `summary`, `artifacts`, `commits` (full hashes), `changedFiles`, `branch`
- `evidence.checks`: each of the section 3 checks with `passed`, `failed` or `skipped` and a short detail. Inside an epic, a ticket reports its targeted checks and marks the rest `skipped` with "full gate at the checkpoint"
- `evidence.criteria`: one entry per acceptance criterion with `met` and a `note` saying where it is shown (a test name, a command output, a file). Report an unmet criterion as `met: false` with the reason
- `evidence.notes`: limits, risks, suggested follow-ups

Leave status changes to the process: never accept or reject your own work, and never change ticket statuses or the plan. Acceptance belongs to the orchestrator or reviewer, and sprint approval to a person in the desktop app. A blocker you cannot resolve goes to `fail_attempt`, and a decision or question that should outlive the attempt goes to `add_comment`.

Summarize in your report: what changed, test/lint/build output, ticket ids touched. Do **not** commit unless the user explicitly asks, or the execution packet or orchestrator tells you to commit.

## Quick checklist

Copy and track:

```
Delivery:
- [ ] Work is tracked in Dark Mechanicus: new epic, or ticket on an existing epic (draft saved or handed over for Save)
- [ ] Failing test(s) written first (where applicable)
- [ ] Implementation complete
- [ ] Inside an epic: targeted checks for this ticket pass. Fireguard runs in the sprint's Fireguard ticket, and the rest of the gate below runs only at the checkpoint
- [ ] npm run lint — pass
- [ ] npm test — pass
- [ ] npm run fireguard — pass / not F (when unit tests added/modified)
- [ ] npm run typecheck — pass
- [ ] npm run deadcode — pass
- [ ] npm run build — pass
- [ ] Evidence recorded in the attempt submission, per criterion, only for what was verified
```
