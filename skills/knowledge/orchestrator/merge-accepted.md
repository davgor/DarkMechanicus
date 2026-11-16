---
id: orchestrator.merge-accepted
type: procedure
title: "Merge each accepted ticket into the integration worktree"
scope.roles: [orchestrator]
scope.events: [attempt.accepted]
scope.topics: [integration-worktree]
priority: 90
---

Merge each accepted ticket into the integration worktree (`orchestrator.integration-worktree`), in dependency order, and resolve conflicts there. A sprint's acceptance node is the exception: it lands on the epic branch (`orchestrator.acceptance-landing`).
