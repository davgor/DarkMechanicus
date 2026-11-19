---
id: orchestrator.claim-prerequisites
type: convention
title: "Check actual prerequisites before claiming"
scope.roles: [orchestrator]
scope.events: [run.started, attempt.accepted, attempt.rejected, attempt.failed, checkpoint.approved, kanban.claimed]
scope.topics: [time-box, fallback-claim]
priority: 80
---

Claims: verify saved preflight source/revision, capability, OS/runtime, fixtures, child tools, integrity, offline access, consent, cost; recheck changes. Keep offline node_modules; no speculative npm ci. Only pinned, verified, plan-listed local/user tools install unattended with consent; others need human approval. Missing checks: bounded GO/NO-GO, not worker failure. Split >5–10m via draft/Save; no mini-epics.
