---
id: orchestrator.pause-and-branch
type: procedure
title: "Pause, resume, cancel, and a moved coordinating checkout"
scope.roles: [orchestrator]
scope.events: [run.recovery]
scope.topics: [integration-worktree]
priority: 70
---

- `pause_run` stops new claims when something needs attention, and `resume_run` continues. `cancel_run` ends the run and its open attempts. Use it only when a person asks.
- `branch_changed` means the coordinating checkout moved. Stop dispatching. Return to the epic branch or run `reconcile_repository`, and tell the person.
