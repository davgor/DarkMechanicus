---
id: orchestrator.space-experiment-progress
type: procedure
title: "Record experiment progress"
scope.roles: [orchestrator]
scope.events: [sprint.reported, checkpoint.approved]
scope.topics: [space]
priority: 65
---

Record each experiment's progress with `record_experiment_event` on the machine that owns its run: statuses (`selected`, `scheduled` with a note saying where the work went, `in_progress`, then `completed` or `abandoned`) and results that cite a sealed grade by `{ reportId, assessmentId }`. `get_experiment` shows its standing, corrective tickets and outcome; the outcome is observational, never proof of cause.
