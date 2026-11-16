---
id: orchestrator.setup
type: procedure
title: "Set up: confirm the role, check storage and read the saved plan"
scope.roles: [orchestrator]
scope.events: [run.started]
priority: 95
---

1. `get_capabilities`: confirm your role is `orchestrator` and note `skillsVersion`.
2. `get_storage_status`: if `branch.changed` is true, `outbox.failed` is above zero, or `conflicts` or `profileConflicts` is not empty, resolve it with `reconcile_repository` or `flush_portable_state`, or ask the person, before doing anything else.
3. Pick the epic (`list_epics`, `get_epic`) and read its saved plan with `get_plan` (`view: "saved"`). Execution uses only saved revisions.
4. Register the host (`orchestrator.register-host`), then start the run (`orchestrator.start-run`).
