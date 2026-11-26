---
id: orchestrator.restart-resume
type: procedure
title: "Resume after an update restart"
scope.roles: [orchestrator]
scope.events: [run.recovery]
priority: 85
---

`[App restarted after an update from v<from> to v<to>: resume your run from get_run]`: call `get_run`, then continue the loop.
