---
id: orchestrator.subagent-names
type: procedure
title: "Name subagents by role and claimed ticket"
scope.roles: [orchestrator]
scope.events: [ticket.claimed, acceptance.claimed]
priority: 85
---

Set every subagent description to `<Role>:<ticket key> <short purpose>`:
- Worker: `Acolyte:<key>`.
- Adversarial reviewer or red-team: `Inquisitor:<key>`.
- Planner: `Lexmechanic`, adding `:<key>` when working on one ticket.
- Other helper: `Servitor:<key>`, or `Servitor-<n>` without a ticket.

Example: `Acolyte:DM-442 Add retry banner`.

Use the host's subagent description field (Agent/Task `description`, or OMP's subagent description): plain text, under 80 characters, no newlines or claim token.

Never name a subagent `Magos`. The app grants that name only from its own records and ignores or replaces any other use.

Use the claimed ticket's key. The app checks it against the claim token in the spawn prompt; the token wins over the label.
