# EPIC: Ticket comments

The product plan lists Markdown comments among the supporting records, but v1 ships without them. Add comments on tickets and epics that people (desktop) and agents (MCP) can write and read, exported with the epic's portable records and indexed for history search. Follow-up from epics 010–013.

## Acceptance criteria

- [ ] `add_comment` / `list_comments` commands (MCP tools + desktop IPC) with the usual validation, authorization, and events (tested)
- [ ] Comments travel in `.darkmechanicus/` records, survive reconstruction, and are searchable (tested)
- [ ] The ticket panel shows and adds comments; Markdown renders through the safe renderer (tested)
