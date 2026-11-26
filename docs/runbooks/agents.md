# Agents: connect, sign in, chat, run

The desktop app can host four built-in agent CLIs, **Claude Code**, **Codex**, **Cursor** and **Autonomous** (`a8s`), and any number of [custom CLIs](#custom-clis). You connect each one (Find it, Download it, or add it as a custom CLI), sign in with its own login, chat with it in a tracked folder, where it runs as its own CLI in a terminal in the app's window, and start a run with it as the orchestrator. Windows and macOS are supported; there is no Linux install recipe.

This is separate from [connecting an external agent host over MCP](mcp-setup.md), which still works with the desktop closed. How the hosted agents are built is in [`architecture.md`](../architecture.md#hosted-agents).

Dark Mechanicus runs the vendor's own CLI under your own sign-in. It never asks for, shows or stores a password, key or token, and it calls no model API itself.

## Where things are kept

All live in the app's `userData` folder, outside every repository. None is a portable record: they do not travel with a pull. Untracking a folder clears only its [default agent](#default-agent-of-a-folder).

| What | Where |
|------|-------|
| Connected agents | `userData/app.sqlite`, table `agents`: one row per agent (id, kind, name, executable path, arguments, version, found, downloaded or custom, timestamps, needs review). Remove deletes only the row (and any folder default naming it) |
| Default agent of each folder | `userData/app.sqlite`, table `folder_agent_defaults`: the folder's canonical path and an agent id |
| App bookkeeping | `userData/app.sqlite`, table `app_meta` (for example whether the old agents file was imported) |
| Chats | `userData/agents/chats/<folder key>/index.jsonl` (one line per change of a chat; the last line for an id wins) and `userData/agents/chats/<folder key>/<chatId>.jsonl` (the transcript a chat stored before chats became terminals, one item per line; nothing writes one any more) |
| Activity bindings | `userData/agents/activity-bindings.jsonl`: which threads of chats acted on which runs and attempts, one line per binding (ids only, never a claim token). A GUI orchestrator chat adds `{ thread → attempt }` when a worker subagent's claim token is verified (see [Subagents in a chat](#subagents-in-a-chat)); older lines come from chats before terminals. Delete chat removes the chat's lines. A terminal chat is found by the `dm` grant it was issued instead |
| Credentials | Not kept by Dark Mechanicus. The CLI keeps its own login |

The folder key is the first 24 hex characters of the SHA-256 of the folder's canonical path, so every spelling of a folder finds the same chats. Claim tokens (`at_...`) are masked in what the app stores, including two tokens run together and a token cut short at the end of a text; what an agent shows in its own terminal is the CLI's and is not masked. Delete chat removes the transcript and every stored version of the chat's record; nothing is moved to a trash.

`userData` is `%APPDATA%\<app name>` on Windows and `~/Library/Application Support/<app name>` on macOS. A development run on this Windows machine uses `%APPDATA%\dark-mechanicus`; an installed build is expected to use `DarkMechanicus` (the product name), which has not been checked on an installed build.

**The app database and the old agents file.** Builds before the app database kept connected agents in a JSON file, `userData/agents.json`. On its first start a newer build imports that file into `app.sqlite` once (`agentRegistryImport.ts`): every valid entry becomes a row, `app_meta` records `legacyAgentsImported`, and the file is deleted. A file that cannot be read is left in place, recorded and not imported; a failed import is retried at the next start. There is no downgrade: an older build reads only `agents.json`, which is gone, so it shows no connected agents, and an `app.sqlite` written by a newer build than the running one is refused (`incompatible_schema`). Connect the agents again in the older build if you have to go back.

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

**Remove** on an agent's page asks first. It only forgets the connection: the CLI stays installed, nothing is uninstalled or deleted, and you can connect it again. Its chats that are running are ended, and every folder whose default it was has no default any more.

### Autonomous

Autonomous (`a8s`) is connected with **Find** only: it has its own managed installer, so there is no Download or Update. Pick the `a8s` executable; its `--version` must start with `Autonomous <version>` (for example `Autonomous 0.79.0 · darwin-arm64 · …`).

- **How it runs.** A chat's terminal starts `a8s start <chat folder> --append-system-prompt <instructions> --approval-mode always-ask`, plus `--model <id>` when the chat has a model, in the chat's folder, and `a8s resume` once the chat was typed into. It never runs with `--approval-mode write` or `yolo`: a8s asks before writes and commands in its own terminal.
- **Sign-in.** The state comes from `a8s doctor`'s `Model route` line: a passed check that says signed in is Signed in, and one that says "is not ready" or "not signed in" is Signed out; anything else reads as Sign-in unknown. **Sign in** opens a terminal running `a8s init`. A signed-out a8s does not start: the chat's pane shows the sign-in card instead of its terminal, and the terminal starts once a8s is signed in.
- **Models.** a8s has no command that lists them, so **Start run** takes a typed model id (`provider/model`, or empty for a8s's own default), checked before the run starts. A running chat switches models in a8s itself.

What this rests on is the recording of a8s 0.79.0 in [`autonomous-acp.md`](../reports/autonomous-acp.md).

### Custom CLIs

**Add a custom CLI** connects any program that runs in a terminal. You give it a name (1-64 characters once trimmed, unique among custom CLIs whatever its case), and up to 32 arguments of 1-1024 characters each; then the app's native file dialog asks for the program. The renderer never supplies a path. A chat's terminal starts **the program, then your arguments**, exactly as confirmed, so add whatever the CLI needs to run interactively.

- **`{folder}` and `{instructions}`.** An argument that is exactly `{folder}` is replaced by the chat's folder (its canonical path) at every start, and one that is exactly `{instructions}` by the path of the chat's instructions file. Either inside a longer argument (`--cwd={folder}`) is refused. Names, arguments and the program's path may not hold control or formatting characters or spaces other than the plain one.
- **Confirmation.** Before anything is stored, a native dialog shows the program, and every argument on its own numbered line as a JSON string, and says the command runs in a chat's terminal whenever a chat uses it. **Cancel** is the default; only **Run and save** with **I have checked this command** ticked goes on. Nothing is run to check it: the CLI first runs when a chat starts it, and its page says **Version unknown**.
- **Editing.** The agent's page can change the name and arguments and pick the program again; every edit goes through the confirmation again.
- **Sign-in happens outside the app.** A custom CLI's sign-in state is always **unchecked**: sign in with its own login in a terminal before chatting.
- **Models.** A custom CLI starts on whatever model it picks itself; change it inside the CLI.
- **Custom CLIs added before terminal chats.** A custom CLI then had a protocol. On upgrade the protocol is dropped; one added as **Claude Code SDK** is the program itself and starts as it is, but one added as **ACP** or **Codex app-server** had arguments that start a protocol server, not an interactive program. Its page says **Review its arguments** and offers **Review arguments**, and a chat on it does not start (its terminal says to review it) until you have removed those arguments (`app-server`, `--mode acp` and the like) and confirmed the rest in the native confirmation.
- **Windows.** A `.cmd` or `.bat` program runs through the System32 `cmd.exe` by full path ([Windows `.cmd` shims](#windows-cmd-shims)).

**Security.** The app runs exactly the program and arguments you confirmed, under your account, in the chat's folder, with the chat's `dm` grant (`DM_SESSION_TOKEN`, at the chat's role) in its environment. It cannot tell what the program does with them. Add only programs you trust as much as the built-in agents.

### Default agent of a folder

A tracked folder's page has a **Default agent** select. The choice is stored per canonical folder path (`folder_agent_defaults`), **New chat** in that folder uses it, and **Start run** (Run with an agent) starts with it selected, where you can still pick another. Only a connected agent can be the default. It is cleared when the folder is untracked or the agent is removed.

## Sign in

Sign-in is the CLI's own, and it runs in the app's window. **Sign in** opens the agent's sign-in view in the main area, with **Back**: a terminal running `claude auth login`, `codex login`, `agent login` or `a8s init` on the connected executable, in your home folder, with no grant. The vendor's page opens in your browser from there, and anything it asks for (a pasted code, for example) is typed into that terminal. **Back** returns to the screen you were on and stops the sign-in; so does going to another screen. A chat whose agent is signed out shows a sign-in card instead of starting, and its **Sign in** runs the same login inside the chat's pane; the chat starts once the status says signed in.

When the login ends, the app asks the agent's status once and says **Signed in to <agent>**, or what the status says instead with **Sign in again**. Each agent's state comes from the CLI's own status command (`claude auth status`, `codex login status`, `agent status`, 10 seconds):

| State | Meaning | What to do |
|-------|---------|------------|
| Checking sign-in... | The status command is still running | Wait |
| Signed in | The CLI says it is signed in | Nothing |
| Signed out | The CLI says it is not signed in | **Sign in** |
| Sign-in unknown | The status could not be told: it did not answer in time, did not start, answered in a way the app does not recognise, or reported an error. The reason is shown | **Check again**; if it keeps failing, see [Sign-in problems](#sign-in-problems) |

### Where the app prompts for it

The app asks each connected agent's CLI for its sign-in state when the agent list loads or an agent is connected or updated, and whenever the window regains focus (which is where a sign-in finished in a terminal shows up). The prompt then appears wherever an agent is needed, so you learn about it before a chat fails:

- **Sidebar, AGENTS:** each connected agent's row shows its state, with **Sign in** when it is signed out and **Check again** when the state is unknown.
- **Add an agent pane:** a connected agent's card shows **Signed out. Sign in to use <agent>.** with **Sign in**, or its unknown reason with **Check again**.
- **Agent page:** the Sign-in row always offers **Sign in**, which is also how you switch accounts.
- **Start run dialog:** only connected, signed-in agents can be chosen. Under **Not available**, a signed-out agent has **Sign in** right in the list and joins the choice once it is signed in, without leaving the dialog. An agent that is not connected has an **Add <agent>** button that opens the add-agent pane.
- **A chat:** a sign-in card in its pane in place of its terminal (above).
- **The run bar of a paused run:** below.

## Chats

In a tracked, initialized folder, press **+** on the folder's **Agents** group (**New chat in <folder>**). A focused popup asks for the **First prompt** before anything is created. **Start** requires nonblank text (at most 32,000 characters); **Cancel** or Escape creates no chat or terminal. The chat uses the folder's [default agent](#default-agent-of-a-folder) while it is connected (else the first agent that can chat), as an **orchestrator** with **Allow save** on, on the CLI's own default model. With no agent connected the add-agent pane opens instead. A creation failure keeps your original text in the popup so you can correct it and retry; repeated submission does not create duplicates.

A chat runs the agent's own CLI in the main area, in this window, on one of two surfaces. **GUI** is the default for Claude Code and Skitarii: the app drives the CLI's own structured mode (Claude Code `-p` with stream-json, Skitarii `--mode rpc-ui`) and shows the conversation with a composer, approval and question cards, a To-dos card and an activity line (see [GUI chats](#gui-chats)). Every other agent (Codex, Cursor, Autonomous, a custom CLI) and every Forge setup chat runs in a **terminal**: opening the chat focuses the terminal, and every key goes to the CLI: its prompts, its approvals, its `/model` and its subagents are the CLI's own, exactly as in a terminal of your own. The header shows the terminal's state where the model used to be. On either surface the agent runs in that folder and reaches Dark Mechanicus by running the `dm` CLI with a grant at the chat's role that the app has already issued (`DM_SESSION_TOKEN` in its environment); the exact command is in the chat's instructions (`--append-system-prompt-file` for Claude Code, `--append-system-prompt` for Skitarii and Autonomous, the first prompt for the others). Nothing is written to the agent's own configuration. Claude Code chats do read your own Claude Code settings (user, project and local), so your permission rules in them still apply.

**First message and short title.** The complete original popup text, including whitespace and line breaks, is saved with the chat and submitted once through the existing ready bracketed-paste path, never as command-line options or a blind timed Enter into sign-in or onboarding. Later messages, approvals, passwords and CLI commands belong in the terminal; there is no persistent app-owned prompt composer.

The selected agent uses its own model to infer a concise intent label, normally 2–5 words and never more than five, and reports it using the narrow authenticated `name_chat` metadata operation. That operation binds to the current chat terminal generation and its real current grant; callers do not choose a chat or folder. It adds no provider, account or downloaded-model dependency. Prompt prefixes and canned titles are not successful inference. A pending or failed name is reported honestly, not silently replaced with a prefix.

For Skitarii, native `dm_call` forwards the current desktop naming address only for `name_chat` (or `nameChat`); other command children do not inherit desktop addresses or provider credentials. The address is routing, not permission: a foreign, revoked or stale chat grant cannot publish a title. The launch descriptor never stores the grant or naming address.

The generated title is saved and appears in the sidebar and header after the agent reports it. Reopening or restarting preserves it; later turns do not rename the chat. A creation-supplied title, manual rename (including a race with naming), and run, transfer and Kanban names always win. Existing chats are not retroactively named, and the app does not infer questions from raw PTY bytes.

**Recovery.** The chat exposes the complete original first prompt in a read-only disclosure, with pending, submitted-once or uncertain delivery status. Submitted means handed to the terminal, not acknowledged by the model. An interrupted ambiguous write is not automatically resent; inspect the terminal before deciding whether to paste the saved text yourself. Naming failure is shown without discarding the prompt. **Earlier conversation** stays read-only, with no prompt or approval controls to answer.

**The chat's folder is pinned.** Every start of a chat's terminal checks the folder first: it must still exist, be a directory, be its own real path (not a symlink swapped in that leads elsewhere) and be tracked. That checked canonical path is where the CLI runs, the `{folder}` of a custom CLI's arguments and the `--repo` of its `dm` command. A folder that was moved, deleted, untracked or replaced by a symlink refuses the start with a message naming the folder and why; nothing is started and no grant is issued. A running CLI whose folder moves is stopped. Grants are revoked through the workspace they were issued in, so a renamed folder's grant still ends.

The app does not list a chat's role and label anywhere (see [`agents-e2e.md`](../reports/agents-e2e.md), defect 2). They show in these places:

- **The footer, and the MCP card on the folder page,** say only how many: **N agent sessions · stdio**.
- **MCP `list_sessions`** gives each session's role, label and activity.
- **The run bar** names the run's host (**host <label>**). Run events name the session that acted, and each attempt names its worker (label, model and host).

- **Exit, Start again, New session.** When the CLI exits, or the app stops it (after 10 minutes with no input and no output, or when its folder moves), its last screen stays with the reason. **Start again** starts the CLI again on the chat's session (Claude Code's `--resume`, `a8s resume`); after a resumed session the CLI may have refused, in its own words on that screen, **New session** starts a fresh one.
- **Earlier conversation.** A chat that stored a transcript before chats became terminals shows **Earlier conversation** above its terminal. It opens that transcript read-only: what was said, the tool calls, the subagent threads, and each approval request with the decision stored for it (one nothing answered shows as **Cancelled**). Nothing can be sent or answered there, and opening it starts and stores nothing.
- The chat list is the same in every window: a chat created, renamed or deleted in one window shows up in the others. While a stored chat waits for its folder's chat list the main area says **Loading chat…**; the tracked folders and an agent's page say **Loading folders…** and **Loading agents…**.
- **Claude Code's memory folder asks like any other file.** A chat's Claude Code is started with a settings file of the app's (`--settings`, in `userData/agents/settings/`) that moves the CLI's own memory folder to one nobody reads and adds a `PreToolUse` hook that asks before a Write, Edit, MultiEdit or NotebookEdit into a memory folder (`~/.claude/projects/*/memory/`, or under `CLAUDE_CONFIG_DIR`), however the path is spelled; Claude Code then shows its own permission prompt. None of your Claude Code settings files is changed. How it works: [`architecture.md`](../architecture.md#chats-records-store-terminals).
- Rename and delete a chat from its row in the sidebar. Delete asks first; it ends the chat's terminal, revokes its grant and removes the chat with its stored transcript.
- Quitting the app stops every terminal and what each one started, and waits for them to be gone before it exits (at most 5 seconds, so a stuck one cannot keep the app open). Any stop of a process (on quit, a deleted chat, or a Find check or install that times out) ends its whole process tree, not just the process the app started.

### GUI chats

A GUI chat shows the conversation as messages, tool calls and subagent threads, with a composer at the bottom: **Enter** sends, **Shift+Enter** adds a line, and a message sent while the agent works is queued for its next turn. **Stop** (or Escape) interrupts the running turn. Approval and question cards dock above the composer (see [Approvals](#approvals)); the To-dos card and the activity line are described under [The epic's Agent tab](#the-epics-agent-tab) and work the same in any GUI chat.

**Claude Code's folder-trust question is skipped.** A Claude Code GUI chat runs `claude -p`, which does not show Claude Code's workspace trust dialog. Tracking a folder in Dark Mechanicus is the trust decision: track only folders whose Claude Code project settings, hooks and `CLAUDE.md` you trust. Claude Code's memory-folder guard is passed to GUI chats in the same settings file, but whether its hook fires under `-p` has not been verified (see [`chat-shells.md`](../design/chat-shells.md#superseded-in-part-2026-11-20)).

#### Switching between GUI and terminal

A GUI chat's header has **Terminal**; a Claude Code or Skitarii chat in a terminal has **GUI**. Both continue the same CLI session on the other surface; nothing is copied or replayed.

- **GUI → Terminal** is available only while the agent is idle with no card waiting and no message queued. Otherwise the button is disabled, and a request that races a new turn is refused as busy, with the reason shown inline; the chat stays where it is.
- **Terminal → GUI** while the terminal's CLI is running always asks first, in a native dialog: **Stop the running terminal of "<chat>" and continue in the GUI?** It warns that any work the agent is doing in the terminal right now may be interrupted, and that the same session is kept. **Cancel** is the default (Enter and Escape choose it) and changes nothing: the terminal keeps running. Only **Stop terminal and switch** stops the terminal's process tree; the GUI then resumes the same session where the terminal left it.
- The app cannot tell whether a terminal's CLI is in the middle of work, so it never decides that for you: there is no automatic switch and no way around the dialog while the terminal runs. Stop the agent's work in the terminal yourself first if it must not be interrupted.
- If the terminal is still starting or stopping, or the dialog is already open for that chat, the switch is refused as busy. If the terminal was replaced while the dialog was open, nothing is stopped.
- Codex, Cursor, Autonomous and custom CLIs have no GUI surface. Forge setup and tooling repair chats have none either, even with Claude Code or Skitarii: their header (and the epic Agent tab's **Switch to GUI**) still offers the switch, but the app refuses it as unsupported and the chat stays in its terminal.

#### After an update restart

When you press **Restart now** to install an update, the app records which runs' Magos chats are live. On the next start, if the app's version went up and the restart came within 15 minutes, each of those chats gets one message on its same session: `[App restarted after an update from v<from> to v<to>: resume your run from get_run]`. A Magos still on a terminal is switched to the GUI first. A plain quit, an equal version or a later start sends nothing.

### Every chat under its agent, and agents with no project

Each agent's row in the sidebar **AGENTS** section has a chevron (**Chats of <agent>**) that lists all of that agent's chats that are not deleted, newest first: every tracked folder's chats, labelled with the folder's name, and its project-less chats, labelled **No project**. The list follows creates, renames and deletes in every window, and drops a folder's chats when the folder is untracked. Rows open, rename and delete exactly like the folder's own chat rows, with the same running dot and **Needs sign-in** badge; a folder chat opens in its folder, a project-less one on its own. The folders' own **Agents** groups are unchanged.

The row's **+** (**Summon <agent> without a project**) asks for the first prompt in the same popup and starts a **project-less chat** with that agent: an **orchestrator** with **Allow save**, tied to no folder.

- **Where it runs.** In a scratch folder of its own, `userData/agents/scratch/<chat id>`, made when its terminal starts. No folder check applies to it. Its record lives in `userData/agents/chats/projectless/`, so it survives restarts and resumes like any chat. Deleting it ends its terminal, revokes its grants and removes its record, transcript and scratch folder; removing its agent ends its terminal and revokes its grants.
- **What it can reach: every tracked folder, read and write.** When its terminal starts it is issued one ordinary **orchestrator** grant with **Allow save** in each tracked, set-up folder, through that folder's own workspace, so the command layer checks it like any other grant and a token works only in its own folder. Each token is written to its own private file in the scratch folder (`.dm/grants/`), and the instructions give one exact line per folder: `dm --repo <folder> --token-file <file> call …`. **This is wide open on purpose:** a project-less agent can change the records of every tracked folder, which the person accepted; server-side checks stay authoritative, and the grants are revoked when its terminal ends.
- **Folders tracked later** are reached from the chat's next start (**Start again**). With no folder tracked and set up, it starts with no grant at all and its instructions say so; it cannot name itself from its first prompt then, so its title ends as **Chat naming failed** until you rename it.
- Project-less chats have no **Earlier conversation**: they began after chats ran in terminals.

### Built-in collaboration policy

Every hosted chat receives the concise shared policy from [`skills/collaboration.md`](../../skills/collaboration.md), including an ordinary Skitarii chat with no epic, run, transfer or card. Main writes it after the CLI/grant instructions and before any task-specific guidance in `userData/agents/instructions/<chatId>.md`. This is the same shipped source exposed as the `darkmechanicus-collaboration` MCP prompt; it is not a second provider-specific configuration.

- **Planning:** detailed, iterative discovery with meaningful questions about unresolved choices, alternatives, recommendations and tradeoffs; a thorough plan records assumptions, scope/non-goals, risks, dependencies, acceptance and verification. No question quotas, repeated questions or epic questionnaire for small, clear, authorized isolated work.
- **Execution:** the orchestrator makes in-scope decisions from the approved plan and evidence, resolves worker questions itself, and asks the person only for genuine scope, authority or safety blockers and required human approvals.
- **Delegation:** summoned workers and reviewers ask only the orchestrator, with facts, options and a recommendation; the orchestrator owns any human escalation and passes the policy to its subagents.
- **Authority:** planning is a phase, not a role change. The actual grant and Allow save still control commands. Saved-plan/adoption boundaries, checkpoint approvals, retry grants and human-only card controls are unchanged.

Skitarii's existing `--append-system-prompt <instructions file>` loads that file on initial launch **and resume**; no run/card binding or extra privilege is required. Every terminal start rewrites the instructions from the running app's bundled policy, replacing stale generated text. Editing that generated file is not persistent. Other built-in CLIs keep their existing instruction transport; a custom CLI receives the file only when its confirmed arguments use `{instructions}`.

Repository startup guidance in [`AGENTS.md`](../../AGENTS.md) points coding sessions to the common policy and detailed [`planner`](../../skills/planner.md), [`orchestrator`](../../skills/orchestrator.md), [`worker`](../../skills/worker.md) and [`reviewer`](../../skills/reviewer.md) guides. These are instructions, not an enforcement mechanism or a guarantee of model obedience.

The orchestrator guide is a short kernel; the rest of the orchestrator's guidance arrives as knowledge facts, pushed as `context` by the commands that change run state and pulled with `get_context`. Layers, authoring and the measured context sizes are in [`knowledge.md`](knowledge.md).

**Updating and reloading:** changing repository Markdown does not patch an already installed or running app. Rebuild and relaunch the development app, or install an updated packaged build, then stop/start the chat terminal (**Start again**, or **New session** if a resume is refused) to regenerate and reload its instructions. A currently running CLI is not hot-updated; resuming can retain older conversational context even though the current policy is appended again. This loading contract does not establish that any model will follow the prose, and does not claim a live installed-app or paid-model test.

### Panels that follow a chat

A ticket's **Activity** tab and a run's **Orchestrator feed** show the command layer's timeline, with **Open terminal** to the chat whose `dm` grant claimed the attempt (or started the run). For an attempt or run of a chat from before terminals they also show that chat's bound thread (the bindings in [Where things are kept](#where-things-are-kept)), read once with `chats:read`, which starts no agent and writes nothing: its approval requests are records with the decision stored for each, and nothing is answered there. A thread can have served more than one attempt of a ticket (a retry in the same chat): an attempt's tab shows only the rows from that attempt's claim to its end, or to now while it is open.

## Approvals

**In a terminal chat** approvals are the CLI's own, asked and answered in its terminal; the app holds none. Claude Code runs in its default permission mode, with your Claude Code settings, and asks before edits, commands and other tools (a write into its memory folder asks too, see [Chats](#chats)). Autonomous runs with `--approval-mode always-ask`. Skitarii (OMP) chats get no `--approval-mode` from the app, so your own OMP `tools.approvalMode` applies. OMP's default is `yolo`, which runs every tool without asking. Set `always-ask` in your OMP config to be asked before every write and shell command. Why the app passes none, and what each mode allows: [`omp-cli.md`](../reports/omp-cli.md#11-approval-modes-dm-902). Codex and Cursor apply their own approval policies. The app's own boundary stays the chat's `dm` grant: its role, and Allow save.

**In a GUI chat** the CLI's permission requests and questions come to the app (Claude Code through `--permission-prompt-tool stdio`) and appear as a card above the composer, held by the app until answered. An approval card offers **Allow once**, **Allow for this chat** when the CLI offers a chat-wide allow, and **Deny**; its heading names who asks, as **<callsign> wants to run: …** for a subagent with a callsign (for example **Acolyte:DM-442**), **The Magos wants to run: …** or **Lexmechanic wants to run: …** for an orchestrator or planner chat's own request, and **The agent wants to run: …** when the request can't be attributed. A question card is headed by the question itself and names no asker; it offers the question's options, and a Claude Code question always adds a free-text answer (**Other**, or **Answer** when it has no options). The card never takes focus from what you are typing. An answer to a prompt that has since been replaced is refused and the card says **This prompt is no longer available.**

**The Magos arbiter.** While a worker subagent waits on a tool approval, its orchestrator's turn is blocked, so the app can let a separate, tool-less **Magos arbiter** decide routine approvals for you.

- **Who is arbitrated:** only approvals in a Start-run orchestrator GUI chat (a chat with a run; Claude Code only, Skitarii approvals always come to you), and only while **Let the Magos arbitrate** is on in Settings → Notifications & approvals.
- **Never arbitrated, always yours:** every question; any request whose path may reach outside the chat's folder and its registered worktrees; agent, Git or CI configuration files; any tool or command on your **always-ask** list; a request whose input is too large to show; a project-less chat; and everything while arbitration is turned off.
- **How it decides:** from the ticket, the epic Standards and your **auto-handle notes**, with no tools, in an empty temporary folder with no grant. It may allow once, deny or escalate to you. It has 60 seconds; output it cannot parse, a timeout or an error escalates to you.
- **What you see:** while it decides, the card says **The Magos is deciding…** and your own buttons stay enabled, so you can answer first. A decision it makes is recorded with `decidedBy: magos` and shown in the transcript as **The Magos decided: <reason>**. An escalated card says **The Magos asks you:** and why.
- **Needs-you badges:** a chat or subagent with a prompt waiting on you carries a **Needs you** mark in the epic's agent tree; a collapsed branch shows that something below it is waiting.

## Notifications

The app raises an OS notification when an approval or a question needs you (one the Magos escalated or does not decide), when a sprint checkpoint is ready, when a run fails, and when a run's Magos chat has been working for 5 minutes with no output and no prompt waiting. Each event is shown at most once every 10 minutes.

- **Focus:** by default nothing is shown while the app is the focused window; choose to be notified anyway in Settings.
- **Click to land:** clicking a notification restores and focuses the app's window. A chat bound to an epic opens on that epic's **Agent** tab with the chat that holds the card selected (the owning chat, never a subagent's thread, since a worker's card lives in its owning chat). Any other folder chat opens in its folder, at the subagent's thread when the notification names one; a project-less chat opens on its own. A checkpoint notification opens the epic's checkpoint, and a run failure opens the epic.
- **Settings → Notifications & approvals:** turn each event on or off, sound, whether to notify while the app is focused, the Magos arbiter switch, the always-ask list and the auto-handle notes. The settings live in the app, not in a project. A change that loosens a safeguard (turning the Magos arbiter on, removing an always-ask entry, changing the auto-handle notes) needs your confirmation in a native dialog, with **Cancel** the default; tightening saves without asking.

## Subagents in a chat

**In a terminal chat** a subagent's work shows wherever the CLI shows it, in its terminal. A chat's [Earlier conversation](#chats) shows the subagent threads it stored before chats became terminals, each under the tool call that started it with its state, read-only. A Skitarii chat's subagents share its grant and its mailbox: they cannot be messaged on their own (see [Skitarii mail](#skitarii-mail)).

**In a GUI chat** each subagent is a thread nested under the tool call that started it (Claude Code is started with `--forward-subagent-text`, so a subagent's text is told apart from its parent's).

- **Callsigns.** Agents are named by role: the **Magos** is a run's orchestrator chat, the **Lexmechanic** a planner chat, an **Acolyte** a worker, an **Inquisitor** a reviewer or red-team subagent and a **Servitor** any other helper. The orchestrator labels each subagent `<Role>:<ticket key> <short purpose>` (for example `Acolyte:DM-442 implement the parser`, or `Servitor-3 …` with no ticket). Labels are display hints only: **Magos** and **Lexmechanic** come only from the app's own chat records, never from a label.
- **Claim-token binding.** When the orchestrator hands a worker its claim token in the spawn prompt, the app reads that prompt in main before anything is masked, asks the project whether the token is that run's live claim, and stores only `{ thread → attempt }` in `activity-bindings.jsonl` (see [Where things are kept](#where-things-are-kept)); the token itself is never stored or shown. The bound attempt's ticket key then names the thread, and wins over whatever label the model gave it.
- **The Agents rail of a GUI chat.** The chat header's **Agents** toggle opens a rail with this chat's subagent tree; the app remembers per chat whether it is open.

### The epic's Agent tab

An epic's workspace has a bold **Agent** tab. Its centre shows the selected agent's chat; its right rail (**Agents**) shows:

- **The named agent tree:** every chat bound to the epic as a root (the active run's Magos first, then the newest), and each root's subagents nested under it by callsign, with their state, elapsed time, needs-you marks and, when the agent has a to-do list, a short **closed/total** to-dos label. Selecting a subagent shows its thread read-only.
- **Changes:** the files the selected agent wrote or edited through its file tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, Skitarii `edit`/`write`). Edits made through a shell command are not listed. Clicking a file in the folder opens **Source control** at that file.

The **To-dos** card is not in the rail: it sits in the centre GUI chat, between any waiting card and the composer, and shows that chat's own list. Its sources are Claude Code's `TodoWrite` or `TaskCreate`/`TaskUpdate` and Skitarii's `todo` phases. Open tasks always show. A list that has just finished lingers while the same turn is still running and disappears when the turn ends. Successful to-do tool calls are hidden from the transcript; failed ones stay. Claude Code to-dos are held in memory only: after an app restart the list is empty until the agent next updates it.

Under the conversation an **activity line** says what the agent is doing (**Working** with the elapsed time and running tool, or **Waiting for an answer**). After 30 seconds with no output it turns into **No activity** with **Stop**; it never does so while a tool runs or a prompt waits.

**Talking to a worker (the worker relay).** With a subagent's thread selected, its composer sends your message to the chat that owns the thread, prefixed with the marker `[Message from the person for your worker subagent, thread <id>]` and followed by `Pass this to that worker now and post its answer.` The orchestrator passes it to that worker and posts the worker's answer; the worker treats it as your words relayed by the orchestrator ([`skills/orchestrator.md`](../../skills/orchestrator.md), [`skills/worker.md`](../../skills/worker.md)). The composer is offered only while the owning chat runs in the GUI.

## Forge World agents and code repositories

The sidebar groups each Forge World's work by project. Use **Agents +** on the world to start a chat across its projects, or under a project to start a chat for that project alone. A world chat starts in the world root and receives a separate grant in each available, initialized member project. Its selected role and Allow save setting apply to those grants; unrelated tracked projects are excluded. Removing a granted member or untracking the world stops the chat and revokes its grants. Restart to pick up newly added members.

The world root has no project database. A world-level Skitarii chat has a separate local mailbox in each available member project, bound to that project's grant. `dm_agent_identity` and `dm_agent_peers` list the project-labelled mailboxes; set `project` to a listed project name when sending, reading, acknowledging or using `dm_call`. Calls that could target several projects refuse an omitted selector instead of choosing one. Automatic delivery watches each member independently and includes its project in the received context. An empty world reports that it has no project mailboxes. Project-level Skitarii agents retain their normal single-project tools.

World-level agents can also use the per-project `dm --repo … --token-file …` commands in their launch instructions. Reach tokens remain in the chat's private scratch directory under app data, outside the synced world. Restart preserves the chat's member mailbox identities; removing a member from the world removes its mail route. Deleting the root chat purges accessible member inboxes and records a durable deletion intent for an unavailable member, applied when that member is reopened. No unrelated tracked folder is included.

Every Forge agent launch receives the current `forge-world.json` repository map and the portable `FORGE-REPOSITORIES.md` directions. Each manifest entry identifies a ticket folder and its GitHub code repository URL. An existing `.darkmechanicus/local/source-checkout.json` can supply a machine-local checkout hint; the agent verifies its Git origin before use. On a second computer, it clones a missing repository into a separate code directory only when the task needs that code. Opening a world does not clone every linked repository. Code edits and tests belong in the code checkout; Dark Mechanicus commands stay pinned to the ticket folder.

### Preparing and running setup

1. Open **Forge Worlds +** and choose **Create a Forge World…**. Name the private ticket repository. To create code at the same time, choose its repository name, visibility, recipe and local checkout parent. In an existing world's **Source control** tab, **New code repository** creates code and adds a ticket member to that world. Use **Resume creation** if an operation stops partway. Resume verifies the original GitHub account, repository receipts and local folders before continuing.
2. Open **Recipe book** in the world's **Source control** tab to review or copy a recipe and edit its steps. Saving the book updates the portable recipe. Select the recipe when creating a code repository to materialize its scaffold. The Electron recipe includes conversion and launch steps to run when setting up the environment.
3. Choose a connected setup agent during creation, or set the world's default agent for imports. A member can have its own default. **Open onboarding** in the member's source controls and **Prepare with agent** in **Delivery Standards** use the same preparation conversation. If no configured agent is available, choose one and open the existing onboarding request. Import can detect requirements and draft setup while the person reviews them. Installer execution starts through **Set up environment**.
4. Review the workflow and verified local checkout, then confirm **Set up environment**. Use **Open setup chat** when the execution conversation is available. A submitted startup receipt records delivery to that conversation. Check the agent's observed results before treating the environment as ready. When delivery is uncertain, inspect the existing conversation and receipt before requesting any further setup.

The world's `forge-recipes.yaml` contains portable recipes. Each member's `.darkmechanicus/knowledge/forge-setup/workflow.yaml` contains its detected prerequisites, source revision, agreed steps and notes. The adjacent `guide.md` explains what the data means on another machine. A configured workflow records the agreed steps. The execution conversation records this machine's build, tests and launch observations.

Import starts one combined setup and Delivery Standards preparation conversation when its configured agent is available. The agent starts from an app-managed directory with its normal planner grant scoped to the ticket project. After the person agrees, the agent may edit only that member's setup `workflow.yaml`. It keeps generated repository and evidence fields, advances the revision, and re-reads the file immediately before saving. Resolve a changed revision with the person. Direct editing has no atomic revision check across editors. Use the desktop workflow editor when you need a save checked against an expected revision. Delivery Standards still use their normal command, revision and approval.

**Set up environment** asks the same configured provider to execute the reviewed workflow in a linked execution conversation. It starts in the verified code checkout with a ticket-member grant. Its launch is bound to the confirmed checkout and workflow digest. Ambiguous delivery stays visible on the existing receipt. Opening the execution transcript cannot launch an installer again.

### Continuous Forge World sync

Forge World repositories stay on `main`; member **code** repositories keep their normal branch workflow. Opening or syncing an older off-main world preserves its portable edits in a commit, switches to (or creates) `main`, and merges the preserved work. A conflict stays on `main` for repair; sync never discards work or force-pushes. The app's branch controls cannot create or switch a Forge World to another branch.

While the app is running, each world's configured interval commits all Git-visible portable files, fetches and merges remote `main`, validates the world and its records, then pushes `main`. Ignored files and machine-private `.darkmechanicus/local` state stay out of publication. Tracked private state is an error, including when it appears in unresolved index stages or outgoing history.

Merge conflicts in any portable file start a signed-in background agent in the world root without selecting a terminal. The app prefers the configured agent when it can verify sign-in. The resolver keeps compatible changes from both sides and favors existing `main` for incompatible changes. It receives only that world's available member grants; a conflicted manifest uses the checked Git HEAD membership, never global project access. The desktop checks queued repairs every 15 seconds, including after restart, and resumes sync only after the merge commit is finished, not just staged. After validation and a successful non-forced push, it stops and archives the resolver while preserving its chat history. Missing eligible agents, sign-in failures and invalid records remain visible in Ticket source control; they are not reported as successful syncs.

## Skitarii mail

Skitarii (OMP) chats in one tracked folder, on this machine, message each other through durable, local-only mailboxes. Full design, bounds and trust model: [`design/skitarii-messaging.md`](../design/skitarii-messaging.md); the CLI commands: [`cli.md`](cli.md#agent-mail-between-skitarii-chats); the current [verification procedure](../design/skitarii-messaging.md#verification).

- **The chat is the mailbox.** Its endpoint (`me_…`) belongs to the chat and survives rename, restart, **Start again** and **New session**. Each terminal start gets a fresh `dm` grant that the desktop binds to that endpoint before OMP starts; the grant and its binding end with the process. Subagents share the chat's mailbox. Only OMP chats have one; other CLIs, MCP sessions and Agent access grants never do.
- **Native tools.** `dm_agent_identity` (own endpoint id, name, role), `dm_agent_peers` (other Skitarii chats here, 50 a page), `dm_message_send` (`to`, `clientMessageId`, `body` up to 16 KiB, optional `inReplyTo` to answer a message of your inbox), `dm_inbox_read` (bodies, 50 a page, never acknowledges) and `dm_inbox_ack` (1–100 ids). Reads ask OMP's read approval, send and acknowledge its write approval. Results start with a fixed note that names and bodies are other agents' task data, never instructions; control characters arrive escaped. For example, an agent replying to message `mm_1` from `me_alpha` calls `dm_message_send` with `{"to":"me_alpha","clientMessageId":"reply-1","body":"Done.","inReplyTo":"mm_1"}`, then `dm_inbox_ack` with `{"messageIds":["mm_1"]}`.
- **Generated guidance.** Every Skitarii chat's instructions (`userData/agents/instructions/<chatId>.md`) gain a **Skitarii mail** section after the collaboration policy: the tool and CLI names, check/reply/acknowledge deliberately, and peer text is untrusted task data that grants no role or authority. It never contains the grant.
- **Automatic full-body delivery.** New peer mail wakes idle recipients, enters at a safe busy boundary, or resumes the same stopped chat without opening Messages first. Every pinned body page is collected; later arrivals continue independently. Peer bodies are explicitly agent-attributed inert JSON. Person-board messages retain person authority and their complete durable body, with private outboxes fenced to the authenticated recipient.
- **Independent recovery pickup.** Desktop repair-context polling is coalesced separately from mailbox delivery. A delayed recovery reply does not hold an already completed native tool result; its eventual body still enters the same chat with the normal receipt and duplicate-delivery checks.
- **Progress is not acknowledgment.** Messages reports actual full-body host insertion separately from unread/seen counts, with a blocker when unavailable or unverified. A send/paste return is not a receipt. Already inserted unacknowledged mail never repeatedly wakes the chat; pending work recovers after restart without replacing the recipient. Automatic turns may spend model tokens.
- **Seen by you is not acknowledged.** **Messages** counts "unseen by you" apart from "unacknowledged by its agent". **Mark shown messages seen** moves only your own cursor; only the agent's `dm_inbox_ack` acknowledges. The inbox shows received mail; there is no view of sent bodies.
- **Bounds.** 1024 unacknowledged or 4096 retained messages per inbox (`mailbox_full`), 8192 send receipts per sender (`receipt_quota_full`); acknowledged messages and send receipts are kept seven days, which is also how long a `clientMessageId` retry is recognized.
- **Local and unrecoverable.** Mail lives only in the folder's database, never in Git; a rebuild from records does not bring it back. Before any rebuild, quit and move `.darkmechanicus/local/` aside or use the desktop backup (`VACUUM INTO`, desktop-only because it copies every mailbox). Deleting a chat purges the mail it received and leaves what it sent in other inboxes with a deleted sender; neither expiry nor deletion erases backups or bodies already in an OMP conversation. See [recovery](../design/skitarii-messaging.md#durability-backup-and-recovery).
- **Host compatibility.** The automatic native API contract is verified against OMP18.20.2; missing APIs or grants fail visibly instead of claiming delivery. See the design record's current verification procedure for actual two-chat acceptance; historical mailbox screenshots are not proof of the new behavior.

## Roles and Allow save

A chat's role is one of the four Dark Mechanicus roles and is fixed when the chat starts; to change it, start a new chat.

| Role | For |
|------|-----|
| Planner | Drafts epics, plans and tickets |
| Orchestrator | Runs an epic: claims tickets, starts workers and reviews what they hand back |
| Worker | Does one ticket and reports back |
| Reviewer | Checks finished work against its criteria |

**Allow save** exists only for the planner and the orchestrator. New orchestrators start with it on across ordinary chats, runs, Kanban cards and transfers; explicitly turning it off remains an opt-out. Other roles are not elevated. An existing orchestrator without it can call `request_save_permission` with a reason and inspect `list_save_permission_requests` for **pending**, **approved** or **denied**. In the folder's **Agent access → Allow save requests**, press **Refresh requests**, enter a decision reason, and choose **Allow save** or **Deny**. A distinct current orchestrator whose original launch/grant already allowed saving can also call `decide_save_permission`; acquired permission never lets it approve further requests, and the requester cannot approve itself (including another CLI session on the same grant).

Approval adds only `plan.save` in this folder and machine, for the existing grant until expiry/revocation (including subsequent `dm` invocations), or for that live MCP session until it ends. A grantless session must keep heartbeating within the normal 60-second active-session window; a command does not revive stale request-derived authority. It does not issue a token, extend a grant or enable general delegation. Decisions retain actor, reason and time in the request and event log. Denial changes no permission. Recheck `get_capabilities` after a decision; startup instructions are not the effective authority. An orchestrator's separate own-run saving/adoption rules remain unchanged. Checkpoint approval, retry grants and card approval/kick-back/deletion stay human-only.

## Start a run with an agent, or leave it pending

On a saved epic, **Start run** opens a dialog with two choices.

**Run with an agent** (button **Run with agent**). Pick a connected, signed-in agent and its model: Claude Code from its curated list (**Default (recommended)**, which leaves the choice to the CLI, **Opus**, **Sonnet**, **Haiku**), Autonomous by a typed id (empty for its own default; an id with anything but letters, digits and `. _ / + -`, or starting with one of those symbols, is refused before the run starts), and Codex, Cursor and custom CLIs on the model their CLI picks (**CLI default**). The CLI's own `/model` changes it later. Dark Mechanicus then, in this order:

1. Queues a run pinned to the epic's current saved revision (the same command **Leave pending** runs).
2. Creates a chat in that folder as an **orchestrator** titled **Orchestrator · <epic title>**, with **Allow save on**. It may save reviewed plans; you still approve every human checkpoint.
3. Starts the chat's terminal with the first message (as Claude Code's prompt, or typed into the other CLIs once their first screen is up), which you can read in the terminal: the epic, its branch, the run id, and the steps to follow (check `get_capabilities`, call `start_run`, run the epic itself and start a subagent for each ticket). A chat has no way to open an MCP prompt or a skill, so the message carries the orchestrator and worker guidance itself, in two marked sections after the steps (**Orchestrator guidance (for you)** and **Worker guidance**, the same text as the `darkmechanicus-orchestrator` and `darkmechanicus-worker` prompts). A step says how a worker is started: each worker subagent is given its whole execution packet (the attempt id and claim token `claim_ticket` returned, with the ticket) and the worker guidance. It runs in the orchestrator's session, so it heartbeats and submits for itself; the orchestrator reviews, accepts or rejects and does not submit on its behalf. The claim token goes only to the worker doing that ticket. The message itself holds no claim token. (Sprint 1's e2e report, defect 3, found that the earlier step "load the orchestrator prompt" could not be followed in a chat; the guidance is in the message now.)

The run bar then says **Orchestrated by <agent> in** and links the chat, and a toast says the run is queued. Follow the chat as it works; it asks its approvals in its terminal.

The optional **Additional instructions** field below the model takes guidance for this run in your own words (up to 32,000 characters). It goes once, at the end of the agent's first message, marked as yours and as applying within the epic and its saved plan: it does not change the chat's role, Allow save, the tickets' acceptance criteria or the plan. Leave it empty to start exactly as before; **Leave pending** ignores it. A card's **Play** dialog has the same field, for guidance within the card.

If something fails the run is still queued and the epic's banner says why: no agent is running it and it waits for an orchestrator, as if you had left it pending. An epic that cannot be read, a plan that is not saved, or an epic that already has an active run fail before anything is queued or created, and nothing exists afterwards. If the chat could not be created there is none; if its agent could not start (not connected, signed out, crashed), the chat is removed again so none is left claiming a run nobody is running. To recover, fix the cause (connect the agent, sign in) and either cancel the queued run with **Cancel run** and press **Start run** again, or start an orchestrator chat yourself and ask it to run the epic; it picks up the queued run with `start_run`.

**Leave pending** (**Leave pending**). Queues the run and waits: "Run queued. It starts when an orchestrator picks it up." The run bar says **Waiting for an orchestrator**. An external orchestrator, such as Claude Code connected over MCP as in [`mcp-setup.md`](mcp-setup.md#working-model-your-session-is-the-orchestrator), picks it up with `start_run`. This works with no agent connected.

Without a usable agent the first choice says **No agent is connected and signed in.** and links to the add-agent pane; **Leave pending** still works.

## When a login expires

A CLI's login can expire or be revoked while the app runs. The CLI says so in its own terminal; follow its prompt there, or press **Sign in** for the agent (above). The next start of a chat whose agent is signed out shows the sign-in card in its pane instead of the terminal, and starts the terminal once the status says signed in. Nothing is resent on its own.

A chat from before terminals whose turn a lost sign-in cut short is flagged in the sidebar (**Needs sign-in**) while its agent is signed out; the flag clears once a status check says signed in (the check runs when the window regains focus, so a sign-in finished elsewhere shows up when you come back to the app).

### A run paused for sign-in

If an orchestrator chat's CLI exits on its own and its status command then says signed out, the app pauses the chat's run when it is **running** (or already paused), with the reason `signed_out`. Only the desktop app can give that reason; an agent calling `pause_run` with it over MCP is refused. A run that is queued or waiting at a checkpoint is left as it is. A run that is already paused for another reason is switched to `signed_out` (see the lease note below).

- **The run bar says "Paused: <agent> signed out"**, links the orchestrator chat, and offers **Sign in** (or **Check again** for an unknown state) right there. **Resume run** stays off, with the tip "Sign in to <agent> first", until the agent's status says signed in. The app never resumes the run itself: you press **Resume run**, and no agent can: `resume_run` over MCP on a run paused for `signed_out` fails with `unauthorized` and says the person resumes it in the desktop app. ([`agents-e2e.md`](../reports/agents-e2e.md), defect 4, saw an orchestrator chat resume such a run over MCP; that was sprint 1, and the desktop-only `run.resume_signed_out` capability now stops it.)
- **The run keeps its open leases while paused.** A run paused for `signed_out` does not expire the leases of its open tickets, whatever their lease time, and workers' heartbeats still work, so a worker loses nothing while you sign in. On **Resume run**, each open lease is extended by the time the run spent paused, and the run records a `run.leases_extended` event with each attempt's old and new lease end. A run that was already paused for another reason (a ticket failure, your own pause) when its agent was signed out is switched to `signed_out`, so its open leases are kept from that moment. Runs paused for any other reason, and a run taken over from another machine, expire leases as usual.

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

npm installs agents on Windows as `.cmd` shims, and Node cannot start those without a shell. So a shim is run through exactly one `cmd.exe /d /v:off /s /c` parse with its path inside one pair of quotes: `&`, `^`, `(` and spaces in the path are literal, `!` expansion is off and AutoRun is skipped. Every argument after the path is a constant, and stopping a chat stops what the shim started. The cost is that a path with `"`, `%` or a control character cannot be run safely, and is refused rather than escaped. This applies to Find, to the sign-in terminal and to Codex, Cursor and Autonomous chats.

Claude Code chats work differently. Their instructions, settings and kickoff go on the command line, which the one `cmd.exe` parse cannot carry, so Dark Mechanicus follows an npm shim to the script or program it runs (the quoted path under `%dp0%`, next to the shim). Find may accept a Claude `.cmd` and the chat still fail with "Dark Mechanicus cannot launch Claude Code through that .cmd shim. Connect claude.exe instead (the native installer puts it in %USERPROFILE%\.local\bin)." when the shim cannot be read or followed. Connect `claude.exe` as the message says (Download installs it there).

A custom CLI's `.cmd` shim always goes through the System32 `cmd.exe` by its full path, and its arguments follow the same rules: one holding `"`, `%` or a control character, or ending in a backslash, is refused when you add it.

### Download failures

Nothing is stored on any failure. The codes: `busy` (a download of that agent is already running), `unsupported_platform` (no recipe for this system or processor), `download_failed` (the installer could not be fetched, or is not at an official address), `checksum_mismatch` (the script does not match the published checksum, so it was not run), `checksum_unavailable` (Codex only: GitHub published no checksum for the script, so nothing was downloaded), `installer_failed` (the installer exited with an error or ran over ten minutes; its last output lines are shown), `executable_not_found` (the installer finished but the CLI is not where the vendor puts it; use **Find**), `verify_failed` (what was installed did not pass the Find check) and `unexpected`. Declining the confirmation is not a failure; nothing is fetched or run.

### Sign-in problems

- **The sign-in terminal says it could not start.** The agent is not connected, is a custom CLI (whose sign-in is its own), the file is not a program the system can run, or the path is unsafe for `cmd.exe` (see above).
- **The login finished but the state did not change.** Finish the login in the browser and in the sign-in terminal, and then **Check again**.
- **Sign-in unknown.** The reason line says what happened. **Check again** asks once more. "Did not answer in time" means the status command took over ten seconds.
- **A chat's CLI says it is signed out but the agent page says signed in.** The status command reads only what the CLI stores locally and can say signed in for a login that no longer works. Sign in again from the agent's page, or follow the CLI's own prompt in its terminal.
- **A Cursor chat says it cannot reach Dark Mechanicus.** The app gives a chat no Dark Mechanicus MCP tools by design: the agent runs the `dm` command given in its first prompt, with its grant in `DM_SESSION_TOKEN`. An agent that looks for `darkmechanicus` MCP tools instead finds none; point it at that command.

## Start again, resume, and long-running chats

- **Start again** appears when the CLI has exited or been stopped; it starts the CLI again on the chat's session. Claude Code resumes with `--resume <id>` once its session file exists (a chat that exited before its first prompt, for example at the folder-trust question, starts again on the same new id); Autonomous runs `a8s resume` once the chat was typed into; Codex and Cursor resume with their stored session id when they have one.
- **New session** appears after a resumed session ended, for the case where the CLI refused to resume (it says so on its last screen); it clears the chat's stored session and starts a fresh one.
- **No idle stop.** A chat terminal runs until its CLI exits, the chat is deleted, its agent is removed, its folder moves, or the app quits; going quiet never stops it, so a long command or an orchestrator waiting on its workers runs for as long as it needs, for days if need be. While it runs, the app renews the chat's grant every hour, so its `dm` access does not lapse at the grant's 12 hours, and keeps the computer from going to sleep (the display can still turn off; closing a laptop's lid still sleeps it if its power settings say so).

## Known limitations

- **Windows: `ELECTRON_RUN_AS_NODE` reaches the CLI.** Packaged, the `dm` command is the app executable run with `ELECTRON_RUN_AS_NODE=1`. On macOS a per-chat launcher sets it for `dm` alone; on Windows there is no launcher, so the variable stays in the terminal's environment (`terminalEnv.ts`), and any Electron program the agent or you start in that terminal runs as Node.
- **Claim tokens are visible in an orchestrator's terminal.** A live terminal stream cannot be masked reliably, so `claim_ticket` output shows its claim token as the CLI prints it. The app stores nothing of the stream on disk; main's screen of it is in memory only.
- **Codex and Cursor flags are not verified live.** Their arguments (`-C`, `resume <id>`, `--resume <id>`, `-m`) are the design's inference; neither CLI was installed where this was built.
- **Windows is not verified live.** The Windows end-to-end ticket (DM-333) is optional and did not run on the Mac this was built on; the Windows paths (`.cmd` shims, ConPTY, the hook's exec form) are covered by tests only.
- **Claude Code's memory hook fails open in some cases.** Claude Code lets a call through when a hook exits with an error. On macOS the hook's launcher prints the "ask" answer itself when the runtime cannot start or the script fails, so those cases ask. On Windows the hook is started by the CLI with no launcher, so a hook that cannot start lets the write through. A hook the CLI gives up on (a timeout; the app sets none, so the CLI's default applies) is not handled by the app either. Claude Code 2.1.316 is reported to offer an `onFailure: block` hook option; the app does not set it and it was not tried. In every case the moved `autoMemoryDirectory` still makes the CLI ask before writing its real memory folders.
- **A physical Cmd+W or Cmd+Q press was not exercised.** Quit disposal was checked through automation (quitting the app); a person's key press closing the window or quitting was not.

## What was and was not verified

Verified on a Windows machine: Claude Code's `--version` and `auth status` output formats and its signed-out transcript were taken from a real Claude Code install, and the Windows `cmd.exe` launch rules are covered by tests that run against Node itself.

Not verified, and not claimed:

- **macOS.** Terminal chats were run live on a Mac with Claude Code (for example [`DM-326-07-live-log.txt`](../verification/DM-326-07-live-log.txt) and [`DM-329-05-live-log.txt`](../verification/DM-329-05-live-log.txt)). Not run on a Mac for this runbook: the macOS install recipes and folders, and the Find dialog on macOS.
- **Codex and Cursor** were not installed on that machine. Their sign-in detection comes from the vendors' source, documentation and forum posts, not from a real signed-out session. Cursor's `agent status` wording is not documented (the app matches "not logged in" and "logged in" style messages and otherwise says Sign-in unknown), neither is the output of `agent models`, and whether Cursor's agent runs the `dm` command it is given is unchecked.
- **Subagent threads for Codex and Cursor** (in transcripts from before terminals). The Codex mapping was read from the Codex source (tag `rust-v0.160.0`) and the Cursor outcome (one thread) from Cursor's ACP page and the Agent Client Protocol; no real Codex or Cursor ran.
- **Download against the live vendor endpoints.** The installer flow is tested with fake downloads and fake processes. This runbook does not record a real install on either platform.
- **Where `userData` is** on an installed build, as noted above.
- **Custom CLIs** are tested with fake processes; no third-party program was added on a real machine for this runbook.
- **Autonomous** behaviour comes from a recording of a8s 0.79.0 ([`autonomous-acp.md`](../reports/autonomous-acp.md)). Its signed-out `a8s doctor` and its stop at launch were recorded with an isolated profile that had never signed in; a sign-in lost while a chat runs was not observed, and the sign-in card for Autonomous was not run in the built app.
- **The app database import** was run once on macOS with an old build's `agents.json` ([`DM-248-acceptance.md`](../verification/DM-248-acceptance.md)).

The two items below were checked against the protocol chats that came before terminals (their adapters and the Claude Agent SDK are gone); they are kept as a record. The terminal's memory guard (a settings file and a command hook) was checked live separately ([`architecture.md`](../architecture.md#chats-records-store-terminals)).

- **Sprint 3's changes:** on Windows, against a real Claude Code, [`agents-fixes-e2e.md`](../reports/agents-fixes-e2e.md) ran these live: the memory switch (its gap is closed by the memory-folder check below), the stopped-turn marker, the cancelled approval and tool row after a quit and reopen, the process tree gone after a quit, one Allow for this chat covering the Dark Mechanicus tools, the kickoff hand-off that binds worker threads, and a retried attempt's Activity tab. Not verified live: the signed-out flag clearing, the account notices, Retry, the chat list in two windows, and anything with Codex, Cursor or a Mac. The account notices in particular come from the Agent SDK's error names, not from a real account in that state.
- **The memory-folder check:** on Windows, with Claude Code 2.1.281 and Agent SDK 0.3.289, the app's own Claude adapter was driven against the real CLI (Haiku, scratch folders, a throwaway harness that is not shipped). Each of these raised an approval card, and on Deny the memory folder's listing (names, sizes, hashes, times) did not change: a Write by absolute path, by `~`, by relative path (`..` six times up to `.claude\projects\<project>\memory`), with forward slashes, in upper case, and through a junction in the chat folder (relative and absolute); an Edit of an existing memory file; and shell redirects (`>>`, `1>>`, `>`, a relative target, through the junction). Without the hook and the setting the same Write by `~` and by relative path, and `echo hi >> <memory file>`, ran with no card and wrote the file. On Allow the memory write happened; an ordinary Write in the chat folder still asked, and wrote on Allow. A `CLAUDE_CONFIG_DIR` set to the default folder (with forward slashes) changed nothing. A Write into the unused folder itself asked too, but only because of the hook (the CLI exempts that folder); a shell redirect into it is not asked about and fails, because the folder does not exist. The sprint 4 acceptance round then ran the main cases in the running app, through its chat view ([`agents-fixes-e2e.md`](../reports/agents-fixes-e2e.md), Sprint 4): in a Haiku chat a Write by absolute path and by `~` raised a file-edit card and a shell redirect (`echo hi >> <memory file>`) raised a command card; each was denied with the project's `memory\` folder unchanged (names, sizes, hashes); the absolute path asked again and, on Allow once, was written. A plain "Remember that my code word is PINEAPPLE." wrote nothing and raised no card, and an ordinary `ordinary.txt` in the chat folder asked as before. The process the app started carried `--settings` with `autoMemoryDirectory` set to the temp folder's `dark-mechanicus-unused-memory`, which did not exist afterwards. **Not verified live:** MultiEdit and NotebookEdit (tests only), the PowerShell tool, macOS and Linux, a `CLAUDE_CONFIG_DIR` that points somewhere else (the login lives in the default folder), and a real `autoMemoryDirectory` of yours (a managed, organization-level value would outrank the app's).
