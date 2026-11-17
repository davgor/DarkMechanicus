---
id: orchestrator.claim-ticket
type: procedure
title: "Claim with the worker you chose, its rationale and an idempotency key"
scope.roles: [orchestrator]
scope.events: [run.started, attempt.accepted, attempt.rejected, attempt.failed, checkpoint.approved]
scope.topics: [lost-claim-response]
priority: 70
---

`claim_ticket` with `runId`, `ticketId`, and `worker`: a `label`, the `modelId`, `hostId`, and `catalogRevision` you chose, the reasoning `effort` you picked, and a `rationale` (why this model and effort; for example "recommended by match_capabilities" or the reason you overrode it), all inside `worker`. Pass an `idempotencyKey` so that a call whose response is lost can be repeated safely. It returns a `claimToken` and an execution `packet` that carries the effort. The token is shown once: no copy is kept, so a repeat of the call with the same key returns the same attempt and packet with `claimToken: null` (see `get_context` topic `lost-claim-response`).
