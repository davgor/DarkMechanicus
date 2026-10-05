# Agents end-to-end check: Claude Code on Windows

Run on 2026-10-04 (evening, US Central; timestamps below are UTC, so 2026-10-05) against the **packaged Windows build** of branch `dm-61` (the Agents sprint integration branch `agents-s1`, app version 0.15.0), with the person's own signed-in Claude Code CLI `2.1.281` at `C:\Users\davgo\.local\bin\claude.exe`.

**Scope.** Codex, Cursor and macOS were culled from this epic by the person. This report covers Claude Code on Windows only. Nothing here says anything about Codex, Cursor or macOS, and `docs/runbooks/agents.md` still describes them as before. Download (the vendor installer) was not exercised either: only Find.

## How it was run

- `npm run package:win` passed (57 s). The build under test is `release\win-unpacked\DarkMechanicus.exe` (NSIS and portable installers were built too).
- The exe was launched with a **throwaway** `--user-data-dir` and `--remote-debugging-port`, never against `%APPDATA%\dark-mechanicus`. The person's own app was not touched. `DISABLE_AUTO_UPDATE=1` was set on the test instance because a packaged exe checks GitHub on launch, found the already-cached v0.16.0 installer straight away ("Version 0.16.0 is ready. Restart now"), and `autoInstallOnAppQuit` would have run that installer when the test quit (see Discoveries).
- Three scratch git repos sit under the evidence folder, outside this repository: `scratch-chat` (chat folder), `scratch-agent` (epic for **Run with an agent**) and `scratch-pending` (epic for **Leave pending**). Each epic has one tiny ticket ("Append a line to NOTES.md", plan lease policy 90 s) plus the sprint acceptance ticket the plan adds by itself. They were created with the app's own core library (a seed script that calls `openWorkspace`), not through a scratch MCP server or the New epic dialog.
- The app was driven over the Chrome DevTools Protocol (clicks and typing in the page). Native file dialogs (Find, Track a folder) were driven with Windows UI Automation window messages. Every screenshot is a CDP page capture at 1280x800, except the Find dialog (a window capture).
- Everything the chats and runs did was on scratch repos. Real agent turns used Haiku, then Sonnet.

## Claude Code on Windows: steps

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Find the existing install (Add an agent, Find, pick `claude.exe`) | **Pass.** The dialog opened in `~\.local\bin`, title "Locate the Claude Code CLI (claude.exe or claude.cmd)"; the card became "Connected · v2.1.281" | `02-find-file-dialog.png`, `03-claude-connected-signed-in.png` |
| 2 | Shows as signed in | **Pass.** Card and sidebar say Signed in; `claude auth status` agreed (`loggedIn: true`) | `03-claude-connected-signed-in.png` |
| 3 | Create a chat in a tracked scratch folder | **Pass.** Track a folder, New chat: Claude Code, Haiku, Worker. The chat opened at once | `07-read-no-prompt.png` |
| 4a | Read a file: no prompt | **Pass.** `Read facts.txt` ran with no approval card and the agent answered correctly (see defect 1 for the memory writes in the same turn) | `07-read-no-prompt.png` |
| 4b | Edit a file: approval, Deny, then Allow once | **Pass.** The card showed the file and a one-line diff. Deny: the agent was told no and `edit-me.txt` was unchanged. Retry plus Allow once: the file became `edited by agent` | `08-edit-approval-card.png`, `09-edit-denied.png`, `10-edit-allowed-once.png` |
| 4c | Run a command: approval, Deny, then Allow once | **Pass.** The card showed `echo ran-by-agent > ran.txt` and its working directory. Deny: no `ran.txt` was created. Retry plus Allow once: `ran.txt` was created | `11-command-approval-card.png`, `12-command-denied.png`, `13-command-allowed-once.png` |
| 5a | Switch model | **Pass.** Header select Haiku to Sonnet. The transcript recorded "Model changed from Haiku to Sonnet. It takes effect from the next turn." and the next turn answered as Sonnet | `14-model-switched.png` |
| 5b | Stop a turn | **Pass.** Mid-turn the chat showed ANSWERING and a Stop button; after Stop the composer was usable again and the chat kept its history (but see defect 5) | `15-turn-running-with-stop.png` |
| 6 | Quit and reopen; the chat resumes with context | **Pass.** After a code word was told to the agent "only in this conversation" (kept out of every file), the app was quit and reopened. The new `claude.exe` was started with `--resume=081b0ac9-...` and, with tools off, answered `KESTREL-4402` | `18-chat-resumed-recalls-code-word.png` |
| 7 | Chat's session appears with role and label | **Pass, with a caveat.** The scratch folder's MCP `list_sessions` showed `role: worker, label: "Claude Code · New chat", transport: stdio` (pid matched the chat's MCP child) next to the Desktop session. The app UI itself shows only a count, "1 agent session · stdio" (see defect 2) | `17-mcp-connection-one-agent-session.png` |
| 8 | No agent processes left after quit | **Pass.** Before quit the instance had `claude.exe` (plus its `conhost`) and an `ELECTRON_RUN_AS_NODE` MCP child under it. After a normal window-close quit (no `/F`) every one of those PIDs was gone, both times the app was quit. The scratch-chat agent process was no longer in the list at the second quit, which fits the 10-minute idle stop (not timed) | `proc-before-quit` / `proc-after-quit` listings in the evidence folder (not committed) |

The first quit was a plain `taskkill /PID` (WM_CLOSE to the window), which is the same as closing the window.

## Runs

### Run with an agent (Claude Code)

1. Epic page, **Start run**, **Run with an agent**: Claude Code, Sonnet (`19-start-run-dialog-run-with-agent.png`). The app queued run `rn_01m453b466ekrp60f9bwbww4n1` (event `run.queued` by the Desktop session), created the chat "Orchestrator · Append a notes line (agent run)" (orchestrator role, **Allow save off**) and sent the kickoff message.
2. The chat called `get_capabilities` (approval card, `21-orchestrator-get-capabilities-approval.png`), read the epic, registered a host, called `start_run` (event `run.started` by the chat's own MCP session `Claude Code · Orchestrator · Append a notes line (agent run)`, role orchestrator), then `claim_ticket` for AG-2 (event `attempt.claimed`). Every tool call needed an approval card, which I answered. **Pass for c4 (first half).**
3. The kickoff's step 2 ("load the darkmechanicus-orchestrator prompt") is not something a Claude Code chat can do here; see defect 3.

### Run left pending, picked up by an external orchestrator

1. `scratch-pending` epic, **Start run**, **Leave pending**. Run `rn_01m453qwe0fp27k6jtrdz6ztty` was queued and the run bar said "Waiting for an orchestrator" (`27-run-left-pending.png`). At that moment Claude Code was signed out, and the Start run dialog correctly listed it under Not available with a Sign in button (`26-start-run-dialog-signed-out.png`).
2. After sign-in, from the scratch repo: `claude -p "<get_capabilities, register_host, start_run for the epic, then stop; do not claim>" --mcp-config <json> --strict-mcp-config --allowedTools "mcp__darkmechanicus__get_capabilities mcp__darkmechanicus__register_host mcp__darkmechanicus__start_run ToolSearch" --model haiku --max-turns 10`. The JSON holds the server entry that `src/main/desktop/mcpConfig.ts` builds for a packaged app (the app exe with `ELECTRON_RUN_AS_NODE=1`, `app.asar\out\main\mcp.js --repo <scratch-pending> --role orchestrator --label "External Claude Code orchestrator"`).
3. The agent reported role Orchestrator, run `rn_01m453qwe0fp27k6jtrdz6ztty`, state running. The run events show `run.started` at 04:24:02Z by the session `External Claude Code orchestrator` (role orchestrator, stdio), and the run bar showed "started 13s ago · host claude-haiku" (`35-pending-run-picked-up-by-external-orchestrator.png`). I then canceled the run; no ticket was claimed. **Pass for c4 (second half).**

### Sign-out during a run (c6 and c7)

Timeline (UTC; "app" is what the Dark Mechanicus run events recorded):

| Time | What happened |
|------|---------------|
| 04:01:05 | `run.started` by the orchestrator chat's session |
| 04:01:15 | `attempt.claimed` AG-2, lease 90 s, ends 04:02:45.4 |
| 04:02:15 | `claude auth logout` in a terminal (the chat was waiting on a pending command approval; I allowed it right after) |
| 04:02:16 | `run.paused`, reason **signed_out**, by the Desktop session |
| about 04:02:20 | The chat showed the Signed out card, "Not logged in · Please run /login", pill Needs sign-in, composer closed (`23-signed-out-card-orchestrator.png`). The subagent call (`Agent`) in that turn had shown FAILED |
| 04:02:25 | Run bar: "Paused: Claude Code signed out", chat link, **Sign in**, **Resume run** disabled; sidebar says Signed out (`24-run-paused-signed-out-run-bar.png`) |
| 04:04:01 | 76 s after the lease end: attempt still `claimed`, run still paused `signed_out` (`25-attempt-past-lease-still-claimed.png`, "AG-2 #1 claimed · lease 00:00") |
| 04:15:48 | 13 min after the lease end: the same, still `claimed` |
| by 04:15:48 | The person had signed Claude Code back in (`claude auth status`: `loggedIn: true`) |
| about 04:16 | The app **still showed Signed out** on the card and in the sidebar (`28-cli-signed-in-app-still-signed-out.png`). I pressed the card's **Sign in**: the app opened a `cmd.exe` window running `claude auth login` (it was already gone when I went to close it). Within seconds the card said "Signed in again. The message that was cut short has not been sent yet." with **Retry** (`29-card-signed-in-again-retry.png`) |
| 04:16 | **Retry**: the card became Retried ("Turn retried. Claude Code is answering your message again."). The transcript still holds a single kickoff message; the turn continued once (`34-retried-turn-ended-once.png` is the end of that turn) |
| 04:20:51 | **`run.leases_extended`** (+1,115,428 ms: AG-2's lease 04:02:45.4 to 04:21:20.8) and **`run.resumed`**. Both were made by the orchestrator chat's MCP session calling `resume_run` (see below), not by the Resume run button |
| 04:21:25 | A worker subagent edited NOTES.md; its `submit_attempt` came 4 s after the extended lease end, so the run recorded `attempt.lease_expired` |
| 04:21:41 / 04:21:46 | The orchestrator called `reconcile_attempt` (resubmit) and `accept_attempt`: AG-2 accepted, `NOTES.md` ends with "Hello from the DM-61 e2e." (`31-run-resumed-ag2-accepted.png`, "1 of 2 accepted") |
| after | I denied the chat's claim of the acceptance ticket AG-1 and canceled the run ("canceled"), as the ticket allows ("stop it if it doesn't finish quickly") |

Things this run showed beyond the criteria:

- **The extra sign-in step was needed.** With the CLI signed in again, the app kept saying Signed out (card and sidebar) until the app's own Sign in button was pressed. The runbook says this ("the app keeps what the chats found until you start Sign in"), so it matches the document. It also means the person has to press Sign in even after signing in elsewhere.
- **I did not press Resume run.** After Retry, the orchestrator saw the run paused and called `resume_run` itself. I had an approval-answering loop running and it answered that card with Allow once before I could press the button. The button path (disabled until signed in, then enabled) was therefore **not exercised after sign-in**; the disabled state was captured while signed out (`24-run-paused-signed-out-run-bar.png`). The lease extension and the run continuing are real.
- After Resume, AG-2 had only the time left when the run was paused (the extension adds the paused time to the old end): about 29 s. The worker's submit missed it by 4 s. That follows the runbook's wording, but with a 90 s lease and a worker that does not heartbeat, a resumed attempt expires quickly and needs `reconcile_attempt`.

## Runbook (`docs/runbooks/agents.md`): where it was wrong or loose

- "Reads and searches inside the folder never ask. File edits, commands and anything else become an approval request" is not true for Claude Code's own memory folder: see defect 1.
- "named `<Agent> · <chat title>` in the app's session list": the app has no session list; only a count in the footer and the folder's MCP line. The label and role are visible through MCP `list_sessions` and on run records (host and worker labels).
- "Quitting the app stops every agent process" held both times. The 10-minute idle stop was not timed; the idle chat agent was simply gone later.
- "The app never resumes the run itself: you press **Resume run**." True for the app. Any orchestrator can still resume a run paused for `signed_out` over MCP (it did); the runbook does not say so.
- Everything else I walked through (Find with a file dialog, the add-agent and agent pages, the New chat and Start run dialogs, approvals, Stop, model switch, restart resume, the Signed out card with Retry, the run bar's Paused line, lease kept while paused and extended on resume) matched the text.

## Defects

1. **DM-53 and DM-60: Claude Code's own memory write bypassed the approval path.** I told the chat "remember this code word for later". It wrote two files, `codeword.md` and `MEMORY.md`, under `C:\Users\davgo\.claude\projects\C--Users-davgo-Documents-GitHub-dm-wt-evidence-DM-61-scratch-chat\memory\` with no approval card (both rows DONE). That is the scratch project's memory folder only; the person's DarkMechanicus project memory (`...GitHub-DarkMechanicus\memory`) was not written by this chat (its files were last changed at 22:46 and 22:47 local, before the chat's first message at 22:52, and by another session), and the scratch-agent and scratch-pending memory folders stayed empty. Expected: the runbook says file edits ask; the Claude adapter should either route this write through `canUseTool` or the runbook should say it does not. Actual: the CLI auto-allows its memory directory and the write never reached `canUseTool`. `07-read-no-prompt.png` shows the Write rows with no card.
2. **DM-60 (docs; or DM-52/DM-56 if a list is wanted): no session list in the app.** The runbook says the chat appears with its label in "the app's session list". Actual: the footer and the folder page show only "1 agent session · stdio". Role and label can only be read over MCP (`list_sessions`) or on run and attempt records. `17-mcp-connection-one-agent-session.png`.
3. **DM-59: the run kickoff asks for a step a Claude Code chat cannot do.** Step 2 of the first message says "Load the darkmechanicus-orchestrator prompt (the orchestrator skill)". In a folder without installed agent skills, the chat tried `Skill` and `ToolSearch` seven times over about a minute (03:57:49 to 03:58:59) and found no way to load an MCP prompt; it then continued from the server's built-in instructions and said so in its reply ("No tool here can load MCP 'prompts' directly ... Flagging this gap"). Expected: a step the agent can follow (include the guidance in the message, or tell it to use installed skills, or drop the step). Actual: wasted turns and the orchestrator guidance was not loaded. Evidence is in the chat transcript (`userdata\agents\chats\6fdc0bbc9b8a1fcd190b16b8\chat_f43226b8-....jsonl`, items at 03:57:49 to 03:58:59) and in the chat; I did not capture a screenshot of it.
4. **DM-123 (decision needed, low): an agent can resume a run that was paused for `signed_out`.** The runbook says only the desktop app gives that pause reason and "you press Resume run". The orchestrator chat called `resume_run` over MCP right after Retry and it succeeded (events `run.leases_extended` and `run.resumed` by an MCP session at 04:20:51). Expected: either the runbook says so, or the resume of a `signed_out` pause is left to the desktop. Actual: the agent did it. It was gated by an approval card, which I answered with Allow once. No screenshot of the card was taken.
5. **DM-57 (minor): Stop leaves no trace in the transcript.** After Stop the user's message stays with no reply and no "stopped" marker (the chat's stored items have no stop kind). Expected: a line saying the turn was stopped, as the model change gets. Actual: nothing. `15-turn-running-with-stop.png` is the turn while running; the stopped state looked like an unanswered message (`16-turn-stopped.png`).

No defect for DM-46, DM-47, DM-48, DM-49, DM-50, DM-51, DM-52, DM-56, DM-58, DM-122 or DM-124 came up in what was exercised. DM-48 (Download) was not exercised.

## Not verified

- Codex, Cursor and macOS (culled), and Download from the vendor (not run).
- The **Resume run** button after sign-in (the agent resumed first).
- Sign-out with **Retry** inside an ordinary (non-run) chat: the Signed out card, Retry and the pause all came from the orchestrator chat. The chat-level card is the same component.
- Whether `userData` for an installed build is `DarkMechanicus` (the runbook says it has not been checked); this run used an explicit `--user-data-dir`.
- Epic creation through a scratch MCP server or the New epic dialog (seeded with the app's core library instead).
