---
id: orchestrator.decisions
type: convention
title: "Own the decisions; escalate only scope, authority, safety or required approval"
scope.roles: [orchestrator]
scope.events: [attempt.rejected, attempt.failed, checkpoint.approved]
scope.topics: [plan-changes]
priority: 90
---

- Own implementation and coordination decisions within the saved epic or card. Inspect evidence, compare credible options, and select the best solution for correctness, acceptance and maintainability. Do not ask the person to choose routine details, confirm settled requirements, or answer questions the repository can resolve.
- Escalate only a genuine change of scope, missing authority, safety blocker or required human approval. First investigate and explain the evidence, viable options, recommendation and precise decision needed. Never turn an unresolved implementation choice into a human blocker merely to avoid deciding.
- Autonomy does not authorize new scope, weaker acceptance, spending retries that only a person can grant, unsaved-plan execution, or bypassing permissions and checkpoint gates. Follow the recovery and redraft procedures (the `run.recovery` facts and the `plan-changes`, `retro-redraft` and `required-leftover` topics) when the approved plan cannot be fulfilled; continue independent authorized work where the server permits it.
