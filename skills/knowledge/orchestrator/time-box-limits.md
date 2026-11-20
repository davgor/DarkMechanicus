---
id: orchestrator.time-box-limits
type: convention
title: "Diagnose stalls; preserve real limits"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed, kanban.claimed, run.recovery]
scope.topics: [time-box]
priority: 78
---

- Suspected stalled worker: bounded hypothesis, observation, exit condition, intervention with recorded reason/evidence. Verify worker/child instrumentation. After two rounds closing no gap, reassess cause/design or report the blocker; no endless diagnostics or reruns for green.
- A long-running check within its authorized deadline is not automatically stalled: inspect status/evidence and expected result, supervise and heartbeat. Silence alone proves nothing.
- Preserve real deadlines, consent/cost limits, safe cleanup and lease fencing. No retroactive deadline growth or blind killing. Actual failures need partial artifacts/unmet criteria and safe containment. Scope/budget changes retain recovery/Save/adoption and human retries. Keep approvals/full verification: cards' full Definition of Done, epic targeted checks and sprint acceptance's full gate.
