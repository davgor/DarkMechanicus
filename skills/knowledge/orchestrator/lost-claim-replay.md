---
id: orchestrator.lost-claim-replay
type: procedure
title: "A lost claim response: replay it with the same idempotency key"
scope.roles: [orchestrator]
scope.events: [run.recovery]
scope.topics: [lost-claim-response]
priority: 80
---

A lost claim response. If a `claim_ticket` response never reached you (a timeout, a dropped connection, a restart), repeat the call with the same `idempotencyKey` and the same arguments. If the first call never claimed, this one does and returns a token. If it did claim, you get the attempt and packet back with `claimToken: null`: the token is shown once, and no replay, not even yours, can recover it. Then:

- If the response never reached you, nobody holds the token and no worker started under it. Do not dispatch one. Free the ticket at once with `fail_attempt`: the `attemptId` from the replay, no `claimToken`, and a reason such as "claim response lost" with `retryable: true`. It uses one try. Then claim it again with a new `idempotencyKey`; the old key keeps replaying the lost claim. The new claim has a new token and a higher fencing token.
- If you may have handed the packet to a worker before you lost track, follow `orchestrator.lost-claim-dispatched`.
