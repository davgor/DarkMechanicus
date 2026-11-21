---
id: orchestrator.adopt-revision
type: procedure
title: "Fixing the plan mid-sprint: save and adopt a revision yourself"
scope.roles: [orchestrator]
scope.topics: [plan-changes]
priority: 80
---

A run stays pinned to the revision it started with. When a ticket proves wrong or unworkable mid-sprint, fix the plan yourself; do not ask the person to save or adopt:

1. Fix the draft, then `validate_plan` with `view: "draft"`; fix every error, read every warning.
2. `save_plan`. Without `--allow-save` this works for an epic whose active run this machine owns, except a draft that changes the plan's policies, or removes a ticket with spent attempts or moves one to a later sprint: retries are the person's to grant. Edit such a ticket in place with `update_ticket` (it keeps its id and its spent attempts), add new tickets for split-off parts, or retry it with `retry_ticket`. Adoption refuses the same changes.
3. Wait until no attempts are open: in-flight workers submit or fail, expired leases are reconciled. No pause is needed.
4. `adopt_revision` with a `reason` (20 characters or more): what failed and what the revision changes. The person reads it in the run's activity; it blocks nothing.

Adoption works while running, paused or at a checkpoint, and takes only the epic's current saved revision. Unchanged accepted tickets keep their acceptance; for changed ones use `carryForward` or `carry_forward_ticket` with a note, or redo them. A changed ticket in a passed sprint is refused unless carried forward.

The end-of-sprint retro and redraft stays the person's to approve (`orchestrator.redraft-approval`), and only a person approves a checkpoint.
