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

At the retry limit (blocker `retry_limit`), do not ask the person. Call `retry_ticket` with an honest `failureReason` and a genuinely different `newApproach`: split the work, change the design, change the model tier, or fix the environment. A repeated approach is refused, and the budget and the tried approaches count every run of the epic: starting a new run resets neither. The person may acknowledge each retry in the desktop app; that never blocks you. Escalate to the person only on `retry_escalation_required` (the plan's `autoRetryLimit`, default 3, is used up): say why it keeps failing, since only their grant adds attempts then.
