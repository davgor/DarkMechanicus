---
id: orchestrator.repo-folders-branches
type: procedure
title: "Folders of repositories: one epic branch per repository; never switch a child checkout"
scope.roles: [orchestrator]
scope.topics: [folders-of-repositories, integration-worktree]
priority: 90
---

When the project is a folder of Git repositories, each work ticket targets one repository (its `repo`), and everything in setup, the execution loop, integration and the acceptance round happens per repository. The single-repository text still applies to each repository on its own.

- **The epic branch per repository.** `start_run` binds the epic branch in each repository the plan names; `get_epic` lists them under `repositoryBranches`, each with its `startCommit`. When a repository has no epic branch yet, create it at that repository's `startCommit`: `git -C <path> branch <name> <startCommit>`.
- **Never switch the branch of a child repository's own checkout.** A folder of repositories has no branch guard, so nothing pauses the run if you do; leave every child checkout where the person left it. Keep the sprint integration branch, the workers' worktrees and the landing on the epic branch in worktrees, one set per touched repository, and run every command as `git -C <worktree>`.
- Workers, landing, checks and the redraft: `orchestrator.repo-folders-workers`.
