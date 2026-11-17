---
id: orchestrator.space-escaped-defects
type: procedure
title: "Report an escaped defect against its origin attempt"
scope.roles: [orchestrator]
scope.events: [row_check.failed]
scope.topics: [record-keeping]
priority: 60
---

A defect found after its ticket was accepted, by you or by a person who tells you of it (the desktop has no control for recording one yet), is reported with `record_attempt_metrics` against the origin attempt, naming the build commit it was found in. As a reviewing session you may attribute it (the server stamps that); a worker may only add an unassigned or candidate report. Ratings, rescue time and planned review time belong to a person in the desktop app.
