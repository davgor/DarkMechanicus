---
id: orchestrator.attempt-blocker
type: procedure
title: "A worker reports a blocker: fail the attempt"
scope.roles: [orchestrator]
scope.events: [attempt.failed]
priority: 85
---

A worker reports a blocker: `fail_attempt` (with the claim token) with a reason, details, and whether it is retryable. Dependents stay blocked. When the retry limit is reached the plan's `onTicketFailure` policy applies: `continue_independent` keeps independent branches going, `pause_run` pauses, `fail_run` ends the run. Ask the person if more retries are needed. Only the desktop can grant them.
