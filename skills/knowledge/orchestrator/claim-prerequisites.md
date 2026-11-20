---
id: orchestrator.claim-prerequisites
type: convention
title: "Check actual prerequisites before claiming"
scope.roles: [orchestrator]
scope.events: [run.started, attempt.accepted, attempt.rejected, attempt.failed, checkpoint.approved, kanban.claimed]
scope.topics: [time-box, fallback-claim]
priority: 80
---

Before claim, verify revision, capability, consent/cost; invoke needed Node/npm/Git in actual worker shell/cwd and prove child PATH/pinned dependencies, not parent success. Check Windows/native permissions; recheck changes. Fixtures need unique resources and owned cleanup, not shared snapshots. Keep offline node_modules; installs follow planner preflight. Missing prerequisites need bounded GO/NO-GO. Size by coherent outcome, not alarm duration; preserve genuine limits under time-box-limits.
