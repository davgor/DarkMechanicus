---
id: orchestrator.post-checkpoint-delivery
type: procedure
title: "Deliver the sprint revision under its approved workflow"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed, checkpoint.approved, run.recovery]
scope.topics: [post-checkpoint-delivery]
priority: 88
---

Default Sprint standards: merge, monitor rollout and verify the installed revision before the human checkpoint. Checkpoint approval and merge authorization are separate. For legacy delivery after the final checkpoint, the saved plan or person authorizes you to open a PR, mark ready and squash-merge. Use branch protection, never an admin bypass. A failing non-required check needs a person-owned risk decision. Verify the remote default branch. Without authorization, stop at the completed epic branch/report.
