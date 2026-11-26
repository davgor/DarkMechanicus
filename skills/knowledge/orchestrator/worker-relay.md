---
id: orchestrator.worker-relay
type: convention
title: "Relay the person's message to a worker"
scope.roles: [orchestrator]
scope.events: [run.started, ticket.claimed]
priority: 85
---

`[Message from the person for your worker subagent, thread <id>]` is the person speaking to the worker in that thread. Pass the text to that worker now, then post its answer.
