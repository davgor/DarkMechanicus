# Work across a folder of repositories

A folder of repositories is a parent folder whose immediate subfolders are Git repositories. One project
covers all of them: each work ticket targets one repository, and an epic runs across them. The decisions
behind it are in [0003 — Folders of repositories](../decisions/0003-multi-repo-folders.md).

## Set up

1. Put the repositories side by side in one folder. The folder itself must not be inside a Git
   repository, and must hold at least one repository as an immediate subfolder.
2. Open the folder in the desktop app and choose **Folder of repositories** on the set-up screen. It lists
   the repositories it detected. From an agent, call `initialize_repository` with `layout: "multi_repo"`.
3. The project is stored in the database only (`db` mode); nothing is written into the folder or its
   repositories.

What counts as a repository: an immediate subfolder (not a symlink, not hidden) that holds a `.git` entry,
whose name is a valid repository name. Deeper repositories are ignored.

Each repository can have its own Definition of Done: `set_definition_of_done` with `repo` set to the
repository's name.

## Rescan

When you add, remove or rename a repository, press **Rescan** on the folder's **Repositories** card, or call
`rescan_repositories`. New repositories are appended; recorded ones that are gone are marked missing (and
lose the mark when they return). No entry is removed. A renamed repository shows as the old name missing
plus a new one.

A ticket that targets a missing repository is a plan-validation warning, and its claim is refused until the
repository is back.

## Plan

- Give every work ticket its `repo`. A ticket without one, or naming a repository the project does not list,
  fails validation. Acceptance nodes take no `repo`.
- Write only the description as the title: the server adds and keeps the `<repo> - ` prefix
  (`api - Add refund endpoint`).

## Run

- Set the epic branch name before the run (the **Epic branch** field when you start a run, or the
  epic's branch): the folder has no checkout to take it from, and a run without one is refused.
- `start_run` binds that branch name in each repository the saved plan's work tickets name, each with its
  own start commit (the existing branch of that name, else the repository's HEAD). `get_epic` lists them
  under `repositoryBranches`.
- The orchestrator creates each missing epic branch at its start commit and works in worktrees, one set per
  touched repository; it never switches a child repository's own checkout, because a folder of repositories
  has no branch guard. Each worker's packet names its repository's path and branch. See
  [Folders of repositories in the orchestrator guide](../../skills/orchestrator.md#folders-of-repositories).

## Read per-repository results

- **Increments.** At the sprint's acceptance node the orchestrator squashes each touched repository's work
  onto its epic branch and names one increment `{ repo, branch, commit }` per repository. The server
  verifies each in its own repository. The checkpoint's increment gate is met only when every touched
  repository passes; otherwise it names each repository with no increment or a failing one.
- **Definition of Done.** The acceptance node's packet lists each touched repository with its checks, and
  its worker reports them as `<repo>: <check>` (for example `api: lint`). The `definition_of_done` gate
  reads them by that name.
