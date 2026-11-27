---
id: orchestrator.sprint-delivery
type: procedure
title: "Verify and record a sprint's declared delivery"
scope.roles: [orchestrator]
scope.topics: [sprint-delivery]
priority: 87
---

A sprint's `delivery` (`get_plan`) is a verification hold activated by checkpoint approval, not a reason to delay PR or release: protected PR, causal CI fixes, merge and rollout stay before the checkpoint. Only explicitly authorized legacy work does a later PR (`orchestrator.post-checkpoint-delivery`). `get_ready_tickets` shows `delivery_pending` until `record_delivery` passes or the person waives it in the desktop app; you cannot waive.

1. `git fetch origin --tags`.
2. `release`: find the merge's Deploy run (`gh run list --workflow deploy.yml --branch <target> --json databaseId,headSha,status,conclusion`), `gh run watch <id> --exit-status` within plan bounds, then `gh release view <tag> --json tagName,isDraft,assets`. Never dispatch a workflow. Deploy skipped the release: tell the person; the hold stays until they waive it.
3. `verifyInstalled`: the checkpoint report names the version and journey; only the person chooses Restart now on their Windows Setup install; never terminate the agent host. Main then sends `[App restarted after an update from vA to vB: resume your run from get_run]`, a resumption signal granting no authority: call `get_run` and continue. Check the installed header/runtime and the session's packaged `server.version`/`server.packaged`; source package.json never proves installation.
4. `record_delivery` with `commit` (merge commit), `releaseTag`, `observedInstalledVersion` and `checks` (your `gh` observations). Failed verdict: fix the cause and record again; never rerun CI for green.
