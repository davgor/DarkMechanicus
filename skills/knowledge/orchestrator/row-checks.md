---
id: orchestrator.row-checks
type: procedure
title: "Run and record the combined check when a row is fully accepted"
scope.roles: [orchestrator]
scope.events: [attempt.accepted, row_check.failed]
scope.topics: [integration-worktree]
priority: 85
---

`get_run` / `get_ready_tickets` list rows (one below deepest same-sprint prerequisite). Once a row is accepted and merged, check early combined work: typecheck and affected integration/fixture tests, not a full suite per ticket. Use isolated resources/owned cleanup; coordinate heavy checks by mail as the orchestrator guide says. `record_row_check`: `runId`, `sprintId`, `row`, checked `commit`, checks/statuses. All must pass; failed/skipped entries block that row's dependents (`row_check_failed`), not unrelated work. Preserve failures; fix integration mistakes and record changed-result evidence, never rerun for green. Accepted-ticket defects need `add_comment` and the person's decision. Never record unrun checks.

Each row check also runs the early signals that otherwise first fail at acceptance or in CI: `deadcode`, Fireguard's AST gate (gate 1 only) on the changed modules, and changed-file coverage. In Dark Mechanicus, `npm run check:row -- --base <epic branch>` runs all three in minutes and prints each as a check (`fireguard:ast`, `deadcode`, `coverage:changed`). The full gate at acceptance and in PR CI is unchanged.

After each row, record its usage as `orchestrator.space-usage` says (`get_context` topic `record-keeping`).
