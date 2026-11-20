---
id: orchestrator.required-leftover
type: procedure
title: "A required leftover keeps the acceptance node from ever being ready"
scope.roles: [orchestrator]
scope.topics: [required-leftover]
priority: 90
---

In a sprint with an acceptance node, a required ticket that is not accepted (failed, blocked, or rejected at its retry limit) means the node can never be accepted while that ticket is in the sprint, because the node requires every required work ticket of its sprint. **Approve retro & redraft** does not fit this case. It adopts the revision and recomputes the gate on it, the node is still not accepted there, and it stops at its recompute step and rolls the adoption back. The draft stays saved, the run keeps executing its old revision, and the error says adoption is still needed. Work through the case in this order instead:

1. Submit the report with the retro, listing the leftovers with their reasons. The run waits at the checkpoint, and the report is complete even though `acceptance_accepted` is unmet.
2. Redraft and validate as usual (`redraft_next_sprint`, refine, `validate_plan`; `get_context` topic `retro-redraft`).
3. Save the draft and adopt the new revision yourself (`adopt_revision` with a `reason`). Adoption needs no open attempts, so finish or reconcile any open attempt first. The leftovers, and the tickets that require them, leave the sprint. The tickets that stay keep their acceptance, and the run is still waiting at its checkpoint.
4. Then finish the sprint (`orchestrator.required-leftover-finish`).
