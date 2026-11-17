---
id: orchestrator.repeated-escalations
type: procedure
title: "Report repeated escalations as a profile proposal"
scope.roles: [orchestrator]
scope.events: [attempt.rejected, attempt.failed]
scope.topics: [plan-changes]
priority: 70
---

Report repeated escalations. If the same kind of ticket keeps needing a step up, make it a profile proposal in the sprint report: its size, level, or effort was probably set too low. If one ticket is rejected at several steps, tell the person: it may need splitting, or it may be waiting on a design question.

If tickets keep needing the same capability correction (for example deeper reasoning for one kind of work), say so in the sprint report and propose updating the named profile (`get_profile`, then `save_profile` with its `revision`). Changing a profile never changes tickets that already copied it.
