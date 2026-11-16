---
id: orchestrator.row-checks
type: procedure
title: "Run and record the combined check when a row is fully accepted"
scope.roles: [orchestrator]
scope.events: [attempt.accepted, row_check.failed]
scope.topics: [integration-worktree]
priority: 85
---

`get_run` and `get_ready_tickets` list each sprint's rows: a ticket's row is one below its deepest same-sprint prerequisite. When a row is fully accepted and merged, run the combined check in the integration worktree: typecheck plus the tests that touch that row's files. Then call `record_row_check` with the `runId`, `sprintId`, `row`, the `commit` you checked at, and each `check` you ran with its status. It passes only when every entry passed, so a failed or skipped entry fails it. While a row's latest check has not passed, every ticket that requires a ticket of that row shows a `row_check_failed` blocker, and a later passing check clears it. Other tickets keep running. After a failure, fix integration problems yourself (a conflict, a missed rename) and record a new check. A defect in an accepted ticket's own work is the person's decision: record it with `add_comment` and report it. Never record a check you did not run.
