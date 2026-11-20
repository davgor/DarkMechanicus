---
id: orchestrator.time-box
type: procedure
title: "Five-minute check and bounded stop for every ticket and card attempt"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed, kanban.claimed, run.recovery]
scope.topics: [time-box]
priority: 88
---

- Record start including setup, 5-minute checkpoint, default 10-minute deadline and criterion gaps. A preclaim saved investigation/verification exception uses its finite limits (time-box-limits). Coordination and delegates share the budget; heartbeats, handoffs and new attempts never reset unfinished work's clock.
- At 5 minutes assess evidence and feasibility, not activity. At the authorized deadline stop expansion, collect partial artifacts and report **not finished** with unmet criteria. Use `fail_attempt` / `fail_kanban_card`, recovery and draft/Save/adoption or retro/redraft for remainder; no silent continuation. A probe mistake alone needs no revision if correction fits scope and budget.
- Report independently accepted outcomes, evidence/gaps, elapsed time and measured usage/cost. Unmetered billed cost is **unknown**, not zero. Missing consent or an unmeterable accepted cost cap needs a prerequisite decision. Lease length and code volume are not progress.
