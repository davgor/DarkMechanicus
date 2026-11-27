---
id: orchestrator.register-host
type: procedure
title: "Register the host with what it can really use"
scope.roles: [orchestrator]
scope.events: [run.started]
scope.topics: [host-catalog]
priority: 90
---

`register_host` with what this host can really use: its tools, whether it can choose the worker model (`canSelectWorkerModel`), and each available model with its reasoning levels, cost tier (`low`, `normal`, `high`), modalities, context window, skills, and the `efforts` it can run at (`low`, `medium`, `high`). List only efforts your host can really set: a claim at an unlisted effort is refused. Register every tool the host really has (including `network` and `browser`) before `start_run`, because the run's catalog is fixed at start. Register again with a new `catalogRevision` when this changes. Do not list models you cannot use. In Skitarii: `orchestrator.skitarii-worker-models`.
