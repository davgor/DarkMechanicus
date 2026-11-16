---
id: orchestrator.attachments
type: convention
title: "Pass reference images on to the worker"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, kanban.claimed]
scope.topics: [record-keeping]
priority: 70
---

Reference images a person attached to a ticket, card or comment show up as `attachments` on packets and records: pass them on to the worker, which opens them with `get_attachment`. You can attach an image to a comment with `add_comment` `attachments`.
