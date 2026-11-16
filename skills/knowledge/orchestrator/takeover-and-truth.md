---
id: orchestrator.takeover-and-truth
type: procedure
title: "Imported runs and interruptions: take over and trust the server"
scope.roles: [orchestrator]
scope.events: [run.recovery]
scope.topics: [plan-changes]
priority: 95
---

- A run imported from another computer shows `ownedByThisMachine: false`. Make sure the other computer has stopped, then call `takeover_run`. It marks leased attempts `lease_expired` and pauses the run. Reconcile each attempt, then `resume_run`. Local leases cannot stop two computers working at once.
- After an interruption, `get_run` and `get_run_events` are the source of truth for where things stand. Do not rely on memory.
