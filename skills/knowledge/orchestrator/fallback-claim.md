---
id: orchestrator.fallback-claim
type: procedure
title: "Nothing eligible: the Orchestrator (fallback) only for a worker you can vouch for"
scope.roles: [orchestrator]
scope.topics: [fallback-claim, host-catalog]
priority: 70
---

If nothing is eligible, or `hostFailures` block catalog placement, the server supports "Orchestrator (fallback)" and records the reasons in the packet's `fallback`. Use it only when you can vouch for a worker that satisfies actual prerequisites (`orchestrator.claim-prerequisites`); missing source, OS, consent, cost authority or `unknownRequirements` must be resolved before claim. Dispatch that worker, explain the placement limitation in the claim rationale and sprint report, and register a corrected catalog for the next run if the catalog was wrong.
