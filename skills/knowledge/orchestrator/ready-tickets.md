---
id: orchestrator.ready-tickets
type: procedure
title: "Pick ready tickets and use the recommended model and effort"
scope.roles: [orchestrator]
scope.events: [run.started, attempt.accepted, checkpoint.approved]
scope.topics: [host-catalog]
priority: 75
---

Repeat until the sprint's required tickets are accepted or blocked:

1. `get_ready_tickets` for the run. Note `ready`, `blocked` (each with its blockers), `inFlight`, and `capacity`. Never claim more than capacity allows.
2. For each ready ticket you will start: read it with `get_ticket` if you need its full text, then `match_capabilities`.
   - The result includes `recommended`: a model, an effort, and reasons. The model is the best fit among the eligible ones. The effort is the ticket's own, else low for a micro or small ticket, medium for medium, and high for large. **Use the recommended model and effort unless you have a stated reason not to** (for example, the person asked for a specific model), and put that reason in the claim `rationale`.
   - If nothing is eligible, or `hostFailures` block catalog placement, follow `get_context` topic `fallback-claim`: missing source, OS, consent, cost authority or `unknownRequirements` must be resolved before claim.
   - A host that cannot select worker models may use its fixed model only if the requirements are satisfied.
3. Claim it (`orchestrator.claim-ticket`).
