---
id: orchestrator.skitarii-worker-models
type: procedure
title: "In Skitarii, register the catalog the app wrote and start each worker on its claimed model"
scope.roles: [orchestrator]
scope.topics: [host-catalog]
priority: 85
---

When you run in Skitarii (OMP), do not type the catalog. Your kickoff names `host-catalog.json` in your chat's own private folder, which the app wrote from OMP's model catalog: the latest model of each line plus the model you run on. Pass its JSON to `register_host` as written, with `canSelectWorkerModel: true`; drop a tool only if your session really lacks it.

Start each worker with OMP's task tool: set the task item's `model` to the claimed `modelId` (`provider/id`), with the claimed effort as its thinking level after a colon, for example a `tasks` item `{"task": "...", "solutionSpace": "...", "model": "anthropic/claude-haiku-5-5:low"}`. The app turns this on (`task.perCallModel: on`) for orchestrator chats only. If the task tool still refuses `model`, register again with `canSelectWorkerModel: false` and a new `catalogRevision`, and claim the model you run on.

When you change models, or the catalog no longer matches what OMP offers, register again with a new `catalogRevision`.
