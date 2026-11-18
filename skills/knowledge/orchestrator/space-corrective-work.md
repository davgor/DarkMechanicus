---
id: orchestrator.space-corrective-work
type: procedure
title: "Create corrective work as drafts the person saves and runs"
scope.roles: [orchestrator]
scope.events: [sprint.reported, checkpoint.approved]
scope.topics: [retro-redraft]
priority: 65
---

`preview_corrections` and `create_corrections` turn selected experiments into DRAFT work, with a Fireguard ticket per repository by default (see the planner guide). Show the person what was created; the person saves, adopts and runs it with the normal controls, and the corrective sprint keeps its own acceptance node and human checkpoint. An experiment aimed at the Dark Mechanicus source is created and routed only by the person in the desktop app; its results come back when they press Bring back its grades, and you then record a result citing one of those grades. The runbook `docs/runbooks/corrective-work.md` covers recovery when a checkout is missing or a request stopped part way.
