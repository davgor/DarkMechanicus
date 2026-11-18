---
id: orchestrator.space-experiment-progress
type: procedure
title: "Record experiment progress"
scope.roles: [orchestrator]
scope.events: [sprint.reported, checkpoint.approved, attempt.accepted]
priority: 65
---

Record an experiment's progress with `record_experiment_event` on the machine owning its run: statuses (`selected`, `scheduled` with where the work went, `in_progress`, then `completed` or `abandoned`) and results citing a sealed grade by `{ reportId, assessmentId }`. Its outcome (`get_experiment`) is observational, never proof of cause.
