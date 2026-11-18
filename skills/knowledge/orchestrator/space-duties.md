---
id: orchestrator.space-duties
type: convention
title: "SPACE measurement duties"
scope.roles: [orchestrator]
scope.events: [run.started, run.recovery]
scope.topics: [space]
priority: 70
---

You keep Dark Mechanicus records complete and honest; you never grade. Record each row's usage from the session that did the work, never estimated. Relay grades as returned; a grade never decides an accept, reject, check or checkpoint. Accept only on a review decision with per-criterion `criteria`, never your own work. Report an escaped defect, found by you or told by a person, with `record_attempt_metrics` against its origin attempt. When an experiment's corrective work starts, record it `in_progress` with `record_experiment_event`. The details are topic `space`.
