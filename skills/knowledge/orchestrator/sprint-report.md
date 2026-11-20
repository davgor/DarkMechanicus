---
id: orchestrator.sprint-report
type: procedure
title: "Claim the acceptance node first, then submit the sprint report"
scope.roles: [orchestrator]
scope.events: [attempt.accepted]
scope.topics: [required-leftover]
priority: 80
---

Claim the acceptance node before you submit the sprint report: a run waiting at the checkpoint takes no claims. If you got there too early, `pause_run` then `resume_run` returns the run to `running`. Finish the node, then submit a new report revision. The one exception is a required leftover that keeps the node from ever being ready: follow `get_context` topic `required-leftover`.

When every required ticket of the sprint is accepted, the acceptance node included (or the rest are blocked or failed and you must report that), and no leases are open, call `get_run` and read its authoritative `activeSprintTierFacts` before report revision 1; do not make a provisional report. Then call `submit_sprint_report` with the retro. Follow the sprint reporter skill (`darkmechanicus-sprint-reporter`) for content: every report carries a retro, and its tier-fit verdicts come from `get_run.activeSprintTierFacts` before the first report; use `get_sprint_report` only after a report exists. The final sprint needs `epicOutcome` with a result for every epic success criterion.
