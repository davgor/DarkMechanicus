---
id: orchestrator.fallback-claim
type: procedure
title: "Nothing eligible: claim anyway as the Orchestrator (fallback)"
scope.roles: [orchestrator]
scope.topics: [fallback-claim, host-catalog]
priority: 70
---

If nothing is eligible, or `hostFailures` block the ticket, the ticket is not stranded: claim it anyway. The server hands it to you as "Orchestrator (fallback)", records why, and returns the reasons in the packet's `fallback`. Dispatch a worker you can vouch for, say in the rationale and the sprint report that the catalog could not place the ticket, and register a corrected catalog for the next run if the catalog was wrong. Never treat `unknownRequirements` as satisfied: ask the person.
