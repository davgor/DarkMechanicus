---
id: orchestrator.space-grades
type: convention
title: "Relay grades as returned; a grade never decides"
scope.roles: [orchestrator]
scope.events: [run.started, run.recovery, sprint.reported]
scope.topics: [record-keeping]
priority: 70
---

You never grade. Read grades with the read tools (`get_ticket_grade`, `get_run_grade`, `get_report_scorecard`, `get_metrics_summary` and the others) and relay them as returned: never regrade, average letters, or fill a missing value. A grade is never a reason to accept, reject, skip a check or bypass a checkpoint, and a low grade never authorizes new work by itself.
