---
id: orchestrator.record-keeping
type: convention
title: "Record decisions, and read comments before dispatching again"
scope.roles: [orchestrator]
scope.events: [attempt.rejected, attempt.failed]
scope.topics: [record-keeping]
priority: 80
---

Every claim records the model, host, catalog revision, and rationale. Put decisions and surprises in review notes and in the sprint report so the history explains itself. Record a blocker or decision that concerns one ticket, or the whole epic, with `add_comment` (with or without a `ticketId`), and read what people and workers left with `list_comments` before you dispatch a ticket again after a failure or rejection.
