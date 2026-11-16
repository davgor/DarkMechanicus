---
id: orchestrator.repo-folders-workers
type: procedure
title: "Folders of repositories: workers, landing, Definition of Done and the redraft"
scope.roles: [orchestrator]
scope.topics: [folders-of-repositories]
priority: 85
---

In a folder of Git repositories (`orchestrator.repo-folders-branches`), each step happens per repository:

- **Workers.** Give each worker a worktree of its packet's `repository.path`, branched from that repository's sprint integration branch. The acceptance node's packet lists the sprint's touched repositories under `repositories`.
- **Landing.** Squash each touched repository's sprint work onto its epic branch, in a worktree of that repository on the epic branch, as one commit with one parent. Submit the acceptance node with `increments`, one `{ repo, branch, commit }` per touched repository, instead of a single `increment`. The server verifies each one in its own repository, and the gate needs every touched repository's verdict to pass.
- **Definition of Done.** Each repository has its own checks. The node's worker reports each as `<repo>: <check>`.
- **The redraft.** Give every ticket added in a retro redraft its `repo` before you save the draft.
