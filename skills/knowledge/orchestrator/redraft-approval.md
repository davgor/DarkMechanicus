---
id: orchestrator.redraft-approval
type: procedure
title: "Validate the redraft and hand it to the person to approve"
scope.roles: [orchestrator]
scope.topics: [retro-redraft]
priority: 80
---

After refining the draft (`orchestrator.redraft-refine`):

1. Call `validate_plan` with `view: "draft"`. Fix every error and read every warning, including the run-aware ones about passed sprints and about a new sprint placed before the active one.
2. Tell the person that the retro and the redraft are ready to approve in one step. Say what the redraft changed: where the work moved to, which tickets moved and which were added, and what was skipped and why. The person reviews the draft in the desktop app and presses **Approve retro & redraft**, which saves the draft, adopts the new revision, recomputes the gate on it, approves the report, and advances, all or nothing after the save. Do not call `save_plan` or `adopt_revision` yourself in this loop, and never try to approve: only a person can.

The gate backs this up. `plan_current` stays unmet while the draft holds unsaved changes or a saved revision is not adopted, so a run cannot advance past a plan nobody saved. A report goes stale after an adoption that changed the sprint's exit criteria or required tickets by more than moving the retro's leftovers out: `report_submitted` is then unmet and you submit a new report revision. A redraft that only moves leftovers and adds tickets to later sprints leaves the report current.
