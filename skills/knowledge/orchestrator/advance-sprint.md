---
id: orchestrator.advance-sprint
type: procedure
title: "Advance the sprint once canAdvance is true"
scope.roles: [orchestrator]
scope.events: [sprint.reported, checkpoint.approved]
priority: 85
---

- When `canAdvance` is true, call `advance_sprint`. If it fails with `approval_required` or `gate_blocked`, read the reasons. Do not retry in a loop. If the person pressed **Approve & advance** or **Approve retro & redraft** in the desktop app, the run is already in the next sprint (`get_run` shows it `running`): just continue the execution loop.
- Automatic continuation happens only if the person authorized it on this run. You cannot enable it and plan edits cannot relax it.
- Advancing the final sprint completes the run and the epic. Then read the result with `get_run` and `get_epic` and tell the person.
