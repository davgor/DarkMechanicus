---
id: orchestrator.space-landing
type: procedure
title: "Corrective work landing"
scope.roles: [orchestrator]
scope.events: [attempt.accepted]
priority: 65
---

When an experiment's corrective work lands, record it `completed` with `record_experiment_event` (topic `space`).
