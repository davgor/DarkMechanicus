---
id: orchestrator.required-leftover-finish
type: procedure
title: "Required leftover: run the node over what remains and report again"
scope.roles: [orchestrator]
scope.topics: [required-leftover]
priority: 85
---

After the person saved the draft and adopted the revision (`orchestrator.required-leftover`):

4. Run the acceptance node over what remains. A run waiting at its checkpoint takes no claims, so call `pause_run` and then `resume_run` to return it to `running`. The node now requires only tickets that are accepted, so it is ready (when no row check is failing): follow the acceptance round (`get_context` event `acceptance.claimed`), squash the sprint onto the epic branch, submit the node with its increment, and accept it.
5. Submit a new report revision with the retro carried again, the leftovers still listed with their reasons. The first report predates the node's acceptance and its increment, and the person approves exactly one report, so it must describe the sprint as it ended. The gate would not force this, because moving leftovers out does not make a report stale.
6. Tell the person the report is ready. The draft was saved and the revision adopted, so `plan_current` is met (provided the draft holds nothing else unsaved) and there is no redraft left to approve: they press **Approve & advance**.

When the leftover is in the final sprint, the redraft adds a sprint after it, and that sprint becomes the final one once the revision is adopted. The active sprint is then no longer the last, so the gate no longer asks for an `epicOutcome`.
