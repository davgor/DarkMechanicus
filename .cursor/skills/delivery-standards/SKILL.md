---
name: delivery-standards
description: >-
  Enforces TDD-first implementation, lint/unit-test/build verification, and
  /board ticket or epic updates for all code work in DarkMechanicus. Use for
  every feature, bug fix, refactor, or follow-up unless the user explicitly
  asks for a read-only answer with no code changes.
---

# Delivery standards (all implementation work)

Mirrors `.claude/skills/delivery-standards/SKILL.md` — keep both in sync when changing workflow rules.

Epic-flow process mirrored from [davgor.github.io](https://github.com/davgor/davgor.github.io). Deploy/CI shape mirrored from [AI-DND-Matrix](https://github.com/davgor/AI-DND-Matrix).

## Standing rules

Any work you do going forward needs to have the lint, unit test, and build confirming, everything needs to be written TDD style, and you either need to create a ticket, or update an epic if it relates.

Read `README.md` and `.ai-instructions.md` for process boundaries. For board tickets already in scope, also follow [complete-ticket](../complete-ticket/SKILL.md).

## 1. Board tracking (before or as you start)

Every implementation task must be traceable on `/board`:

| Situation | Action |
|-----------|--------|
| User named a ticket/epic id | Use [complete-ticket](../complete-ticket/SKILL.md): move to `in-progress`, check off criteria when verified |
| Work extends an existing epic | Add or update a sub-ticket under that epic (`NNN.M`), update the epic index file, move to `in-progress` when starting |
| Standalone bug/feature/refactor | Create a new epic or sub-ticket in `/board/backlog/` with Description + checkable Acceptance Criteria |
| Exploratory spike with no code | Ticket optional; say so in the report |

**Ticket format** (match existing files):

```markdown
# EPIC: Short title   (or # 048.1 — Sub-ticket title)

Description paragraph: what, why, dependencies.

## Acceptance criteria

- [ ] Observable behavior with verification method
- [ ] Tests / runbook step named explicitly where relevant
```

Do not check off criteria or move tickets to `done/` until section 3 passes.

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

Run and fix until clean. **Do not report completion with failing checks.**

```bash
npm run lint
npm test
npm run fireguard   # when adding/changing unit tests — letter grade A–F; F fails
npm run typecheck
npm run deadcode
npm run build
```

**Deadcode (`npm run deadcode`):** compares `ts-prune` output to `.tsprune-ignore` (also CI via `.github/workflows/deadcode.yml`). After intentional export moves/deletes, prefer unexporting truly unused symbols; if the ignore baseline drifts on known intentional exports, refresh with `npm run deadcode:refresh` and keep the diff reviewable. Do not skip this gate.

**Targeted tests during iteration** are fine (`npx vitest run path/to/foo.test.ts`), but **finish with full `npm test`** unless the user scoped a subset.

**Fireguard (unit-test quality):** After unit tests pass, run `npm run fireguard` whenever the change adds or modifies Vitest unit tests (git diff vs `main`). Fireguard grades those tests (AST mock/tautology checks, 100× flake isolation, mutation on changed modules). A letter grade **F** is a delivery failure — rewrite the tests and re-grade. See `fireguard/README.md`.

**Native modules / Electron** (new `main`/`preload` wiring or native `.node` deps): unit tests under system Node are not enough — rebuild for Electron's ABI and exercise the path in the real app before calling the ticket done.

## 4. Close out

- Check off verified acceptance criteria (`- [x]`)
- `git mv` ticket to `/board/done/` when all criteria met
- Summarize: what changed, test/lint/build output, ticket ids touched
- Do **not** commit unless the user explicitly asks

## Quick checklist

Copy and track:

```
Delivery:
- [ ] Ticket/epic created or updated on /board
- [ ] Failing test(s) written first (where applicable)
- [ ] Implementation complete
- [ ] npm run lint — pass
- [ ] npm test — pass
- [ ] npm run fireguard — pass / not F (when unit tests added/modified)
- [ ] npm run typecheck — pass
- [ ] npm run deadcode — pass
- [ ] npm run build — pass
- [ ] Acceptance criteria checked off only when verified
```
