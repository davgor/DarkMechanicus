---
id: orchestrator.time-box
type: procedure
title: "Five-minute check, ten-minute stop-and-split for every ticket and card attempt"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed, kanban.claimed, run.recovery]
scope.topics: [time-box]
priority: 88
---

- Record actual start (including claim/setup), the 5-minute checkpoint and 10-minute deadline, plus a per-criterion evidence/gap ledger. Analysis, coordination, delegates and tool calls consume the same window. Heartbeats, lease extensions, compaction, handoffs and new attempts do not reset unfinished work's clock.
- At 5 minutes, inspect observed evidence against the gaps, not the worker's activity; prepare a split if completion by 10 minutes is doubtful. At 10 minutes, stop new implementation and diagnostic expansion. Collect partial artifacts and report **not finished**, with each unmet criterion and remaining prerequisite. Use `fail_attempt` / `fail_kanban_card` when incomplete, rather than submitting it as success; use the existing recovery and draft/Save/adoption or retro/redraft procedures for the remainder. Do not silently continue the same oversized work under a new attempt.
- At each checkpoint/report, state independently accepted outcome count, evidence gained and remaining gaps, elapsed time and host-exposed usage/cost against the budget. Billed cost without metering is **unknown**, not zero or an estimate presented as fact. Missing consent or an accepted cost cap with no usable metering is a prerequisite decision. Lease duration, code volume and worker activity are not accepted progress.
