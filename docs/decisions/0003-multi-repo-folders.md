# 0003 — Folders of repositories

- **Status:** accepted
- **Date:** 2026-10-31

## Context

Dark Mechanicus assumed one Git repository per folder: a Workspace opened per repository root, the
epic branch named one repository and one start commit, a sprint landed as one squashed commit, and the
project had one Definition of Done. Work often spans several repositories that sit side by side in one
parent folder (a service, its client, its infrastructure). Planning that work meant one project per
repository and no single epic across them.

[0002](0002-storage-modes.md) added a database-only storage mode, which writes nothing into the folder.
That makes it possible to set up a folder that is not itself a repository.

## Decision

A folder can be set up as a **folder of repositories** (`initialize_repository` with
`layout: "multi_repo"`, or **Folder of repositories** in the app's set-up screen).

- **Database mode only.** Such a folder is stored in the database only (`db` mode); `repo` mode is
  refused, as is a folder that is itself inside a Git repository, or one that holds no repositories.
- **Immediate children only.** The repositories are the folder's immediate subfolders that hold a `.git`
  entry (a directory, or a file for a worktree or submodule checkout). Hidden folders and symlinks are
  skipped, nothing deeper is examined, and a folder whose name is not a valid repository name is left out.
  `project.json` records them under `repositories`; `rescan_repositories` (the **Rescan** button) appends
  new ones and marks gone ones `missing`, and never removes an entry.
- **One repository per work ticket.** Every work ticket names one repository in `repo`; plan validation
  reports a missing, unknown or not-allowed `repo` as an error and a repository a rescan marked missing as
  a warning. An acceptance node names none: it covers every repository its sprint touched.
- **A title prefix the server keeps.** A ticket targeting `alpha` is titled `alpha - <description>`. The
  prefix is the exact repository name followed by ` - `; the server keeps it in step with `repo`, so a
  planner supplies only the description.
- **One branch name, a start commit per repository.** The folder has no checkout, so the epic branch name
  comes from the epic or from `start_run`, and the epic's own `branch` has no repository and no start
  commit. Each repository the saved plan's work tickets name is bound to that name once, with its own
  start commit (the existing branch of that name, else its HEAD), in the epic's `repositoryBranches`. A
  bound repository is never rebound.
- **Packets carry the repository.** A work ticket's packet names its repository's path and bound branch;
  a claim is refused when the repository is missing or unbound. An acceptance node's packet lists the
  sprint's touched repositories.
- **Per-repository increments and Definition of Done.** The acceptance node names one increment
  `{ repo, branch, commit }` per touched repository; the server verifies each in its own repository and
  the increment gate needs every touched repository's verdict to pass. Each repository has its own
  Definition of Done (`set_definition_of_done` with `repo`), and the node reports each check as
  `<repo>: <check>`.

## Consequences

- One epic plans and runs work across several repositories, with one database for the folder.
- Nothing is written into the folder or its repositories by Dark Mechanicus; the orchestrator creates
  the epic branches and worktrees with Git (see [`skills/orchestrator.md`](../../skills/orchestrator.md)).
- A folder of repositories has no branch guard: there is no coordinating checkout to watch, so switching
  a child repository's checkout does not pause a run. The orchestrator works in worktrees instead.
- A single-repository project is unchanged: no `repositories` key, no `repo` on tickets, one increment
  and one Definition of Done.

## Known limits

- **A renamed child is marked missing.** Repositories are recorded by folder name. Renaming one makes a
  rescan mark the old name `missing` and add the new name as a new repository; tickets keep the old name.
- **No Source control tab.** The desktop app shows no Source control view for a folder of repositories;
  use Git in each repository.
- **Nested repositories are ignored.** Only immediate children are detected; a repository deeper in the
  tree is not part of the folder.
