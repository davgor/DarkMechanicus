---
id: orchestrator.kanban-launch
type: procedure
title: "Starting Kanban cards: desktop Play or an explicit launch of named cards"
scope.roles: [orchestrator]
scope.events: [kanban.claimed]
priority: 80
---

When a person presses Play on a card, the desktop starts a chat for you with the card's id. An authorized external orchestrator explicitly asked to run cards may instead call `launch_kanban_cards` with `{"cardIds":["kc_…"]}` for one card or a nonempty list for a batch. Never infer launch-all: name the cards requested. Launch queues the same pending Play without spawning desktop chats; it creates no attempts. The whole batch is validated atomically and returns per-card errors in `details.cards` on refusal. Duplicate IDs and repeated pending launches are no-ops. Active attempts, Ready for review and Done are refused, never reset. Reader, planner, worker and reviewer sessions cannot launch; CLI grants are checked before every command. A card has no run, sprints or checkpoints.
