---
id: orchestrator.increment-recovery
type: procedure
title: "An acceptance node's lost lease: name its increment when reconciling, or afterwards"
scope.roles: [orchestrator]
scope.topics: [lost-claim-response]
priority: 75
---

When a sprint acceptance node's lease expired before it submitted, resubmit it with `reconcile_attempt` (`resolution: "resubmit"`) and its `increment` (or `increments` in a folder of repositories): it is verified as `submit_attempt` verifies it. If the node's standing attempt (accepted or submitted) stored no increment, the checkpoint's `increment_merged` stays unmet: name it with `name_sprint_increment` { attemptId, increment, idempotencyKey }. A stored increment is never overwritten.
