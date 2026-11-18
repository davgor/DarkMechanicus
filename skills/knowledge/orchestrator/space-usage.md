---
id: orchestrator.space-usage
type: procedure
title: "Record each row's usage from the session that did the work"
scope.roles: [orchestrator]
scope.topics: [record-keeping, space]
priority: 70
---

Usage is recorded by the session that did the work, never estimated. After each row: when your host writes session files that the `dm usage` command reads, run it for the run from your orchestrating session; it attributes each worker's tokens and active time to its attempt and your own to orchestration overhead. Otherwise relay real numbers with `record_attempt_metrics` (you need no claim token for an attempt of a run this machine owns) and `record_run_metrics` for overhead, or mark the usage unavailable. Never report 0 or a guess for a number you do not have. `get_run_metrics` shows what each attempt and overhead bucket holds and whether the totals are complete; the MCP setup runbook says which hosts can be read.
