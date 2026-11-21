---
id: orchestrator.redraft-refine
type: procedure
title: "Refine the redraft: size, cover, and edit only future sprints"
scope.roles: [orchestrator]
scope.topics: [retro-redraft]
priority: 85
---

After `redraft_next_sprint` (`orchestrator.redraft-call`), refine the draft with `update_plan_draft` or `update_ticket`, passing `expectedDraftRevision`:

- Size every new ticket (`micro`, `small`, `medium`, or `large`, as the planner skill defines them) and set its `reasoning.effort`. A discovery arrives unsized, with the worker's reason as its body: give it a precise body and 2 to 6 checkable acceptance criteria.
- Keep every work ticket's criteria agent-verifiable: a command, test, CDP or script-driven check, or a screenshot the agent captures and inspects. The person verifies only at the checkpoint, so move a criterion that needs a person to the sprint's acceptance node or rewrite it (`validate_plan` warns `criterion_needs_person`).
- Write the `covers` criteria of the next sprint's acceptance node for the moved and the new items: one criterion per ticket, naming the specific screenshot, measurement, or end-to-end check, as the graph planner skill describes. When the active sprint's node has not been accepted and a criterion of it covers a moved ticket, move that check to the next sprint's node: a `covers` that names a ticket outside the node's sprint draws a validation warning. Leave an accepted node alone, because changing it supersedes its acceptance on adoption.
- Edit only future sprints, the ones after the active sprint. Never edit a sprint the run has passed: a run does not redo one, validation warns about the change, and adoption refuses a changed accepted ticket there unless it is carried forward.
