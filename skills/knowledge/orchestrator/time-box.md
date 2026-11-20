---
id: orchestrator.time-box
type: procedure
title: "Supervise worker progress at five and ten minutes"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed, kanban.claimed, run.recovery]
scope.topics: [time-box]
priority: 88
---

- Log start/setup and gaps; schedule a 5-minute check and 10-minute alarm, then every 5 minutes. Alarms supervise, not terminate.
- Obtain progress/evidence, current operation, expected next result and blockers. Productive workers continue on the same assignment and claim. Elapsed time alone must not stop/fail, decompose or reset attempts. No saved exception for productive work; a single card never waits on an unsolicited epic Save. Diagnose stalls under time-box-limits.
- Report outcomes/gaps, elapsed time and measured usage/cost; unmetered cost is **unknown**. Missing consent/unmeterable caps need a decision. Handoffs never erase time; activity is not progress. Never claim completion to avoid alarms.
