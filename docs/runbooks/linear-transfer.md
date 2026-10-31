# Transfer an epic to Linear

A Linear transfer hands a saved epic over to a Linear project, once. An agent creates the project,
one milestone per sprint and one issue per ticket, in execution order, with the dependencies as
relations. It then reads the project back from Linear. When the read-back matches the plan, the
epic completes in Dark Mechanicus and Linear becomes the board for that work.

Dark Mechanicus never talks to Linear itself and holds no Linear credential. The agent does the
Linear work with its own Linear MCP server. Dark Mechanicus builds the plan the agent follows,
records what it creates, and checks what it reads back.

## Before you start

You need:

- **A saved plan.** The transfer sends the epic's current saved revision. Save or discard any
  draft changes first.
- **No active run.** Finish or cancel the epic's run first. The epic must not be completed.
- **An agent with Linear's MCP server.** Set it up once in the CLI the agent runs in:

  | CLI | Setup |
  |-----|-------|
  | Claude Code | `claude mcp add --transport http linear-server https://mcp.linear.app/mcp`, then `/mcp` to sign in |
  | Codex | `codex mcp add linear --url https://mcp.linear.app/mcp` |
  | Cursor | Add `https://mcp.linear.app/mcp` in Cursor's MCP settings |

- **An orchestrator session.** Only the `orchestrator` role can carry out a transfer. The in-app
  chat gets it for you. An external agent needs it too; see
  [Start it with an external agent](#start-it-with-an-external-agent).

## Authorize it in the app

Sending a plan to Linear is your decision, so only the desktop app can authorize a transfer. No
MCP tool, grant or `dm` session can queue one or cancel one. An agent can only carry out a transfer
you authorized; without it, `start_transfer` fails with `approval_required`.

Open the epic and press **Transfer to Linear** in its header, beside Start run. The button shows
when the epic has a saved plan, no active run, no open transfer, no unsaved draft changes, and is
not completed. The dialog explains the handoff and offers two choices. Both authorize the transfer
first.

The app also refuses to authorize a transfer for a completed epic, while a run is active, when the
plan was never saved, when the draft has unsaved changes, and while another transfer of the epic
is open.

## Start it with an agent in the app

In the dialog, pick a connected, signed-in agent and a model, then press **Transfer with agent**.
Dark Mechanicus authorizes the transfer, starts the agent as orchestrator in a chat titled
`Linear transfer · <epic title>`, and sends it the transfer prompt. The chat opens. The agent
cannot save plans.

## Start it with an external agent

Use this for an agent you start yourself, outside the app.

1. Give the agent an orchestrator session on this folder: either connect its MCP host with
   `--role orchestrator` (see [Connect an agent host over MCP](mcp-setup.md)), or issue an
   orchestrator grant in the folder's **Agent access** card and give it to the agent's session as
   `$DM_SESSION_TOKEN` or `--token-file` (see [Use the `dm` CLI](cli.md)).
2. Get the transfer prompt, one of two ways:
   - Press **Copy prompt** in the Transfer to Linear dialog. It authorizes the transfer and copies
     the prompt.
   - Run `dm transfer linear --epic ep_…` ([details](cli.md#hand-an-epic-to-linear-dm-transfer-linear)).
     It prints the same prompt, a summary of the packet, the Linear setup lines and how to give the
     agent a grant. It is read-only and does not authorize anything: press Transfer to Linear in
     the app first. Until you do, its first line says the transfer is not authorized.
3. Paste the prompt into the agent's chat.

The prompt carries the transfer guide, the same text the MCP server serves as the
`darkmechanicus-linear-transfer` prompt ([`skills/linear-transfer.md`](../../skills/linear-transfer.md)).

## Sign in to Linear and pick the team

The first time, Linear's sign-in may open in your browser; complete it there. In Claude Code, run
`/mcp` to sign in. The agent then lists your Linear teams and asks in the chat which team to use.
Every issue goes into that team.

In an in-app chat, the agent's tool calls may wait for your approval in the chat, like any other
chat.

## What goes where

Each item's text ends with a marker, `dm:<epic id>/<ref>`, so the item can be found again.

| Dark Mechanicus | Linear |
|-----------------|--------|
| Epic | A project. Name: the epic title. Summary: `From Dark Mechanicus: epic <id>, revision <n>` and the marker, within Linear's 255 characters (only the first line is cut). Description: the epic intent, then the success criteria. |
| Sprint | A milestone, in sprint order. Name: `Sprint <n>: <first line of the goal>`, or `Sprint <n>` without a goal. Description: the goal, then the exit criteria. |
| Ticket | An issue in the chosen team, under its sprint's milestone. Title: the ticket title. Description: the body, an "Optional" line for an optional ticket, the acceptance criteria, the references, then `DM key <key> · epic <id> · revision <n>`. |
| Acceptance node | An issue like any ticket, last in its sprint. A criterion that covers a ticket names that ticket's key. The issue is blocked by every required work ticket of its sprint. |
| Dependency edge | A "blocks" relation: the prerequisite blocks the dependent issue. |
| Related link | A "related" relation, once per pair of issues. |
| Duplicate link | A `Duplicate of <key> (<title>)` line under the issue's References. It is not a relation. |
| Acceptance criteria | A checklist in the issue description: `- [ ] c1 …`. |
| Priority | Linear's priority number: critical 1 (Urgent), high 2 (High), normal 3 (Medium), low 4 (Low). |
| Tags | Labels. The agent reuses a label of the same name and never creates a second one. |
| Status | A ticket completed in Dark Mechanicus gets the team's completed state. Every other ticket stays in the team's default state. |
| Marker | `dm:<epic id>/project`, `dm:<epic id>/<sprint id>` or `dm:<epic id>/<ticket id>`, as the last line of the item's text. |

The packet is built and stored when you authorize the transfer. A transfer that is interrupted
resumes from the same packet, even if ticket statuses change meanwhile.

## The order

Execution order is the order the issues are created in:

- Sprint by sprint, in sprint order.
- Inside a sprint, by dependency row: first the tickets with no prerequisite in that sprint, then
  the tickets one step after them, and so on. Prerequisites in other sprints do not count here.
  Tickets in the same row keep the sprint's order.
- A sprint's acceptance node comes after all of its tickets.
- A ticket listed in more than one sprint goes under the first one.

The agent creates the project, then the milestones in order, then the issues one at a time in
order, then the relations. It records each item right after creating it. Before each create, it
searches Linear for the item's marker and records what it finds instead of creating a second one.
It sets the sort order when its Linear tools allow it.

Linear numbers issues as they are created, so the identifiers (ENG-1, ENG-2, …) should follow the
execution order too. The `identifier_order` warning flags one that does not.

## Verification

When everything is created, the agent reads the whole project back from Linear and sends it to
Dark Mechanicus (`submit_transfer_readback`), in parts if it is large. The last part is marked
final. Dark Mechanicus then compares the read-back with the stored packet and the items the agent
recorded.

A final part always ends the read-back, whatever the result. After a refusal, the agent reads the
whole project back again from the start.

### Mismatches

Any mismatch blocks completion. The epic stays open, and the transfer strip lists the last
read-back's mismatches. The agent fixes each one in Linear by updating the item, or by moving an
unexpected item out of the project. It never deletes anything. Then it reads back again.

| Mismatch | Meaning |
|----------|---------|
| `recorded` | A packet item (the project, a milestone, an issue or a relation) has no Linear item recorded for it. |
| `present` | A recorded item is missing from the read-back. |
| `name` | The project or a milestone has a different name. |
| `url` | The project's URL differs from the recorded one, or none was recorded. |
| `summary` | The project summary lost its marker. |
| `position` | The milestones are not in sprint order. |
| `milestone` | An issue sits under the wrong milestone. |
| `title` | An issue has a different title. |
| `priority` | An issue has a different priority. |
| `labels` | An issue's labels differ (case and order do not matter). |
| `description` | An issue's description lost a line it must keep: a criterion of its checklist (ticked or not), its `DM key` line or its marker. Other edits are allowed. |
| `state` | An issue of a completed ticket is not in a completed state, or an issue of an open ticket is completed or canceled. Open issues may be in triage, backlog, unstarted or started. |
| `relation` | A "blocks" or "related" relation between the transferred issues is missing, or there is one the plan does not have. |
| `unexpected` | A milestone or issue in the project that no packet item recorded. |
| `duplicate` | A marker appears on more than one Linear item, or one Linear item is recorded for two packet items. |
| `team` | The issues are not all in one team. |

Leading and trailing spaces never count as a difference.

### Warnings

Warnings do not block completion. They are listed in the completion comment.

| Warning | Meaning |
|---------|---------|
| `identifier_order` | An issue's identifier number does not come after the one before it in execution order. |
| `sort_order_unreported` | The read-back has no sort order for some issues, so their order in Linear was not checked. |
| `sort_order` | An issue's sort order does not rise above the one before it. |

## Follow it, resume it, cancel it

While the transfer is open, a strip under the epic header shows its status (QUEUED or IN
PROGRESS), how many items are created (`3 of 12 created`), and the last read-back's mismatches.
It offers **Resume**, **Copy prompt** and **Cancel transfer**.

### Resume

An agent can stop part way: a crash, a closed chat, a lost sign-in. Press **Resume**. It opens the
chat already carrying out the transfer, or, when there is none, the Resume transfer dialog to start
an agent on it. **Copy prompt** copies the prompt again for an external agent. Neither authorizes
anything new.

The agent calls `start_transfer` again. It gets the same packet, what is already recorded, and what
is still to do. An unfinished read-back is discarded. Before each create the agent searches by
marker, so an item it created but did not record is found and recorded, not created twice.

### Cancel

Press **Cancel transfer** and confirm. The transfer is canceled, what Dark Mechanicus recorded for
it is cleared, and runs and Save unlock. What was already created in Linear stays there. If you
authorize a transfer again later, the agent finds those items by their markers and reuses them.

### The run/Save lock

While a transfer is queued or in progress, the plan it sends must stay put:

- No run can be queued or started. Start run is hidden.
- No plan can be saved, by you or by an agent.
- Draft edits are still allowed. But a matching read-back cannot complete the epic while the draft
  has unsaved changes: discard them, or cancel the transfer.

A refused run or save says: "Finish or cancel the Linear transfer of this epic first."

## What completion records

A final read-back with no mismatch completes the epic, in one step. Before that, Dark Mechanicus
checks again that no run is active, the saved plan is still the revision it transferred, no save is
pending and the draft has no unsaved changes. If the saved plan changed, cancel the transfer and
authorize it again.

Completion records:

- The epic's status: completed. It is read-only history from then on.
- The epic's outcome: the summary `Transferred to Linear: <project URL>` and a transfer record
  with the target (`linear`), the project URL, the transferred revision, the packet hash, and each
  issue's DM key, Linear identifier and URL.
- A comment on the epic: the project link, the number of milestones, issues and relations that
  match the saved revision, and any warnings.
- The transfer's status: verified.
- An `epic.transferred` event in the epic's history.

The epic workspace then shows **Transferred to Linear**, with **Open the project in Linear**.

## Limits

- **One time.** A verified transfer completes the epic, and a completed epic cannot be transferred
  again.
- **No sync.** Nothing flows back from Linear, and later changes in Dark Mechanicus do not reach
  Linear.
- **No estimates.** Ticket size and capability profiles are not sent, so Linear issues have no
  estimate.
- **Linear only.** Linear is the one target.
- **The check trusts the agent.** Dark Mechanicus has no Linear access. It verifies what the agent
  says it read back from Linear, not Linear itself.

## See also

- [The transfer guide the agent follows](../../skills/linear-transfer.md)
- [The transfer tools and who may call them](mcp-setup.md#linear-transfer)
- [A recorded run against a fake Linear server](../verification/linear-transfer-smoke.md)
- [Why the transfer works this way](../architecture.md#decisions-taken-during-implementation)
