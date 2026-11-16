---
id: orchestrator.claim-prerequisites
type: convention
title: "Check actual prerequisites before claiming"
scope.roles: [orchestrator]
scope.events: [run.started, attempt.accepted, attempt.rejected, attempt.failed, checkpoint.approved, kanban.claimed]
scope.topics: [time-box, fallback-claim]
priority: 80
---

Before claiming, confirm both server readiness and actual prerequisites: exact source/revision, capability/profile, OS/runtime, fixture, required consent and accepted time/cost limits. A fallback model does not satisfy missing prerequisites. Check that one worker can deliver the scoped outcome in 5–10 minutes; otherwise split through the sanctioned draft/Save/replan path before dispatch. You own parallelism; do not permit a worker to delegate a nested mini-epic.
