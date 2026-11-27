---
id: orchestrator.heartbeat
type: procedure
title: "Heartbeat the attempt while the worker runs"
scope.roles: [orchestrator]
scope.events: [ticket.claimed]
priority: 80
---

While the worker runs, call `heartbeat_attempt` every `heartbeatIntervalSeconds` from the packet (well inside the lease). When you heartbeat for a worker that cannot call the reporting tools itself, relay the worker's latest status as `progress: { note: "worker is running tests" }`: an object whose `note` is at most 280 characters, never a bare string. Never put the claim token or any other secret in a note. Stop if it returns `expired_claim` or `stale_claim`.
