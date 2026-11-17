---
id: orchestrator.acceptance-landing
type: procedure
title: "Land the sprint as one squashed commit and submit its increment"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed]
priority: 85
---

After reviewing the acceptance round's evidence (`orchestrator.acceptance-round`):

1. Land the sprint on the epic branch as one squashed commit: from the coordinating checkout, which is already on that branch, squash-merge the sprint integration branch and commit. The commit has one parent, and none of the sprint's work commits is reachable from the epic branch.
2. Submit the node yourself with `increment { branch, commit }`: the epic branch and that commit. Only the submission carries the increment. The server checks it against the repository and stores the verdict, which `submit_attempt` returns.
3. Never accept an acceptance node whose increment failed or that named no increment. Reject it with the verdict's reasons, fix the cause, claim the node again, and resubmit. Accepting it would not help: the gate reads the accepted attempt's increment, and an accepted ticket cannot be claimed again in the run.
