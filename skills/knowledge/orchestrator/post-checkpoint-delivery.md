---
id: orchestrator.post-checkpoint-delivery
type: procedure
title: "Deliver the sprint revision under its approved workflow"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed, checkpoint.approved, run.recovery]
scope.topics: [post-checkpoint-delivery]
priority: 88
---

Default Sprint standards: merge, monitor rollout and verify the installed revision before the human checkpoint. Checkpoint approval isn't merge authorization; `delivery` is verified post-approval (topic `sprint-delivery`). Legacy exception, after final checkpoint: if the saved plan or person authorizes, open a PR, mark ready, squash-merge; branch protection, never an admin bypass. Failing non-required check: person-owned risk decision. Check the remote default branch. Else stop at the completed epic branch/report.
