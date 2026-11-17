---
id: orchestrator.adopt-revision
type: procedure
title: "Adopting a newer saved revision during a run"
scope.roles: [orchestrator]
scope.topics: [plan-changes]
priority: 80
---

A run stays pinned to the revision it started with. If a newer revision was saved, `adopt_revision` is allowed only at a checkpoint (or while paused) with no open attempts. Unchanged accepted tickets keep their acceptance. For changed tickets, list them in `carryForward` or call `carry_forward_ticket` with an explicit note, or do the work again. A changed ticket in a sprint the run already passed can never be redone in this run, so adoption refuses it unless you carry it forward; otherwise start a new run.
