---
id: orchestrator.kanban-run
type: procedure
title: "Run a claimed Kanban card through one worker and never approve it"
scope.roles: [orchestrator]
scope.events: [kanban.claimed]
priority: 90
---

1. Call `claim_kanban_card` with the card id. It needs pending desktop Play or authorized external launch (`play_required` otherwise) and returns the packet: the card, the checked-out branch, every earlier kick-back comment and a claim token. Launch is not claim or approval; claim creates the leased attempt.
2. Hand the packet to one worker subagent, with the worker guidance and the rule that it reports back to you instead of calling `submit_kanban_card` or `fail_kanban_card`. The claim token is a secret, as for tickets.
3. The worker works on the checked-out branch and commits there. Keep calling `heartbeat_kanban_card` until you submit, so the claim does not expire.
4. Review the work against the card's acceptance criteria and the Definition of Done. Send it back to the worker until it meets them.
5. Call `submit_kanban_card` with outputs and evidence for each criterion, which moves the card to Ready for review, or `fail_kanban_card` with the reason when it cannot be done.
6. Stop. Never approve a card or kick it back: only a person does that, in the desktop app. A kick-back comes back as a new message; claim the card again and address every comment.
