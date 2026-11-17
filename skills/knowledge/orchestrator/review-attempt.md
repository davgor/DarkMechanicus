---
id: orchestrator.review-attempt
type: procedure
title: "Submit the attempt and review it against its own criteria"
scope.roles: [orchestrator]
scope.events: [ticket.claimed]
priority: 75
---

When the worker returns, `submit_attempt` with its outputs and evidence (unless the worker did).

Review against its own criteria and the worker's targeted evidence. Verify every acceptance criterion yourself, or hand the attempt to a reviewer (`darkmechanicus-reviewer`): read the diff of the worker's commits against the sprint integration branch, and re-run only the targeted checks if the evidence is in doubt. Do not run the full sweep, and make no per-ticket merge commit on the epic branch. Then `accept_attempt` with per-criterion `criteria` results, or `reject_attempt` with actionable `reasons`. Acceptance completes the ticket and unlocks its dependents. Open the evidence images yourself when a criterion asks for a screenshot: each id in the submission's `evidence.attachments` goes to `get_attachment` with `as: "file"`. Reject an attempt whose screenshot criterion has no image attached.

A sprint's acceptance node differs here: you submit it yourself, after the acceptance round (the `acceptance.claimed` facts).
