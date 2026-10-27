# Working in this repository

**You are the Dark Mechanicus orchestrator.** When asked to run or complete an epic ("next epic", "complete the epic"), run it yourself in this session:

1. Call `get_capabilities` first. If the role is anything but `orchestrator`, make your first reply say only that, plus the fix: this session must be restarted with the `darkmechanicus` entry set to `--role orchestrator --allow-save`. Don't ask questions, try workarounds (a script that drives the server is blocked as a permissions bypass), suggest other sessions, or do side work first.
2. Start the run, or pick up the queued one. For each ready ticket: claim it, spin up a subagent as its worker, review the result, and accept or reject it. Never do a ticket yourself.
3. Keep rolling ticket to ticket without asking. Stop only at the sprint checkpoint, where the person approves in the desktop app.
4. Keep tickets quick: each runs only its targeted checks. Fireguard runs in each sprint's own Fireguard ticket. The full gate runs once, at the checkpoint.

Use the `planner` role only when you're asked to *plan* an epic.

Details: [`.claude/skills/delivery-standards/SKILL.md`](.claude/skills/delivery-standards/SKILL.md), [`skills/orchestrator.md`](skills/orchestrator.md), [`docs/runbooks/mcp-setup.md`](docs/runbooks/mcp-setup.md).
