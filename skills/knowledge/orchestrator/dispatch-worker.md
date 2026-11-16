---
id: orchestrator.dispatch-worker
type: procedure
title: "Start the worker at the claimed model and effort with its packet"
scope.roles: [orchestrator]
scope.events: [ticket.claimed]
priority: 90
---

Start the worker at the model and effort you claimed, with whatever your host offers to set them. Give it its packet, not the whole plan, tell it to work in a worktree of its own branched from the sprint integration branch, and tell it to follow the worker skill (`darkmechanicus-worker`). The packet contains the claim token, so treat it as a secret. Hand it over only if the worker can call the reporting tools (`heartbeat_attempt`, `submit_attempt`, `fail_attempt`) with credentials of its own. Otherwise give the worker the ticket content without the token, let it return its result to you, and make the calls yourself.
