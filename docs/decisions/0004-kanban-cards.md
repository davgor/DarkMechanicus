# 0004 — Kanban cards: a per-folder board of isolated tickets

- **Status:** accepted
- **Date:** 2026-11-01

## Context

Every piece of work in Dark Mechanicus was an epic: a goal, a plan of tickets in sprints, a run,
checkpoints and a retro. That machinery earns its cost when tickets depend on each other and a
person approves each sprint. It is all overhead for an isolated ticket: one coherent change with no
prerequisites and nothing depending on it, which one worker can finish in one attempt. Planning such
a change as a one-ticket epic adds a draft, a Save, a run and a checkpoint report around a single
review, and it fills the folder's epic buckets with entries that are not plans.

## Decision

### A first-class card entity

A Kanban card is its own entity, not an epic and not a plan ticket: table `kanban_cards` (schema
v13), ids with the `kc` prefix. It carries what a worker and a reviewer need (title, Markdown body,
acceptance criteria, expected artifacts, references, priority, size) and nothing a plan needs
(sprints, dependencies, capability profiles, plan revisions). Its display key comes from the
project's ticket sequence, so a card and a plan ticket never share a key.

The agent guides route work by this rule: an isolated ticket, meaning one coherent change with no
prerequisites and nothing depending on it that one worker can finish in one attempt, goes on the
folder's Kanban board with `create_kanban_card`, not into a new epic. Work that needs two or more
tickets, ordering or sprints stays an epic. Agents create and edit cards; only a person presses
Play, approves or kicks back. Follow-ups and bugs found during a sprint stay in that epic's plan or
retro.

### Fixed lanes, with the agent as the mover

The board has four fixed lanes: Backlog, In progress, Ready for review and Done. They are not
configurable, and nobody drags a card between them: a card moves only through its transitions.
Creating a card puts it in Backlog. The agent moves it: claiming takes it to In progress, and
submitting takes it to Ready for review. Failing or a lease expiry leaves it In progress.

### A person presses Play and reviews

Starting a card and judging its result belong to a person in the desktop app. `kanban.play` and
`kanban.review` are human-only capabilities: no agent role, MCP tool, grant or `dm` session holds
them. A claim needs a pending Play (`play_required` otherwise), so an agent cannot start work on a
card by itself. After a submission the person approves the card to Done or kicks it back with a
comment; a kick-back rejects the attempt, returns the card to In progress with a pending Play, and
the next attempt's packet carries every earlier comment. Pressing Play starts an agent as the
card's orchestrator, which claims it, hands it to one worker, reviews, submits and stops.

### The checked-out branch

A card has no epic branch and no sprint integration branch. Its work happens on the branch that is
checked out in the folder when the card is claimed, and the packet names it. Isolated work does not
need a branch of its own; integrating it is the person's call, as for any change on that branch.

### Compaction: slim views, records kept

Done grows without bound, so the board shows slim summaries only (never a body, criteria or
evidence) and pages Done newest first. Approving compacts a card: it records a compact summary (the
submission summary on one line, at most 280 characters, the commits, when it completed and who
approved it), which is what the Done lane shows. Compaction is a view, not a deletion: the card's
full content, every attempt and every event stay recorded, and `get_kanban_card` returns them.

### Both storage modes

Cards follow the folder's [storage mode](0002-storage-modes.md). In `repo` mode they are portable
records under `.darkmechanicus/kanban/<cardId>/`: `card.json` for the card, and an `events/`
directory for its events, so cards travel with the repository like epics and are rebuilt from those
records on clone. Claim secrets and leases never enter them. In `db` mode they live only in the
folder's machine-local database, and nothing is written into the repository.

## Consequences

- Isolated work skips the draft, Save, run and checkpoint, and keeps one human review per attempt.
- The epic buckets list only epics; the sidebar shows the board as its own **Kanban** row between
  Backlog and Completed.
- The routing rule lives in every agent-facing guide (the delivery standards, the planner,
  orchestrator and worker skills), so the choice between a card and an epic is made the same way
  everywhere.
- Cards have no dependencies. Work that turns out to need ordering is moved into an epic instead of
  being chained across cards.
- A card shares the checked-out branch with whatever else happens there, so two cards played at once
  in one folder can touch the same files. The person decides when to press Play.
