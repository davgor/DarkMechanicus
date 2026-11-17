---
id: orchestrator.lost-claim-dispatched
type: procedure
title: "A lost claim a worker may hold: let it report or reconcile it"
scope.roles: [orchestrator]
scope.events: [run.recovery]
scope.topics: [lost-claim-response]
priority: 75
---

After replaying a lost claim response (`orchestrator.lost-claim-replay`):

- If you may have handed the packet to a worker before you lost track (after a restart, say), that worker may hold the token and be working. Do not fail the attempt. Let it report; if nothing does, wait until `get_ready_tickets` shows the ticket's `lease_expired` blocker and reconcile it as an expired lease (`orchestrator.expired-lease`). The packet's `leaseExpiresAt` is the earliest that can happen; a pause for sign-in pushes it later. After reconciling, claim it again with a new `idempotencyKey`; the old key keeps replaying the lost claim.
- If failing or abandoning the attempt uses the ticket's last try, the failure policy applies: ask the person for a retry.
- Without an idempotency key the repeat claims nothing: it fails with `already_claimed` while its lease is live, `needs_reconciliation` once it has expired, and `run_not_active` while the run is paused. `get_ready_tickets` lists the ticket with the lost attempt as its `latestAttemptId`; handle it the same way.
