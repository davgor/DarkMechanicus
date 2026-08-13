# EPIC: Engineering delivery standards

Mirror CapitalGains delivery process: TDD-first, oxlint/Vitest/typecheck/deadcode/build verification gate, `/board` ticket board, and always-apply Cursor/Claude skills.

## Acceptance criteria

- [x] `.cursor/skills/delivery-standards/SKILL.md` and `.claude/skills/delivery-standards/SKILL.md` exist and stay in sync
- [x] `complete-ticket` and `collapse-epic` skills exist under both `.cursor/skills/` and `.claude/skills/`
- [x] `.cursor/rules/delivery-standards.mdc` is `alwaysApply: true`
- [x] `.ai-instructions.md` lists the mandatory post-edit verification commands
- [x] `board/{backlog,in-progress,done}/` directories exist
