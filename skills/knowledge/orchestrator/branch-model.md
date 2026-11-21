---
id: orchestrator.branch-model
type: convention
title: "The epic branch gets one squashed commit per sprint"
scope.roles: [orchestrator]
scope.events: [run.started]
scope.topics: [integration-worktree]
priority: 80
---

Build the sprint on its integration branch (pull topic `integration-worktree`). Workers branch from it. Under default Ticket standards, review the named tests, integrate passing work and verify it before acceptance. You own merge order, conflicts and combined checks. The epic feature branch receives one squashed commit per sprint. Deliver the sprint under its pinned standards and merge permissions.
