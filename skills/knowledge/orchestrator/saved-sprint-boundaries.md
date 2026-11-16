---
id: orchestrator.saved-sprint-boundaries
type: convention
title: "Honor the saved sprint boundaries during execution"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed, checkpoint.approved]
scope.topics: [plan-changes]
priority: 70
---

During execution, honor the saved sprint boundaries. Never collapse, add or bypass checkpoints unilaterally; a changed plan still needs the normal Save/adoption and human-approval boundaries. Run the full Definition of Done once at each actual sprint acceptance, not at an investigation or dependency-row boundary.
