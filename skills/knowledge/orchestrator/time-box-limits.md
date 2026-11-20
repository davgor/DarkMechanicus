---
id: orchestrator.time-box-limits
type: convention
title: "Stop sooner on fruitless diagnostics; a stop is no unsafe termination"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed, kanban.claimed]
scope.topics: [time-box]
priority: 78
---

- Diagnostics are not acceptance: name a hypothesis, discriminating observation and exit. First prove instrumentation reaches the actual worker/child and writes readable measurements. Preserve failed gates; no reruns for green. After two unproductive rounds, reassess; correcting a probe within authorized scope/budget need not create a revision. Inconclusive feasibility blocks dependents.
- A stop permits only authorized safe containment/owned cleanup, not unsafe native termination. Preserve finite deadlines and consent; report uncertainty honestly.
- Beyond 10 minutes needs a preclaim saved exception: bounded investigation or unavoidable noninterruptible verification, with exact scope, finite time/probe/cost limits and cleanup. No extra implementation, retroactive growth or reset clock. Scope/budget changes use recovery and draft/Save/adoption; retry grants remain human. Full Definition of Done stays at sprint acceptance; targeted checks per ticket.
