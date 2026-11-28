---
id: orchestrator.acceptance-round
type: procedure
title: "The acceptance round: run the Definition of Done on the combined work"
scope.roles: [orchestrator]
scope.events: [acceptance.claimed]
priority: 90
---

The sprint's acceptance node is ready when every required work ticket is accepted and no row check is failing. Claim it like any ticket, but keep the claim token: its worker gets the integration worktree and returns its evidence to you. The packet lists the project's Definition of Done (`get_project` shows it too).

1. The worker runs every Definition of Done check on the combined work, by default in CI for the pushed integration branch (`npm run verify:ci`), and reports each under its exact name in `evidence.checks`. When the plan gave a slow check its own ticket, take that check from that ticket's accepted result instead of re-running it, and say so in the check's detail.
   Use isolated fixture roots/resources and owned cleanup, not shared-directory snapshots. For heavy local checks follow the orchestrator guide's mail reservation: owner, scope, deadline, acknowledged overlap resolution and release. No global lock or silence-based slot. Diagnostics preserve failed gates and cannot replace acceptance.
2. The worker also verifies each item the acceptance criteria cover, with the screenshot, measurement or end-to-end check each criterion names.
3. Review that evidence against the node's criteria before anything reaches the epic branch.
4. Land and submit the sprint (`orchestrator.acceptance-landing`).

In a folder of repositories, also follow `get_context` topic `folders-of-repositories`.
