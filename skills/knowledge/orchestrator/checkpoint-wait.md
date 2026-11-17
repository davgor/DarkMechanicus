---
id: orchestrator.checkpoint-wait
type: procedure
title: "At the checkpoint: redraft, tell the person, and poll"
scope.roles: [orchestrator]
scope.events: [sprint.reported]
scope.topics: [retro-redraft]
priority: 90
---

The run now waits at the checkpoint. Redraft the next sprint from the retro (`get_context` topic `retro-redraft`; topic `required-leftover` when a required ticket kept the acceptance node from being ready), then tell the person that the retro and the redraft are ready to approve in one step. When there is nothing to redraft, tell them the report is ready for approval in the desktop app. Poll `get_checkpoint` (or read `get_run_events` from your last cursor) at a sensible interval. Each condition says what is unmet. You cannot approve. Never ask a worker to.
