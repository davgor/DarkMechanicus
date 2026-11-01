# Sign in to GitHub

Source control signs in to GitHub with this computer's GitHub CLI login. Dark Mechanicus has no OAuth App
of its own and never asks for a password: it copies the github.com token the GitHub CLI already holds. The
decision behind it is in [0005 — Source control in the desktop's main process](../decisions/0005-source-control-in-main.md).

The account is used for the GitHub.com tab of **Clone repository…**, for pull requests, and for fetch, pull,
push and clone over `https://github.com/...`. SSH remotes and other hosts use the computer's own credentials
(its credential helpers, the keychain, the SSH agent) whether or not you are signed in.

## Sign in

1. Install the GitHub CLI from <https://cli.github.com>. Dark Mechanicus looks for `gh` in every absolute
   `PATH` entry, then in its usual install folders: `/opt/homebrew/bin` and `/usr/local/bin` on macOS,
   `%ProgramFiles%\GitHub CLI` and `%LOCALAPPDATA%\Programs\GitHub CLI` on Windows, `/usr/bin` and `/snap/bin`
   on Linux. On Windows it runs only `gh.exe`.
2. Sign the GitHub CLI in once, in a terminal:

   ```sh
   gh auth login -h github.com
   ```

   gh 2.17 or later is needed.
3. In the app, press **Sign in to GitHub** at the bottom of the sidebar (or the sign-in link Source control
   shows), then **Use my GitHub CLI login**. The app runs `gh auth token --hostname github.com`, checks the
   token it prints with GitHub's `GET /user`, and stores an encrypted copy. The sidebar then shows `@<login>`.

The `GH_TOKEN` and `GITHUB_TOKEN` environment variables are ignored: the app copies the login gh stored, not
a token set in a shell. If gh is missing, not signed in, or does not answer within 15 seconds, sign-in stops
and says which; the dialog's **Try again** repeats it.

## Scopes

- `repo` is required. Without it sign-in refuses with "it lacks the repo scope".
- `workflow` is needed to push changes to files under `.github/workflows/`; GitHub refuses such a push
  without it.

`gh auth login` grants `repo` by default, but not `workflow`. To add both to an existing login, run:

```sh
gh auth refresh -h github.com -s repo,workflow
```

Then sign out in the app and sign in again, so it copies the refreshed token.

## Where the copy is kept

The account is kept in `userData/github-account.json`: the login, the name, the scopes GitHub reported, and the
token encrypted with Electron's `safeStorage` (the macOS Keychain, Windows DPAPI, or the Linux secret store).
`userData` is `~/Library/Application Support/<app name>` on macOS and `%APPDATA%\<app name>` on Windows (see
[the agents runbook](agents.md)). The token is never written in plain text: on a computer without OS
encryption, sign-in refuses. It stays in the main process; no window, log line or error carries it.

During a fetch, pull, push or clone of an `https://github.com/...` URL, git reads the token from its
environment through a credential helper scoped to `https://github.com`. No other credential helper sees it or
stores it.

## Sign out and revoke

- **Sign out** (the `@<login>` menu in the sidebar) deletes `userData/github-account.json` and nothing else.
  The GitHub CLI stays signed in, and the token stays valid on GitHub.
- To end the grant itself, sign the GitHub CLI out:

  ```sh
  gh auth logout -h github.com
  ```

  or open **Manage access on GitHub** from the same menu (<https://github.com/settings/applications>) and
  revoke the GitHub CLI's access there. A token GitHub no longer accepts signs the app out the next time it is
  used (GitHub answers 401).

## Troubleshooting

| Message | What to do |
|---------|------------|
| The GitHub CLI (gh) is not installed | Install it from <https://cli.github.com>; check that `gh` is in one of the folders above |
| The GitHub CLI is not signed in to github.com, or is older than 2.17 | Run `gh auth login -h github.com`, updating gh first if needed |
| it lacks the repo scope | Run `gh auth refresh -h github.com -s repo,workflow` |
| GitHub refused the GitHub CLI's token | The login has expired or was revoked: run `gh auth login -h github.com` |
| no secure storage to encrypt the GitHub token | The OS offers no encryption to this app (on Linux, no secret store is running); sign-in is not possible here |
