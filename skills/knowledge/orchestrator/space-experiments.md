---
id: orchestrator.space-experiments
type: procedure
title: "Restate kept experiments and record their progress"
scope.roles: [orchestrator]
scope.events: [sprint.reported, checkpoint.approved]
priority: 65
---

The retro's experiments are written as the sprint reporter guide says. When you submit a new report revision, restate each experiment you keep by its `id` with its original `{ reportId, assessmentId }`: one left out is withdrawn, and one resubmitted by its subject gets a new id and leaves its events behind. Record each experiment's progress with `record_experiment_event` on the machine that owns its run: statuses (`selected`, `scheduled` with a note saying where the work went, `in_progress`, then `completed` or `abandoned`) and results that cite a sealed grade by `{ reportId, assessmentId }`. `get_experiment` shows its standing, corrective tickets and outcome; the outcome is observational, never proof of cause.
