---
id: orchestrator.space-grades
type: convention
title: "Keep the graded records honest, and relay grades as returned"
scope.roles: [orchestrator]
scope.events: [sprint.reported]
scope.topics: [space, record-keeping]
priority: 70
---

Dark Mechanicus grades tickets, sprints, runs and epics from its own records. You keep those records complete and honest; you never grade.

Read grades and their inputs with the read tools (`get_ticket_grade`, `get_sprint_grade`, `get_run_grade`, `get_epic_grade`, `get_report_scorecard`, `get_metrics_summary` and the others) and relay them as returned: never regrade, average letters, or fill a missing value. A grade is never a reason to accept, reject, skip a check or bypass a checkpoint, and a low grade never authorizes new work by itself.
