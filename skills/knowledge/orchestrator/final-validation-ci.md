---
id: orchestrator.final-validation-ci
type: procedure
title: "Validate long checks on immutable heads"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed, run.recovery]
scope.topics: [final-validation-ci]
priority: 89
---

Supervise long checks under `time-box`; alarms are not deadlines or saved-exception gates. CI validates an immutable head within genuine authorized limits; ordinary checks stay local. Prefer CI before claiming acceptance. Holding a claim across CI needs a live reporter with the secret claim token and heartbeats; otherwise finish CI first.

Record pass, failure and tool error with exact base and head. A source change invalidates the artifact; fix the cause, validate the new head once, and match acceptance to that increment.
