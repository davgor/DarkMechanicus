---
id: orchestrator.post-checkpoint-delivery
type: procedure
title: "Deliver only when explicitly authorized after the checkpoint"
scope.roles: [orchestrator]
scope.events: [checkpoint.approved, run.recovery]
scope.topics: [post-checkpoint-delivery]
priority: 88
---

Checkpoint approval and merge authorization are different. Only when the saved plan or person explicitly requests PR delivery, open a PR, mark it ready, and squash-merge after final checkpoint completion. Use normal branch protection; never an admin bypass. A known failing non-required check requires an explicit person-owned risk decision and tracking before merge; do not decide the risk yourself. Verify that the remote default branch equals the merge commit after delivery. Without explicit delivery authorization, stop at the completed epic branch/report.
