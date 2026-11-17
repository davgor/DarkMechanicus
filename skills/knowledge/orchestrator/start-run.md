---
id: orchestrator.start-run
type: procedure
title: "Start the run on the saved revision"
scope.roles: [orchestrator]
scope.events: [run.started]
priority: 85
---

`start_run` with the `epicId`, your `host` label and type, the `hostCatalogId` (the `id` that `register_host` returned), and the epic `branch` if known. It pins the current saved revision and activates sprint 1, and it records the skills version unless you pass another. If a person already queued a run in the desktop app it picks that up. If it fails with `active_run_exists`, use `get_run` with the `epicId` and continue that run.
