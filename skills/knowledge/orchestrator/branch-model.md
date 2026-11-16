---
id: orchestrator.branch-model
type: convention
title: "The epic branch gets one squashed commit per sprint"
scope.roles: [orchestrator]
scope.events: [run.started]
scope.topics: [integration-worktree]
priority: 80
---

The epic feature branch is the integration target, and each sprint's work meets on a sprint integration branch first (pull `get_context` topic `integration-worktree` before you create it). Workers branch from the sprint integration branch, and you merge their accepted work into it. The epic branch receives one squashed commit per sprint, never a merge per ticket, and nothing goes into the default branch. You own merge order, conflict resolution, and the combined checks. Merging the epic into the default branch is a separate step for a person.
