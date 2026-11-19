---
id: orchestrator.final-validation-ci
type: procedure
title: "Validate declared long checks on an immutable head"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed, run.recovery]
scope.topics: [final-validation-ci]
priority: 89
---

Only an unavoidable noninterruptible check declared in the saved plan may exceed the normal time box. For that declared long check, run CI against an immutable head; ordinary checks stay local. Prefer completing CI before claiming acceptance. Do not hold an acceptance claim idle across multi-hour CI unless a live reporter can retain the secret claim token and heartbeat throughout; otherwise finish the check before claim and hand its result into acceptance.

Record every outcome: pass, failure, and tool error, with the exact base and head of the artifact. A source change invalidates the old artifact. Fix the cause, then validate the new head once; acceptance compares the report's exact base and head with the increment it accepts. Never present old-head results as evidence for changed source.
