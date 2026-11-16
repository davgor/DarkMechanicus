---
id: orchestrator.expired-lease
type: procedure
title: "An expired lease is uncertain, not failed: reconcile it first"
scope.roles: [orchestrator]
scope.events: [run.recovery]
scope.topics: [lost-claim-response]
priority: 90
---

An expired lease means execution is uncertain, not failed. The ticket shows the blocker `lease_expired` and must be reconciled before any new claim. First inspect what actually happened in the workspace and branch. Then call `reconcile_attempt` with `resolution: "abandon"` (treat as not done) or `"resubmit"` with `outputs` and `evidence` for work that did finish. Never restart externally visible actions before reconciling.
