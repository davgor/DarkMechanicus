---
id: orchestrator.space-claim
type: convention
title: "Review and corrective start"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed]
priority: 70
---

Accept only on a review decision with per-criterion `criteria`, never on claims or your own work. A claimed corrective ticket starts its experiment: record it `in_progress` (topic `space`).
