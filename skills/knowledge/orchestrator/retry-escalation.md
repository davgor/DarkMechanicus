---
id: orchestrator.retry-escalation
type: procedure
title: "Retry one tier or one effort step at a time"
scope.roles: [orchestrator]
scope.events: [attempt.rejected, attempt.failed]
priority: 90
---

Rejected tickets become retryable: claim again and add the rejection reasons to the instructions you give the new worker.

A ticket is rejected: escalate one tier or one effort step at a time. `match_capabilities` already recommends the next step: the cheapest eligible model one tier above the last attempt's (tier is cost tier, then the highest reasoning level), or the same model at the next effort when nothing sits above it. Claim at that step and put the reason in the claim `rationale` (for example "attempt 1 rejected on the low-cost model; escalating one tier"). Never jump straight to the most capable worker: small steps show what the ticket needs, and whether repeated failures come from the ticket or the model. A failed attempt gets the same recommendation, but a blocker such as missing access is not a capability problem, so fix it first.
