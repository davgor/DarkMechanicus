---
id: orchestrator.investigation-gate
type: convention
title: "After an accepted investigation, keep going within the saved scope"
scope.roles: [orchestrator]
scope.events: [attempt.accepted]
scope.topics: [plan-changes]
priority: 60
---

After accepting the investigation and passing its row check, continue ready work within the saved scope without another human approval. A missing capability, unsafe approach or required scope change blocks dependents and follows the normal escalation/replan rules; do not weaken acceptance to keep moving.
