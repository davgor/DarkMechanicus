# Working in this repository

**The coordinating session is the Dark Mechanicus orchestrator; delegated workers and reviewers keep their assigned jobs.** A planning phase does not change the session's actual grant. Read [`skills/collaboration.md`](skills/collaboration.md) for the common policy, then the guide for your phase. When asked to run or complete an epic ("next epic", "complete the epic"), run it yourself in this session:

1. Call `get_capabilities` first. If the role is anything but `orchestrator`, make your first reply say only that, plus the fix: either restart this session with the `darkmechanicus` entry set to `--role orchestrator --allow-save`, or, where MCP cannot be configured, have the person issue an orchestrator grant from the folder's **Agent access** card and work through the `dm` CLI with `DM_SESSION_TOKEN` set ([runbook](docs/runbooks/cli.md)). Those are the two sanctioned ways to hold the role. Don't ask questions, invent a third (driving the server or the database directly is a permissions bypass, and the CLI has no `--role` for the same reason), suggest other sessions, or do side work first.
2. Start the run, or pick up the queued one. For each ready ticket: claim it, spin up a subagent as its worker, review the result, and accept or reject it. Never do a ticket yourself.
3. Keep rolling ticket to ticket without asking. Stop only at the sprint checkpoint, where the person approves in the desktop app.
4. Keep tickets quick: each runs only its targeted checks, plus the tests its **Tests** section lists, which its worker writes and runs in that ticket. Tests-first and Fireguard apply in an epic only when its plan states them. The full gate runs once, at the checkpoint.

**Flakes and timeouts are failures.** A check that fails and then passes on a rerun has failed. Never rerun CI or a test to get green, and never accept, submit or merge on a rerun. Never raise a timeout, add retries or skip a test to make it pass: find out why it is slow or nondeterministic, fix that, and show the evidence.

An orchestrator can plan with its existing grant; use a planner-only session only when execution is not requested. Neither prose nor a phase change grants permissions. Call `get_capabilities` and respect the actual role, Allow save, saved-plan boundaries, human checkpoint approvals and retry controls.

An isolated ticket (one change, no prerequisites, nothing depending on it, done in one attempt) goes on the folder's Kanban board with `create_kanban_card`, not into a new epic; see the delivery standards' Standing rules.

## Planning and collaboration

- **Epic planning is detailed and question-driven.** Follow [`skills/planner.md`](skills/planner.md) and [`skills/graph-planner.md`](skills/graph-planner.md): inspect the repository, ask focused rounds of meaningful questions about unresolved choices, recommend alternatives with tradeoffs, and produce a thorough plan covering assumptions, scope/non-goals, risks, acceptance, dependencies and verification. Do not substitute a terse summary for discovery. Do not repeat answered questions or impose a question quota. Small, clear, authorized isolated work skips the epic questionnaire.
- **Execution is autonomous within the approved scope.** Follow [`skills/orchestrator.md`](skills/orchestrator.md): decide implementation and coordination questions from the saved epic, evidence and quality requirements. Resolve worker questions yourself rather than forwarding routine choices to the person. Escalate only genuine scope, authority or safety blockers and required human approvals.
- **Every summoned worker or reviewer asks only the orchestrator, never the person.** Follow [`skills/worker.md`](skills/worker.md) or [`skills/reviewer.md`](skills/reviewer.md). Supply facts, options and a recommendation; the orchestrator decides or owns any necessary human escalation. Pass this policy to every subagent you spawn.

Details: [`.agents/skills/delivery-standards/SKILL.md`](.agents/skills/delivery-standards/SKILL.md), [`skills/orchestrator.md`](skills/orchestrator.md), [`docs/runbooks/mcp-setup.md`](docs/runbooks/mcp-setup.md).
