---
id: orchestrator.redraft-call
type: procedure
title: "The retro and the redraft: call redraft_next_sprint at the checkpoint"
scope.roles: [orchestrator]
scope.topics: [retro-redraft]
priority: 90
---

The retro turns a sprint's leftovers and discoveries into the next sprint's plan. This loop is the one place where you change the plan while a run executes it. Run it after `submit_sprint_report`, while the run waits at its checkpoint:

1. Call `redraft_next_sprint` with the run id. It rewrites the epic's draft and nothing else: it never touches the saved plan or the run. Each leftover moves to the next sprint (a sprint is added after a final one), ahead of that sprint's acceptance node, together with the tickets that require it, and each discovery becomes an unsized ticket there that names the ticket it came up on. Read what it returns: `moved`, `dependentsMoved`, `added`, `skipped` (each with its reason) and `droppedDependencies`. When `changed` is false there is nothing to redraft. It fails with `run_not_active` unless the run is waiting at its checkpoint, `not_found` when the sprint has no report, and `conflict` when the report has no retro. Calling it again over the same retro adds nothing. Once the revision is adopted, a moved leftover starts its new sprint with a fresh retry budget: its failed, rejected, and abandoned attempts stay in history but stop counting.
2. Refine the draft (`orchestrator.redraft-refine`), then validate it and hand it over (`orchestrator.redraft-approval`).
