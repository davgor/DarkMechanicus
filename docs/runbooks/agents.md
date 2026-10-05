# Agents: connect, sign in, chat, run

The desktop app can host three agent CLIs: **Claude Code**, **Codex** and **Cursor**. You connect each one (Find it, or Download it), sign in with its own login, chat with it in a tracked folder, answer its approval requests, and start a run with it as the orchestrator. Windows and macOS are supported; there is no Linux install recipe.

This is separate from [connecting an external agent host over MCP](mcp-setup.md), which still works with the desktop closed. How the hosted agents are built is in [`architecture.md`](../architecture.md#hosted-agents).

Dark Mechanicus runs the vendor's own CLI under your own sign-in. It never asks for, shows or stores a password, key or token, and it calls no model API itself.

## Where things are kept

Both live in the app's `userData` folder, outside every repository. Neither is a portable record: they do not travel with a pull, and untracking a folder does not touch them.

| What | Where |
|------|-------|
| Connected agents | `userData/agents.json`: one entry per agent (path, version, found or downloaded, timestamps). Remove deletes only the entry. A corrupt file reads as no agents connected |
| Chats | `userData/agents/chats/<folder key>/index.jsonl` (one line per change of a chat; the last line for an id wins) and `userData/agents/chats/<folder key>/<chatId>.jsonl` (the transcript, one item per line) |
| Credentials | Not kept by Dark Mechanicus. The CLI keeps its own login |

The folder key is the first 24 hex characters of the SHA-256 of the folder's canonical path, so every spelling of a folder finds the same chats. Claim tokens (`at_...`) are masked before anything is written to a transcript or shown. Delete chat removes the transcript and every stored version of the chat's record; nothing is moved to a trash.

`userData` is `%APPDATA%\<app name>` on Windows and `~/Library/Application Support/<app name>` on macOS. A development run on this Windows machine uses `%APPDATA%\dark-mechanicus`; an installed build is expected to use `DarkMechanicus` (the product name), which has not been checked on an installed build.

## Connect an agent

Press **+** next to **AGENTS** in the sidebar. The **Add an agent** pane has one card per agent with **Find** and **Download**. Once an agent is connected its card shows **Connected · v<version>** and its sign-in state, and **Download** becomes **Update**. Selecting the agent in the sidebar opens its page: the executable, version, how it was connected, its sign-in, and **Find again**, **Update** and **Remove**.

### Find

Use Find when the CLI is already installed. It opens a native file dialog; pick the executable. Dark Mechanicus runs it once with `--version` (no shell, 8 seconds) and connects it only if the output identifies that CLI. Anything else is refused and nothing is stored (see [Find refusals](#find-refusals)).

| Agent | Looks for (Windows) | Looks for (macOS) | `--version` must say |
|-------|---------------------|-------------------|----------------------|
| Claude Code | `claude.exe` or `claude.cmd` | `claude` | a line with "Claude Code", for example `2.1.281 (Claude Code)` |
| Codex | `codex.exe` or `codex.cmd` | `codex` | a line starting with `codex` or `codex-cli`, for example `codex-cli 0.46.0` |
| Cursor | `agent.exe`, `agent.cmd`, `cursor-agent.exe` or `cursor-agent.cmd` | `agent` or `cursor-agent` | a build such as `2025.09.18-7ae6800`, or a line naming Cursor |

On macOS the executables have no extension, so the dialog shows all files and shows hidden folders such as `~/.local/bin`. On Windows the dialog lists `.exe` and `.cmd` first. A `.cmd` shim is what npm installs on Windows; see [Windows `.cmd` shims](#windows-cmd-shims).

### Download

Download runs the vendor's own installer. It starts with a native confirmation that shows the source address, the exact command, the folders it installs to, how the download is checked, and the vendor's documentation. **Cancel is the default.** Nothing is downloaded, written or run until you choose **Download and install**, and a dialog in the app's main process is the only thing that can answer it.

Then the installer script is downloaded to a temporary folder, checked where the vendor publishes a checksum, and run. After that the app looks for the CLI where the vendor puts it, runs the same check as Find, and stores it. A failure at any step stores nothing and says why, with the installer's last output lines. The installer is limited to ten minutes. On an agent that is already connected the button is **Update**: the vendor installer runs again and the new version is stored.

| Agent | Installer script | How it is checked | Installs the CLI to |
|-------|------------------|-------------------|---------------------|
| Claude Code | Windows `https://claude.ai/install.ps1`; macOS `https://claude.ai/install.sh` | Anthropic publishes no checksum for the script. Its installer checks each binary against the SHA-256 in its release manifest. It keeps Claude Code up to date in the background | Windows `%USERPROFILE%\.local\bin\claude.exe`; macOS `~/.local/bin/claude` (also `~/.local/share/claude`) |
| Codex | Windows `install.ps1` and macOS `install.sh`, from `https://github.com/openai/codex/releases/latest/download/` | The script is checked against the SHA-256 GitHub publishes for that release asset; the Codex package is checked against the release checksums. If GitHub publishes none, nothing is downloaded (`checksum_unavailable`) | Windows `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; macOS `~/.local/bin/codex`. Codex keeps its files in `.codex` in your home folder |
| Cursor | Windows `https://cursor.com/install?win32=true`; macOS `https://cursor.com/install` | Cursor publishes no checksum for the script and the confirmation says it cannot be verified before it runs | Windows `%LOCALAPPDATA%\cursor-agent` (`agent` and `cursor-agent`); macOS `~/.local/bin/agent` and `~/.local/bin/cursor-agent`, linked into `~/.local/share/cursor-agent` |

On Windows the script runs in the system PowerShell as `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`; the bypass applies to that one process. On macOS it runs as `/bin/bash <script>` (Claude Code, Cursor) or `/bin/sh <script>` (Codex). The Codex and Cursor installers say they add their folder to your `PATH` (Cursor's on macOS "may", in your shell profile); Dark Mechanicus runs the CLI by its full path, so it does not depend on that. Windows and macOS on x64 and arm64 have a recipe; any other system or a 32-bit processor does not (`unsupported_platform`).

### Remove

**Remove** on an agent's page asks first. It only forgets the connection: the CLI stays installed, nothing is uninstalled or deleted, and you can connect it again.

## Sign in

Sign-in is the CLI's own. **Sign in** opens a terminal window that runs `claude auth login`, `codex login` or `agent login`; the vendor's page opens in your browser from there, and anything it asks for (a pasted code, for example) is asked in that window. Dark Mechanicus only learns that the window started. On Windows it is a `cmd.exe` window that stays open after the CLI ends. On macOS it is Terminal, started through `osascript`; macOS may ask whether Dark Mechanicus may control Terminal, which has not been exercised on a Mac here.

After Sign in starts, the prompt asks the app for the agent's status every three seconds and says **Signed in to <agent>** when the CLI does. **Dismiss** stops the waiting. Each agent's state comes from the CLI's own status command (`claude auth status`, `codex login status`, `agent status`, 10 seconds):

| State | Meaning | What to do |
|-------|---------|------------|
| Checking sign-in... | The status command is still running | Wait |
| Signed in | The CLI says it is signed in | Nothing |
| Signed out | The CLI says it is not signed in, or a chat found its login gone | **Sign in** |
| Sign-in unknown | The status could not be told: it did not answer in time, did not start, answered in a way the app does not recognise, or reported an error. The reason is shown | **Check again**; if it keeps failing, see [Sign-in problems](#sign-in-problems) |

### Where the app prompts for it

The app asks each connected agent's CLI for its sign-in state when the agent list loads or an agent is connected or updated, whenever the window regains focus (which is where a sign-in finished in a terminal window shows up), and whenever a chat reports a change. The prompt then appears wherever an agent is needed, so you learn about it before a chat fails:

- **Sidebar, AGENTS:** each connected agent's row shows its state, with **Sign in** when it is signed out and **Check again** when the state is unknown.
- **Add an agent pane:** a connected agent's card shows **Signed out. Sign in to use <agent>.** with **Sign in**, or its unknown reason with **Check again**.
- **Agent page:** the Sign-in row always offers **Sign in**, which is also how you switch accounts.
- **New chat and Start run dialogs:** only connected, signed-in agents can be chosen. Under **Not available**, a signed-out agent has **Sign in** right in the list and joins the choice once it is signed in, without leaving the dialog. An agent that is not connected has an **Add <agent>** button that opens the add-agent pane.
- **A chat:** the **Signed out** card, below.
- **The run bar of a paused run:** below.

## Chats

In a tracked, initialized folder, press **+** on the folder's **Agents** group (**New chat in <folder>**). Choose:

1. **Agent.** Only connected, signed-in agents.
2. **Model.** The models that agent offers (Claude Code from its own model list, with a built-in list when that fails; Codex from `model/list`; Cursor from `agent models`). If the list cannot be read the chat uses the agent's default model.
3. **Role**, and for a planner or orchestrator **Allow save** (see [Roles and Allow save](#roles-and-allow-save)).

The chat opens as soon as it is created. The agent runs in that folder with its own Dark Mechanicus MCP server at the chat's role, named `<Agent> · <chat title>` in the app's session list. Nothing is written to the agent's own configuration. Claude Code chats do read your own Claude Code settings (user, project and local), so your permission rules in them still apply.

- **Send** with Enter; Shift+Enter adds a line. **Stop** interrupts the running turn and keeps the chat.
- Change the **Model** from the chat header; it applies from the next turn and is recorded in the transcript.
- Rename and delete a chat from its row in the sidebar. Delete asks first.
- A chat's agent process starts on its first message (Codex starts when the chat is opened). A process with nothing running and nothing waiting for ten minutes is stopped; your next message starts a new one that resumes the same vendor session. When a session cannot be resumed (it was deleted, or the CLI was reinstalled) the transcript says the context was reset and the chat carries on in a new session.
- Quitting the app stops every agent process.

## Approvals

Reads and searches inside the folder never ask. File edits, commands and anything else become an **approval request** in the chat, showing what the agent wants to do (the exact command and where it runs, or the files and a short preview of the changed lines) with three answers:

| Answer | Effect |
|--------|--------|
| **Allow once** | This request only |
| **Allow for this chat** | This request, and later requests of the same category and the same tool in the same chat, until the app quits. Each automatic answer is recorded in the transcript as automatic |
| **Deny** | The agent is told no |

The categories are file edits, commands and other (for example a read or search that reaches outside the folder, or, in Codex, a call to an MCP tool). A request waits in the app, not in the window: closing the window or opening another chat loses nothing. **Stop**, quitting the app and a failure to store the request cancel it (recorded as cancelled; the agent is told no), and a request a crash left unanswered is recorded as cancelled the next time you open the chat. A chat with a request waiting has a waiting badge in the sidebar.

Each vendor enforces this its own way. Claude Code runs in its default permission mode and asks the app before edits, commands and other tools. Codex runs with approval policy `untrusted` and the `workspace-write` sandbox, so it asks before every file change and before any command it does not know is a safe read; how much of the sandbox applies on Windows is up to Codex. Cursor's permission requests come through the Agent Client Protocol; **Allow for this chat** sends Cursor's own "allow always" option when it offers one.

## Roles and Allow save

A chat's role is one of the four Dark Mechanicus roles and is fixed when the chat starts; to change it, start a new chat.

| Role | For |
|------|-----|
| Planner | Drafts epics, plans and tickets |
| Orchestrator | Runs an epic: claims tickets, starts workers and reviews what they hand back |
| Worker | Does one ticket and reports back |
| Reviewer | Checks finished work against its criteria |

**Allow save** exists only for the planner and the orchestrator. It starts on, and while it is on the chat's MCP server is launched with `--allow-save`, so the agent can call `save_plan`. With it off, or for a worker or reviewer (which never get it, whatever a request says), the agent edits drafts and you press **Save** in the app. The role and the flag are the same ones [`mcp-setup.md`](mcp-setup.md#roles-and---allow-save) describes for an external host; agents can never approve a checkpoint, authorize auto-continue or grant a retry.

## Start a run with an agent, or leave it pending

On a saved epic, **Start run** opens a dialog with two choices.

**Run with an agent** (button **Run with agent**). Pick a connected, signed-in agent and a model: Claude Code, Codex or Cursor, the same on Windows and macOS. Dark Mechanicus then, in this order:

1. Queues a run pinned to the epic's current saved revision (the same command **Leave pending** runs).
2. Creates a chat in that folder as an **orchestrator** titled **Orchestrator · <epic title>**, with **Allow save off**. A run-launched orchestrator never gets Allow save, and the dialog has no way to turn it on: it can plan and redraft, but you save plans and you approve every sprint checkpoint.
3. Sends it the first message, which you can read in the transcript: the epic, its branch, the run id, and the steps to follow (check `get_capabilities`, load the orchestrator prompt, call `start_run`, run the epic itself and start a subagent for each ticket).

The run bar then says **Orchestrated by <agent> in** and links the chat, and a toast says the run is queued. Follow the chat as it works; its approval requests arrive there.

If something fails the run is still queued and the epic's banner says why: no agent is running it and it waits for an orchestrator, as if you had left it pending. An epic that cannot be read, a plan that is not saved, or an epic that already has an active run fail before anything is queued or created, and nothing exists afterwards. If the chat could not be created there is none; if its agent could not start (not connected, signed out, crashed), the chat is removed again so none is left claiming a run nobody is running. To recover, fix the cause (connect the agent, sign in) and either cancel the queued run with **Cancel run** and press **Start run** again, or start an orchestrator chat yourself and ask it to run the epic; it picks up the queued run with `start_run`.

**Leave pending** (**Leave pending**). Queues the run and waits: "Run queued. It starts when an orchestrator picks it up." The run bar says **Waiting for an orchestrator**. An external orchestrator, such as Claude Code connected over MCP as in [`mcp-setup.md`](mcp-setup.md#working-model-your-session-is-the-orchestrator), picks it up with `start_run`. This works with no agent connected.

Without a usable agent the first choice says **No agent is connected and signed in.** and links to the add-agent pane; **Leave pending** still works.

## When a login expires

A CLI's login can expire or be revoked while the app runs. The chat that finds out ends its turn cleanly and the following happens:

- **The chat shows a Signed out card** (a "Sign-in" card titled **Signed out of <agent>**, pill **Needs sign-in**) with the CLI's own words and **Sign in**. The message you sent that was cut short is kept; nothing resends it on its own. The message box is closed with "Signed out of <agent>. Sign in above to keep chatting." Every other chat of that agent is told too, and a new message in any of them is stored, answered with the same card and starts nothing until you sign in.
- **Sign in** works as above. The card shows **Checking** while it asks, then the pill becomes **Signed in** and the card says "Signed in again. The message that was cut short has not been sent yet." with **Retry**.
- **Retry** sends that message once, the card shows **Retried** and "Turn retried. <agent> is answering your message again." Retry is refused while the agent is still signed out, or when there is nothing to retry. Older cards in a chat are marked **Earlier**.
- **The sidebar flags the chat** with the waiting badge, for sign-in as well as for approval.
- **The agent's status says Signed out everywhere.** The CLI's own status command only reads what is stored locally and may still say "signed in" for a login that no longer works, so the app keeps what the chats found until you start Sign in and the CLI then says signed in. This is held in memory and ends when the app quits.

### A run paused for sign-in

If the chat is the orchestrator of a run that is **running**, the app also pauses the run, with the reason `signed_out`. Only the desktop app can give that reason; an agent calling `pause_run` with it over MCP is refused. A run that is queued, already paused or waiting at a checkpoint is left as it is.

- **The run bar says "Paused: <agent> signed out"**, links the orchestrator chat, and offers **Sign in** (or **Check again** for an unknown state) right there. **Resume run** stays off, with the tip "Sign in to <agent> first", until the agent's status says signed in. The app never resumes the run itself: you press **Resume run**.
- **The run keeps its open leases while paused.** A run paused for `signed_out` does not expire the leases of its open tickets, whatever their lease time, and workers' heartbeats still work, so a worker loses nothing while you sign in. On **Resume run**, each open lease is extended by the time the run spent paused, and the run records a `run.leases_extended` event with each attempt's old and new lease end. Runs paused for any other reason, and a run taken over from another machine, expire leases as usual.

## Troubleshooting

### Find refusals

| Code | You see | Likely cause and fix |
|------|---------|----------------------|
| `not_a_file` | "That is not a file." | The path is a folder, is missing, or is not absolute. Pick the executable itself |
| `not_executable` | "That file is not executable." or "...not a program Windows can run (.exe or .cmd)." | On macOS, the file lacks the execute permission. On Windows, pick the `.exe` or `.cmd`, not a script or other file |
| `unsafe_path` | "The path has a character (a quote, "%", or a control character) that cannot be launched safely." | A Windows `.cmd` path containing `"`, `%` or a control character is refused, never escaped. Move the shim somewhere else, or connect the `.exe` |
| `did_not_start` | "It did not start (<OS code>)." | The file exists but the system could not start it (a missing runtime behind a shim, for example). Run it in a terminal to see why |
| `timed_out` | "It timed out." | `--version` took longer than 8 seconds, as a cold start behind antivirus scanning can. Try again |
| `failed` | "It exited with an error (code N) when asked for its version." | The program is broken or is not that CLI's command. Run `<path> --version` in a terminal |
| `wrong_program` | "This is not the <agent> CLI." | The output did not name that CLI. Pick the right agent's executable |

### Windows `.cmd` shims

npm installs agents on Windows as `.cmd` shims, and Node cannot start those without a shell. So a shim is run through exactly one `cmd.exe /d /v:off /s /c` parse with its path inside one pair of quotes: `&`, `^`, `(` and spaces in the path are literal, `!` expansion is off and AutoRun is skipped. Every argument after the path is a constant, and stopping a chat stops what the shim started. The cost is that a path with `"`, `%` or a control character cannot be run safely, and is refused rather than escaped. This applies to Find, to the sign-in window and to Codex and Cursor chats.

Claude Code chats work differently. Its SDK needs a real program, not a shim, so Dark Mechanicus follows an npm shim to the script or program it runs (the quoted path under `%dp0%`, next to the shim). Find may accept a Claude `.cmd` and the chat still fail with "Dark Mechanicus cannot launch Claude Code through that .cmd shim. Connect claude.exe instead (the native installer puts it in %USERPROFILE%\.local\bin)." when the shim cannot be read or followed. Connect `claude.exe` as the message says (Download installs it there).

### Download failures

Nothing is stored on any failure. The codes: `busy` (a download of that agent is already running), `unsupported_platform` (no recipe for this system or processor), `download_failed` (the installer could not be fetched, or is not at an official address), `checksum_mismatch` (the script does not match the published checksum, so it was not run), `checksum_unavailable` (Codex only: GitHub published no checksum for the script, so nothing was downloaded), `installer_failed` (the installer exited with an error or ran over ten minutes; its last output lines are shown), `executable_not_found` (the installer finished but the CLI is not where the vendor puts it; use **Find**), `verify_failed` (what was installed did not pass the Find check) and `unexpected`. Declining the confirmation is not a failure; nothing is fetched or run.

### Sign-in problems

- **Could not start sign-in.** The agent is not connected, the file is not a program the system can run, the path is unsafe for `cmd.exe` (see above), or no terminal window could be opened.
- **The window opens but the state never changes.** Finish the login in the browser and in that window, and then **Check again**. **Dismiss** the prompt to stop the three-second checks.
- **Sign-in unknown.** The reason line says what happened. **Check again** asks once more. "Did not answer in time" means the status command took over ten seconds.
- **A chat says signed out but the agent page says signed in.** See above: the app trusts what the chat found over the CLI's local status. Press **Sign in** and finish the login.
- **A chat starts but the Dark Mechanicus tools are missing in Cursor.** The adapter hands the server to Cursor in the ACP session; a Cursor that still gates such servers behind its own approval would leave the tools out, and the adapter cannot see that.

## What was and was not verified

Verified on a Windows machine: Claude Code's `--version` and `auth status` output formats and its signed-out transcript were taken from a real Claude Code install, and the Windows `cmd.exe` launch rules are covered by tests that run against Node itself.

Not verified, and not claimed:

- **macOS.** Nothing here was run on a Mac: the macOS install recipes and folders, the Terminal sign-in through `osascript` (and whether macOS asks for permission), the `~/.local/bin` locations, and the Find dialog on macOS.
- **Codex and Cursor** were not installed on that machine. Their sign-in detection comes from the vendors' source, documentation and forum posts, not from a real signed-out session. Cursor's `agent status` wording is not documented (the app matches "not logged in" and "logged in" style messages and otherwise says Sign-in unknown), neither is the output of `agent models`, and whether an older Cursor gates the Dark Mechanicus server is unchecked.
- **Download against the live vendor endpoints.** The installer flow is tested with fake downloads and fake processes. This runbook does not record a real install on either platform.
- **Where `userData` is** on an installed build, as noted above.
