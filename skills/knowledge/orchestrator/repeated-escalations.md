---
id: orchestrator.repeated-escalations
type: procedure
title: "Report repeated escalations as a profile proposal"
scope.roles: [orchestrator]
scope.events: [attempt.rejected, attempt.failed]
scope.topics: [plan-changes]
priority: 70
---

Report repeated escalations. If the same kind of ticket keeps needing a step up, make it a profile proposal in the sprint report: its size, level, or effort was probably set too low. If one ticket is rejected at several steps, it may need splitting, or it may be waiting on a design question: when its retry limit blocks it, retry it from that different angle with `retry_ticket` (the split, the design change, the tier change or the environment fix as its `newApproach`) instead of asking the person. Tell the person only on `retry_escalation_required`, with why it keeps failing, and record each retry's reason in the sprint report.

If tickets keep needing the same capability correction (for example deeper reasoning for one kind of work), say so in the sprint report and propose updating the named profile (`get_profile`, then `save_profile` with its `revision`). Changing a profile never changes tickets that already copied it.
