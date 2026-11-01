# 0004 — Source control in the desktop's main process

- **Status:** accepted
- **Date:** 2026-11-01

## Context

Dark Mechanicus only ever asked Git read-only questions: core's adapter (`src/core/repo/git.ts`) reads branches,
commits and ancestry to verify epic branches and sprint increments, and it never writes. People still had to leave
the app to see their changes, commit, sync, switch branches or open a pull request. The desktop gained a Source
control view per folder, in the manner of GitHub Desktop, which writes to Git when the person asks it to. Where that
code runs, what it may run and how it authenticates had to be settled so that agents, MCP and core stay unaffected.

## Decision

- **Git writes live in main, behind their own bridges.** Every person-initiated git operation runs in the Electron
  main process, in `src/main/git` (status, diffs, commits, history, discard, fetch, pull and push, branches, stashes,
  conflicts, clone) and `src/main/github` (the account, the GitHub API and pull requests). The renderer reaches them
  only through the preload bridges `window.git` (`git:*` channels, progress on `git:progress`) and `window.github`
  (`github:*` channels, account changes on `github:accountChanged`), whose contracts are `src/shared/git/api.ts` and
  `src/shared/github/api.ts`. They sit outside `src/core` and `src/mcp`: no MCP tool and no agent's `dm` grant can
  reach them, and core's adapter stays read-only.
- **The change model is the working tree compared with HEAD.** The view lists what differs between the working tree
  and HEAD and shows that diff; there is no staging area to manage. A commit puts the chosen files (or the chosen
  lines, applied as a patch with `git apply --cached`) in the index and commits them.
- **Pull only merges.** Pull is `git pull --no-rebase --no-edit`; it never rebases. Push publishes a branch that has no
  upstream and never forces.
- **Discard moves content to the trash.** Before git overwrites or removes a discarded file, a copy of it is moved to
  the OS trash (`shell.trashItem`), so a discard can be undone from there.
- **Which programs run.** Main runs `git` found on `PATH`, without a shell, with `core.fsmonitor=false` on every call
  (no fsmonitor hook runs on an automatic refresh) and `--no-ext-diff --no-textconv` on every diff it reads (no
  configured external diff or textconv driver runs). Commits run the repository's own hooks, as `git commit` does
  anywhere else. Paths from the renderer reach git after `--literal-pathspecs ... --`, so a name like `:/a` or `*`
  never acts on other files, and refs pass `refArg` and `git check-ref-format --branch`. A clone accepts only
  `https://`, `ssh://`, `user@host:path` and GitHub's `owner/repo`, and git runs with `GIT_ALLOW_PROTOCOL=https:ssh`.
  Terminal, askpass and Git Credential Manager prompts are turned off, so git never waits on a prompt; a network
  operation that prints nothing for 60 seconds ends with `timeout`.
- **Sign-in reuses the GitHub CLI login.** **Sign in** runs `gh auth token --hostname github.com` (the GitHub CLI,
  found on `PATH` or in its usual install folders), checks the token with `GET /user` (it must carry the `repo` scope)
  and stores an encrypted copy. There is no OAuth App, no device flow and no client ID.
- **The token copy is encrypted with `safeStorage`.** The account is kept in `userData/github-account.json` with the
  token encrypted by Electron's `safeStorage`; without OS encryption, sign-in refuses (`secure_storage_unavailable`).
  The token stays in main: no IPC result, log line or error carries it, and git output is scrubbed of it.
- **Credentials reach git through the environment, scoped to `https://github.com`.** For an `https://github.com/...`
  remote while signed in, git gets a credential helper that echoes `DM_GITHUB_LOGIN` and `DM_GITHUB_TOKEN` from its
  environment, after every other helper for that host is cleared, so no other helper answers or stores the token and
  the token never appears in an argument. Every other remote (SSH, other hosts) uses the machine's own credentials.

## Consequences

- People commit, sync, branch, resolve conflicts, clone and work with pull requests without leaving the app.
- Agents and MCP gain no git write access: an agent that wants to commit uses git itself, in its own chat or host.
- Git and the GitHub CLI are prerequisites of the view, not of the app: without git the view says so, and without
  `gh` sign-in names the GitHub CLI to install.
- Signing out deletes only the app's copy of the token; the grant stays valid on GitHub until the person revokes it
  (see [the sign-in runbook](../runbooks/github-sign-in.md)).

## Known limits

- **github.com only.** The account, pull requests and the scoped credential helper cover github.com; GitHub
  Enterprise hosts use the machine's own credentials and show no pull requests.
- **One repository per view.** Source control works on the repository a folder is in. A folder of repositories
  (see [0003](0003-multi-repo-folders.md)) is no repository itself, so its view shows none of its children; open a
  child repository as its own folder to use Source control there.
- **The token is visible to what git starts.** Hooks, LFS, ssh and remote helpers inherit the environment that holds
  the token during a GitHub HTTPS operation; these are local programs the person runs anyway.
