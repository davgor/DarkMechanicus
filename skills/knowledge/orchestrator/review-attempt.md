---
id: orchestrator.review-attempt
type: procedure
title: "Submit the attempt and review it against its own criteria"
scope.roles: [orchestrator]
scope.events: [ticket.claimed]
priority: 75
---

`submit_attempt` with worker outputs and evidence unless already submitted.

Verify every criterion independently or use `darkmechanicus-reviewer`: read the diff against the sprint integration branch and targeted evidence. Re-run targeted checks only if evidence is in doubt; no full sweep or per-ticket merge commit.

For visible UI changes, even without a screenshot criterion, open `evidence.attachments` via `get_attachment` (`as: "file"`), inspect images against criteria/mockups, and check source/build, scenario, states and viewport. Report findings; screenshots do not prove behavior, security or native integration. Missing visual proof stays unmet. Investigate available capture/view tools; report exact attempts, errors and gaps to the orchestrator, not routine capture/review requests to the person. Protect privacy; credentials, native consent and human checkpoint/card approval remain human-only.

`accept_attempt` with verified per-criterion `criteria`, or `reject_attempt` with actionable `reasons`; never accept missing proof. Acceptance unlocks dependents.

For the sprint acceptance node, submit after the acceptance round (`acceptance.claimed` facts).
