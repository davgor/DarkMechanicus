---
id: orchestrator.integration-worktree
type: procedure
title: "Keep each sprint's integration branch in a separate worktree"
scope.roles: [orchestrator]
scope.topics: [integration-worktree]
priority: 80
---

The sprint's combined work lives on a sprint integration branch in a separate worktree. The acceptance node is where it is verified and lands on the epic branch.

Keep the coordinating checkout on the epic branch, because switching it pauses the run with `branch_changed`. Create each sprint's integration branch in a separate worktree outside the coordinating checkout, from the tip of the epic branch, so it already holds the previous sprint's increment. Use `git -C <worktree>` for every worktree command. Never put a destructive git command after a `cd` that a failed step could skip: it would run in the wrong checkout.
