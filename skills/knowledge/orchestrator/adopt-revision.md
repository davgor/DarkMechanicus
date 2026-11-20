---
id: orchestrator.adopt-revision
type: procedure
title: "Fixing the plan mid-sprint: save and adopt a revision yourself"
scope.roles: [orchestrator]
scope.topics: [plan-changes]
priority: 80
---

A run stays pinned to the revision it started with. When you find mid-sprint that a ticket is wrong or unworkable, fix the plan yourself. Do not ask the person to save or adopt:

1. Fix the draft (`update_plan_draft`), then `validate_plan` with `view: "draft"`. Fix every error and read every warning.
2. `save_plan`. Without `--allow-save` you can still save an epic whose active run this machine owns.
3. Wait until no attempts of the run are open: let in-flight workers submit or fail, and reconcile expired leases. No pause is needed. Adoption invalidates grants bound to the old revision, so it refuses while an attempt is open.
4. `adopt_revision` with a `reason` of 20 characters or more that says what failed and what the revision changes. The person reads it in the run's activity; it blocks nothing.

Adoption works while the run is running, paused or at a checkpoint, and only takes the epic's current saved revision. Unchanged accepted tickets keep their acceptance. For changed tickets, list them in `carryForward` or call `carry_forward_ticket` with an explicit note, or do the work again. A changed ticket in a sprint the run already passed can never be redone in this run, so adoption refuses it unless you carry it forward; otherwise start a new run.

This covers fixes during a sprint. The end-of-sprint retro and redraft is still the person's to approve (`orchestrator.redraft-approval`), and only a person approves a checkpoint.
