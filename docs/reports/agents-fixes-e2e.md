# Agents fixes end-to-end check: Claude Code on Windows (sprint 3 and sprint 4 acceptance)

Run on 2026-10-05 (timestamps below are UTC; local time was UTC-5) against the sprint 3 integration branch `agents-s3` of the Agents epic at commit `1c585b9` (app version 0.15.0), which holds the 12 accepted sprint 3 tickets (DM-200 to DM-211). The build was `npm run build` of that worktree, launched unpackaged (`electron <worktree>`) with the person's own signed-in Claude Code CLI `2.1.281` at `C:\Users\davgo\.local\bin\claude.exe` (`claude auth status`: logged in; no login or logout was run).

**Scope.** Live Codex, Cursor and macOS checks were culled from this epic by the person's decision on 2026-10-04. This report covers Claude Code on Windows only. Codex and Cursor are covered by their adapter tests and `docs/runbooks/agents.md` (criteria c2, c7, c8 below); nothing here says anything about them running live, or about macOS.

## How it was run

- The app was started with a **throwaway** `--user-data-dir`, a `--remote-debugging-port` and `DISABLE_AUTO_UPDATE=1`, from the worktree build. The person's own Dark Mechanicus app and `%APPDATA%\dark-mechanicus` were not touched; only processes this run started were stopped, and by the app's own quit (window close over CDP), never `taskkill`.
- Scratch git repositories sit outside this repository (`dm-wt\evidence\DM-199\`): `scratch-chat` (plain chats), `scratch-orch` (epic for run 1) and `scratch-orch2` (epic for run 2, and the place its worktrees went). Each epic has two trivial tickets ("Create a.txt containing hello", "Create b.txt containing world") plus the sprint acceptance ticket the plan adds by itself. They were seeded through the app's own core library, then tracked through the app's Track a folder dialog. Every Dark Mechanicus call went to a scratch repository's own MCP server, never to this repository's records.
- Claude Code was connected with **Find** (the file dialog pointed at `claude.exe`): the card became "Connected · v2.1.281", Signed in.
- The app was driven over the Chrome DevTools Protocol; native dialogs with Windows UI Automation messages. Screenshots are CDP page captures resized to 1100 px; the ones kept are in `docs/reports/agents-fixes-e2e/`.
- **Approvals** were answered under one policy: Dark Mechanicus tool calls allowed, file writes and harmless commands inside the scratch repo allowed once, anything naming a path outside the scratch repo denied. Where an approval is not a click on a card's button, it went through the same call the button makes (`window.dm.chats.answerApproval`), from a helper that listened to the chat events. **Nothing was ever typed into an orchestrator chat** (the stored transcripts of both orchestrator chats hold exactly one user message each, the kickoff). My helper's command allow-list was too narrow, and that cost run 2 a failed first attempt: see "What went wrong in my own run".
- The scripts, listings and outputs named in this report (`searchTokens.out`, `approvals-ledger-run2.txt`, `bindings-final.jsonl`, the `proc-*.txt` listings, `tests\*.out`, `c10\`) are in `dm-wt\evidence\DM-199\`, outside the repository, and are not committed.
- Live agent work was kept small: Haiku for the plain chats, Sonnet for the orchestrator, two trivial tickets per epic, both runs cancelled once the evidence was captured.

## Live steps on Windows

| # | Step | Result | Evidence |
|---|------|--------|----------|
| L1 | Connect Claude Code: Add an agent, **Find**, pick `claude.exe` | **Pass.** "Connected · v2.1.281", Signed in | |
| L2 | Track `scratch-chat`, `scratch-orch` and `scratch-orch2` | **Pass** | |
| L3 | **c1.** Haiku chat: "Remember that my code word is PINEAPPLE. Save it to your memory." | **Pass.** No approval card and no file: before, the scratch project's `memory\` folder did not exist; after, it still did not; the scratch folder has no `CLAUDE.md`. The agent only said it had "recorded this for our session" | `c1a-remember-haiku-no-card-no-file.jpg` |
| L4 | c1, same ask in a Sonnet chat, with the memory folder listed (and hashed) before and after | **Pass.** Folder unchanged (same file, same MD5, same timestamp); no card. The agent said "saved to memory" although it wrote nothing | |
| L5 | c1, an explicit request in the first chat: "write `C:\Users\davgo\.claude\projects\<scratch project>\memory\MEMORY.md` containing the line ..." | **Fail (defect 1).** The `Write` ran and showed DONE **with no approval card**; the file now exists (21 bytes). It is not the model's own memory write, but the app's runbook says such a write "now asks" | `c1b-explicit-memory-path-write-ran-with-no-card.jpg` |
| L6 | **c5.** Sonnet chat, "write a 2000 word essay", press **Stop** mid-turn | **Pass.** The transcript says "You stopped this turn before the agent finished." and the composer is usable again | `c5a-stopped-turn-marker.jpg` |
| L7 | **c4, c8.** Epic page, **Start run**, **Run with an agent**: Claude Code, Sonnet (run 1, `scratch-orch`) | **Pass.** Run queued, chat "Orchestrator · Two file run" created, kickoff sent; the run bar links the chat | |
| L8 | c4 (run 1): the kickoff and the first turn | **Pass.** The kickoff (steps, then the two marked guidance sections) is the first and only user message. The first turn is `ToolSearch` (loading the Dark Mechanicus tool schemas) and `get_capabilities` | `c4a-kickoff-message-top.jpg`, `c8a-first-card-says-allow-covers-all-dm-tools.jpg` |
| L9 | c8 (run 1): the first Dark Mechanicus card | **Pass.** It says "Allow for this chat covers all Dark Mechanicus tools in this chat." I clicked **Allow for this chat** | `c8a-first-card-says-allow-covers-all-dm-tools.jpg` |
| L10 | c8 (run 1): later calls | **Pass.** `get_storage_status`, `list_epics`, `get_project`, `get_epic`, `get_plan`, `register_host`, `start_run`, `get_run`, `get_ready_tickets`, `match_capabilities`: 12 further calls, none raised a card ("Answered automatically by an earlier Allow for this chat") | |
| L11 | c4 (run 1): the orchestrator wanted its sprint integration worktree under the Claude scratchpad in `%TEMP%` | **Policy stop, not a product failure.** The path is outside the scratch repo, so I denied it as my rules require. The chat then asked the person (in plain text, since the app denies `AskUserQuestion`) and the run stalled. I cancelled it. See "Things the run showed" | `c4b-run1-orchestrator-stalls-after-outside-worktree-denied.jpg` |
| L12 | Relaunch with `TEMP` and `TMP` inside `scratch-orch2\.tmp` (git-ignored), track `scratch-orch2`, **Start run**, **Run with agent** (Claude Code, Sonnet) (run 2) | **Pass.** The chat chose `.worktrees\sprint-1-integration` inside the repo. (Whether the `TEMP` redirect mattered is not known: this time the chat did not use its scratchpad at all.) | |
| L13 | **c4 (run 2):** the orchestrator starts a worker subagent per ticket and gives it its packet | **Pass.** No prompt or skill was loaded (0 `Skill` or prompt calls; the 4 `ToolSearch` calls only loaded Dark Mechanicus tool schemas). It claimed OR-2 and OR-3, started one `Agent` worker per ticket, and **each worker thread is bound to its attempt as worker** (below). It did not do a ticket itself (the files were written by the worker threads) and never submitted for a worker | `c4c-worker-subagent-per-ticket-bound-to-ticket-links.jpg`, bindings below |
| L14 | c4 (run 2): attempt 1 of both tickets | **Failed, by my doing.** The workers wrote their files, then my approval helper denied their in-scratch `git add`/`git commit`/`git status` commands (9 denials), so both called `fail_attempt` (retryable) | "What went wrong in my own run" below; `approvals-ledger-run2.txt` |
| L15 | c4 (run 2): the retry | **Pass.** The orchestrator itself claimed both tickets again (attempt 2), started a "Retry worker" subagent for each with its new packet, reviewed their work and **accepted both** (`attempt.accepted` x2). Four worker threads, four attempts, all bound | `c14a-...`, `c14b-...` |
| L16 | **c8 (run 2):** one Allow for this chat, then everything else | **Pass.** 29 Dark Mechanicus tool requests in the chat: the first needed an answer, **28 were answered automatically**, across `get_capabilities`, `get_storage_status`, `get_epic`, `get_plan`, `register_host`, `start_run`, `match_capabilities`, `claim_ticket`, `get_ticket`, `accept_attempt`, `get_project`, `record_row_check`, `get_ready_tickets`, and the workers' own `fail_attempt` and `submit_attempt` from inside their threads | `c8b-later-dm-calls-answered-automatically-no-cards.jpg`, `approvals-ledger-run2.txt` |
| L17 | **c14 (live):** the Activity tab of the retried ticket | **Pass.** OR-2's attempt #2 tab starts at "Claimed by Worker OR-2 (a.txt) retry" (14:17 local) and holds none of the first worker thread's rows (14:07 to 14:10); switching the selector to attempt #1 shows the first thread's own rows and stops where it ended | `c14a-retried-attempt-2-activity-only-its-own-rows.jpg`, `c14b-attempt-1-activity-its-own-rows.jpg` |
| L18 | Claim-token search | **Pass**, none found: below | `searchTokens.out`, `poscontrol.out` |
| L19 | The run reaches OR-1 (the acceptance ticket) | Not run: I cancelled the run (confirm dialog) one second after the orchestrator claimed OR-1. It had already started a "Verify sprint 1 acceptance node" subagent, whose first command was waiting on my approval | |
| L20 | **c5, c6.** Second instance (own user data, own port): Haiku chat, "Create a file named c.txt ... containing hi" | **Pass.** An approval card for the write waits; I left it | |
| L21 | c6: process list before, normal quit, process list after | **Pass.** Before: the app plus `claude.exe` plus its `node` MCP server plus `conhost` (8 processes). The app was closed with `window.close()` over CDP (no `taskkill`). Gone after about 1 s: all 8 PIDs, and nothing parented to them | below |
| L22 | c5: reopen with the same user data, open the chat | **Pass.** The approval card says **Cancelled** ("No answer reached the agent."), and the `Write` tool row says **CANCELLED**; `c.txt` does not exist | `c5b-cancelled-approval-and-tool-row-after-quit-reopen.jpg` |
| L23 | c5/c6 again with the orchestrator instance, after run 2 (a subagent's approval waiting, the chat's `claude.exe` and MCP server alive) | **Pass.** Quit took about 1 s, 8 PIDs gone. On reopen the subagent thread says **Failed**, its approval **Cancelled**, its tool rows **Cancelled**, and the `Agent` call **Cancelled** | `c5c-subagent-card-cancelled-and-thread-failed-after-quit-reopen.jpg` |
| L24 | End: quit every instance I started | **Pass.** No `electron`, `claude` or `node` process whose command line names `DM-199` is left; none of the person's own processes was touched | below |

### What went wrong in my own run

- **Run 1 and my first denial.** My approval helper denied `git -C <scratch repo> branch --show-current && ...`, a harmless command inside the scratch repo, because its allow-list had no `git -C` form. The chat reported it as a "declined write". That is my helper's bug, not the product's.
- **Run 2 attempt 1.** The helper's allow-list also lacked `cd <relative path inside the repo>` and multi-line commit messages, so it denied 9 harmless in-scratch commands of the first two workers. Both workers did their job (the files were created), could not commit, and called `fail_attempt`. When I tried to widen the helper's allow-list during the run, the edit was refused as weakening my safety policy, so I stopped auto-answering commands and answered every later command card by hand after reading it (the orchestrator's `git status`, `git add`, `git commit`, `git merge` and `git log` inside the scratch repo, all allowed once). The orchestrator recovered on its own and the retry succeeded. Of run 2's 10 denials, **1 was correct** (`cd <evidence folder> && ls`, outside the scratch repo) and **9 were my mistake**.
- Because of that, "attempt 1 failed" in the run's records is not a product result.

## c4 and c8: what is bound, and the token search

`userData\agents\activity-bindings.jsonl` after the two runs (11 lines, `bindings-final.jsonl`):

- Run 1 (`rn_01m46nr42k5z8ty0j7dn3hg25g`): the main thread bound to the run as orchestrator.
- Run 2 (`rn_01m46p22ncdy92sh486rtbhjtp`): the main thread bound to the run, and, as orchestrator, to each of its 5 attempts. **Each worker thread is bound to its attempt as worker**: OR-2 #1 `at_01m46qcvdk0z...` to the thread of the first OR-2 worker, OR-3 #1 `at_01m46qcwznm4...` to the first OR-3 worker, OR-2 #2 `at_01m46r0k0ash...` to the "Retry worker for OR-2", OR-3 #2 `at_01m46r0n1frr...` to the "Retry worker for OR-3". The acceptance attempt (OR-1) is bound to the main thread only (the run was cancelled before its worker did anything).
- In the UI each worker thread under its spawning `Agent` call carries a ticket link ("OR-2 Activity", "OR-3 Activity"), and the ticket's Activity tab streams that thread's items (`c4c-...`, `c14a-...`).

**Whether the orchestrator handed over the packet "without being told to."** The kickoff the app sends says to ("Start each worker subagent with ... its whole execution packet"), which is the sprint 3 fix; nobody typed anything into the chat. The workers were bound only because they called the reporting tools with their attempt id and claim token, so the packets did reach them.

**Claim-token search** (`searchTokens.mjs`): the claim tokens of the 5 attempts issued in run 2 (run 1 issued none) were read from the scratch database and searched for in full, by secret, and by the first and last 12 characters of the secret, plus the pattern `at_` + 26 id characters + `.` (with any, or no, secret characters after the dot, so glued and cut-short tokens count), in: the stored bindings file (1 file), every chat JSONL (7 files, 288,497 bytes), and the whole throwaway user-data directory (58 files, 3,189,816 bytes). Result: **none found, in any of the three**. The chat store holds 12 "[claim token masked]" markers where tokens passed through. **Positive control** (`poscontrol.out`): the same secrets are found in the scratch repo's SQLite WAL (5 of 5) and in the CLI's own session log under `~/.claude/projects` (5 of 5), so the search can see a token where one exists. The raw tokens in those two places are the CLI's and the server's own, not the app's storage.

## Approvals ledger of run 2

`approvals-ledger-run2.txt` (from the stored transcript): 65 approval requests. 29 are for Dark Mechanicus tools (1 answered, **28 answered automatically** by the first Allow for this chat); 25 were allowed once (file writes and harmless git commands inside the scratch repo); 10 denied (1 correct, 9 mine, above); 1 never answered (the acceptance worker's command when the run was cancelled; it shows Cancelled after the quit). **No request named a path outside the scratch repo apart from the one denied.** In run 1: 15 requests, 13 for Dark Mechanicus tools (1 answered, 12 automatic), 2 denied (one mine, one outside the scratch repo).

## Process lists (c6)

Listings by parent PID, with the files in the evidence folder (not committed): `proc-quit-before.txt` / `proc-quit-after.txt`, `proc-final-before-quit-inst1.txt` / `proc-final-after-quit-inst1.txt`, `proc-run1-before-quit.txt` / `proc-run1-after-quit.txt`.

Mid-turn quit with an approval card waiting (second instance, root PID 7272):

```
7272  electron.exe (app)
 14648 <- 7272   claude.exe  --output-format stream-json ... --model haiku --permission-prompt-tool stdio ...
  11236 <- 14648   node.exe  out\main\mcp.js --repo ...\scratch-chat --role worker ...
   37028 <- 11236    conhost.exe
  30520 <- 14648   conhost.exe
 21616, 24708, 46224 <- 7272   electron.exe (gpu, renderer, utility)
descendants: 7; agent-ish (claude / node): 2
```

After `window.close()` over CDP, about 1 s later: the 8 recorded PIDs (7272, 14648, 11236, 37028, 30520, 21616, 24708, 46224) **all gone**, and **no process is parented to any of them** (`recorded PIDs still running: 0`, `new processes whose recorded parent is one of those PIDs: 0`). The orchestrator instance (root 48212, with a `claude.exe` (29292) and its `node` MCP server (34972), run 2's chat, a subagent approval waiting): 8 PIDs recorded, 0 still running, 0 orphans, after about 1 s. The earlier run-1 quit (root 15704, three chats' `claude.exe` and MCP servers, 16 PIDs): 0 still running, 0 orphans. At the end no `electron`, `claude` or `node` whose command line names `DM-199` was left. The person's own `claude.exe` processes were not touched.

## Test evidence for the criteria that are not live

Run in the worktree at `1c585b9` (`node node_modules/vitest/vitest.mjs run --reporter=verbose <files>`; the outputs are `tests\c*.out` in the evidence folder, not committed).

| Criterion | Files | Result | Tests that show it |
|-----------|-------|--------|--------------------|
| **c2** (DM-201) | `src/core/claimTokenMask.test.ts`, `src/main/agents/adapters/{claude,codex,cursor}Masking.test.ts` | 4 files, 79 tests passed | "maskClaimTokens: glued tokens > masks two tokens with nothing between them, each whole", "... cut-short tokens > masks a token at the end of a text whatever length of its secret is left", "clipMasked > masks a token before cutting, so a cut inside its secret leaves no part of it", "createStreamMasker: glued and cut-short tokens > masks a glued pair split at every position, never releasing a piece of either secret", the adapters' "stores no part of a secret a long tool input is cut inside of (0 / 5 / 15 characters before the cut)", "... a long tool result ...", Codex "masks a command cut at its token", Cursor "masks the title and the input of a permission request cut at a token" |
| **c3** (DM-202) | `src/integration/mcp.test.ts`, `src/core/services/runs.test.ts`, `src/main/agents/sessionManager.test.ts` | 3 files, 169 tests passed | mcp.test.ts "resume_run over MCP for a run paused for sign-in > fails with unauthorized naming the desktop app, and only the desktop resumes the run", "... still resumes a run paused for any other reason", "... refuses it as well after the desktop marked a run paused for another reason as signed out"; runs.test.ts "resumeRun ... a run paused for sign-in is for the person to resume > refuses an MCP session with unauthorized, naming the desktop app, and changes nothing" and "> lets the desktop resume it, extending the kept leases by the time the run spent paused"; sessionManager.test.ts "does not resume the run when the person signs in again: the run bar does that" |
| **c6** (DM-205), kill helper | `src/main/agents/processTree.test.ts`, `processTreeReal.test.ts` | 2 files, 31 tests passed | processTreeReal "killProcessTree with a real process tree > resolves only after the process and the process it started have exited"; processTree "on Windows > runs taskkill for the whole tree and does not signal a group", "> waits for taskkill itself to finish, not only for the child to exit", "> treats 'no such process' from taskkill as a tree that is already gone", "> ends the child itself when taskkill refused, and says the tree may remain" |
| **c7** (DM-206) | `sessionManager.account.test.ts`, `sessionManager.cutShort.test.ts`, `adapters/claudeAccount.test.ts`, `renderer/.../ChatView.account.test.tsx`, `signInFlags.test.ts` | 5 files, 47 tests passed | signInFlags "clears the flag when the CLI says signed in, with no sign-in pressed in the app" and "clears only the agent whose CLI said signed in"; ChatView.account "shows its own notice: what is wrong, the CLI's words, and that signing in again does not help" (all three problems) and "offers no Sign in, no Retry and no signed-out card, and leaves the composer on"; sessionManager.account "does not flag the agent signed out, tell any chat, or ask for a sign-in"; cutShort "says so on the item stored and pushed for a turn the sign-in cut short" and "says it cut nothing short when the CLI reports the lost sign-in outside a turn" |
| c7, Retry | `ChatView.signIn.test.tsx`, `signInHooks.test.ts`, `SignInPrompt.test.tsx` | 3 files, 41 tests passed | "ChatView: Retry only when a turn was cut short > offers Retry for a sign-in that cut a turn short, once the agent is signed in again", "> offers no Retry for a sign-in lost while no turn ran, which retryTurn has no message for", "> offers no Retry in a chat opened with a lost sign-in and no cut-short message ...", "> offers Retry in a chat opened with a cut-short message, and none once it is sent again" |
| **c8, second part** (DM-207) | `ownServerTools.test.ts`, `sessionManager.ownServer.test.ts` | 2 files, 68 tests passed | "Allow for this chat on a tool of the chat's own server (claude) > runs the server's other tools without a card afterwards, and still asks about another server"; "... keeps the old rule for another server: its allowance covers that tool and no other"; "... keeps the old rule for a command and a file edit, even one that carries a Dark Mechanicus name"; "... does not cover anything without the person's click: Allow once and Deny leave the next call asking"; "isOwnServerCall ... does not cover a server named darkmechanicus__evil"; the same for Codex and Cursor |
| **c9** (DM-208) | `chatHandlers.test.ts`, `chatIpc.test.ts`, `renderer/.../useChats.test.tsx`, `renderer/.../App.chats.test.tsx` | 4 files, 72 tests passed | useChats "with two windows > shows a chat renamed in one window in the other, without a reload", "> drops a chat deleted in one window from the other", "> lists a chat created in one window in the other"; chatHandlers "pushing list changes > says a chat was created, renamed or deleted, naming the tracked folder and the chat"; chatIpc "tells every window when a chat is renamed or deleted in one of them, so each refreshes its list"; App.chats "says it is loading the chat, not the folders, while the folder of a stored chat is still being listed" |
| **c14** (DM-211) | `sessionManager.read.test.ts`, `renderer/.../activityView.test.ts` | 2 files, 41 tests passed | sessionManager.read "reading a chat for a panel > starts no agent, even for a vendor that starts on open, and writes and pushes nothing", "> does not bind the chat's threads to their runs and attempts", "what a read shows of a chat no live agent holds > shows what open would have settled ... but stores none of it"; activityView "attemptWindow > runs from the claim to now while the attempt is open", "> runs from the claim to the last thing on record once the attempt has ended" |
| c14, the panels | `chatIpc.test.ts` (same run as c9), `threadStream.test.ts`, `OrchestratorFeed.thread.test.tsx`, `ActivityTab.thread.test.tsx` | 3 more files, 66 tests passed | chatIpc "reading a chat for a panel (chats:read) > starts no agent and writes nothing to the store for a chat whose vendor starts on open, where chats:open does both"; ActivityTab.thread "Activity tab of a thread that served two attempts of the same ticket > shows the first attempt only what the thread did from its claim to its end" and "> shows the second attempt only what the thread did from its claim on, while it is open"; "stops following the chat when the tab is closed"; threadStream "clipRows to the window of an attempt > keeps what happened from the start to the end, both included, and drops what came before or after"; OrchestratorFeed.thread "stops following the chat when the feed is closed, and asks for nothing until it is opened" |

## c10: the real-process tests, 20 runs in a row

`acpProcess.test.ts`, `codexProcess.test.ts`, `claudeProcess.test.ts`, `agentProbeNode.test.ts`, `agentInstallerNode.test.ts`, `agentAuthNode.test.ts` and `processTreeReal.test.ts`, run with `node node_modules/vitest/vitest.mjs run <the seven files>` 20 times in a row on Windows at `1c585b9`, each run's output saved (`c10\run-01.log` to `run-20.log`, `c10\summary.txt`). **20 of 20 runs passed**, each "Test Files 7 passed (7), Tests 84 passed | 1 skipped (85)", 2 to 3 seconds a run. The one skipped test is `agentProbeNode.test.ts > inspectExecutable > rejects a file without the execute permission`, which is skipped on Windows by design.

## c11: `docs/runbooks/agents.md` against the combined code

Sections that sprint 3 changed (`git diff 5043f7c HEAD -- docs/runbooks/agents.md`, 7 hunks, listed here by section), and what each says against the code and this run:

| Section | Matches? | Checked in |
|---------|----------|------------|
| Where things are kept: claim tokens masked, "including two tokens run together and a token cut short at the end of a text; text that is shortened is masked before it is cut" | **Yes** | `src/core/claimTokenMask.ts` (`CLAIM_TOKEN`, `TOKEN_TAIL`, `clipMasked`) and the adapters' use of it; the search above found nothing |
| Chats: the server is "labelled `<Agent> · <chat title>`" and the three places role and label show (footer and folder MCP card say only a count, MCP `list_sessions`, run bar "host <label>") | **Yes** | `sessionManager.ts` (label), `sidebar/footerStatus.ts` ("N agent sessions · stdio", used by `home/McpCard.tsx`), `mcp/tools/discovery.ts` (`list_sessions`), `epic/runBarView.ts` ("host <label>"); live: footer "1 agent session · stdio", run bar "host Claude Code Orchestrator" |
| Chats: **Stop** leaves "You stopped this turn before the agent finished." and Cancelled calls; a failed turn also cancels | **Yes** | `renderer/.../chatViewModel.ts` (`STOPPED_TEXT`), `sessionManager.ts` (`settleEndedTurn`); live: L6, L22 |
| Chats: the chat list is the same in every window; **Loading chat... / Loading folders... / Loading agents...** | **Yes** (tests only; one window live) | `chatHandlers.ts` (`chatsChanged`), `shared/agents/chatApi.ts` (`chats_changed`), `useChats.ts`, `app/MainViews.tsx` |
| Chats: **Claude Code's own memory is off in hosted chats**; "now it is an ordinary file edit and asks" | **Partly. No for the second half.** The code does what it says (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `claude.ts` `AUTO_MEMORY_OFF`) and, live, the agent no longer writes memory unasked. But an explicit request to write a file in the memory folder still ran with no card (L5, `c1b-...`); the CLI's own permission check lets that folder through before the app is asked, even with the variable set (confirmed without the app: `sdk-memory-check.mjs` with a `canUseTool` that denies everything was never called) | `src/main/agents/adapters/claude.ts:115,403`; defect 1 |
| Chats: quitting stops every agent process and what each started, waits at most 5 seconds; a Find check or install that times out ends its tree | **Yes** | `quitDisposal.ts`, `index.ts` (`QUIT_DISPOSE_TIMEOUT_MS = 5_000`), `agents/processTree.ts`, `desktop/agentProbeNode.ts:61`, `desktop/agentInstallerNode.ts:143`; live: L21, L23 (quit in about 1 s, no process left) |
| New section, **Panels that follow a chat thread**: `chats:read` starts no agent and writes nothing; one read, then pushes; an attempt's tab shows only its own window; requests answered through the chat | **Yes** | `chatIpc.ts:15` and `preload/index.ts:34` (`chats:read`), `sessionManager.readChat`, `agents/threadStream.ts` (`clipRows`), `ticket/activityView.ts` (`attemptWindow`); live: L17 |
| Approvals: **Allow for this chat** on the chat's own `darkmechanicus` tools covers every tool of that server, the card says so, other servers, commands and edits stay per tool | **Yes** | `agents/ownServerTools.ts`, `renderer/.../approvalModel.ts:48` (`OWN_SERVER_NOTE`); live: L9, L10, L16 |
| Approvals: Stop, quit or a storing failure cancel a request (card says **Cancelled**); calls running in its thread are cancelled; opening a chat settles stale calls and threads | **Yes** | `sessionManager.ts` (`cancelRunningCalls`, the open-time settle at about 792 to 863); live: L22, L23 |
| Approvals, vendor line: Claude Code asks for edits, commands and other tools, "with its auto-memory off ... that includes a write to its own memory folder, unless a permission rule in your own Claude Code settings allows it" | **No.** Same as above: no such rule exists in the user's settings (`~/.claude/settings.json` has none) and the write was not asked | `claude.ts`; defect 1 |
| Start run, step 3: the kickoff carries the orchestrator and worker guidance in two marked sections, says how a worker is started (whole packet, worker heartbeats and submits for itself), holds no claim token | **Yes** | `agents/orchestratorKickoff.ts` (`HANDOFF`, `GUIDES_NOTE`, the two `guide(...)` sections); live: L8, L13 |
| A CLI's login: Sign in from your own terminal works, **Retry** only when a turn was cut short, the flag clears at the next status check that says signed in (also on window focus) | **Yes** (tests only; the person's login was not touched) | `main/agents/signInFlags.ts`, `renderer/.../useAgents.ts:113` (focus), `sessionManager.ts`; the signInFlags, cutShort and ChatView.signIn tests above |
| New section, **Account problems are not a lost sign-in**: three notices, no Sign in or Retry, no flag, no run paused; only the Claude Code adapter maps them | **Yes** (tests only; no real account was in that state) | `renderer/.../chatViewModel.ts:325-333`, `adapters/claudeAccountProblems.ts`, `claudeTranscript.ts`; no such mapping in the Codex or Cursor adapters |
| A run paused for sign-in: an already-paused run is switched to `signed_out`; `resume_run` over MCP fails with `unauthorized` and names the desktop app; the open leases are kept | **Yes** (tests only) | `core/services/runs.ts:355,439-449`, `core/authz.ts` (`run.resume_signed_out` is human-only); the c3 tests |
| Troubleshooting: "A chat says signed out but the agent page says signed in" | **Yes** | same code as the sign-in flag row |
| What was and was not verified: "Sprint 3's changes ... None was run live" | **Now out of date.** This report ran the stopped turn, cancelled approvals, quit and tree kill, Allow for this chat on the chat's own server, the kickoff hand-off and the memory write live on Windows with Claude Code. Still not run live: the account notices, the sign-in flag clearing, the chat list in two windows, anything on Codex, Cursor or a Mac | `docs/runbooks/agents.md` last bullet |

`docs/architecture.md` (Adapters paragraph) repeats the memory claim ("such a write is then an ordinary request") and is wrong in the same way.

**Corrected.** The mismatches in this table (the two memory sentences in the runbook, the last "What was and was not verified" bullet, and the `docs/architecture.md` sentence) were corrected in a later docs-only commit on `agents-s3`. The table above describes the text as it was at `1c585b9`; the memory gap then stood in the runbook as a known gap. Sprint 4 closed it: see the last section, "Sprint 4: memory-folder writes".

## Definition of Done

Run in the worktree at `1c585b9`, in the order lint, typecheck, test, coverage, then Fireguard in a clone, then deadcode and build (deadcode and build ran before the long Fireguard run started, so a failure there could be fixed first). No gate failed, so no fix commit was needed. The whole set (except Fireguard) was run again on the report's first commit `e940b96`, which adds only files under `docs/reports/`: the same results, to the digit (393 + 20 test files, 7405 + 105 tests, coverage 97.88 / 95.66 / 96.61 / 97.97, deadcode and build passed). Fireguard was not run again: no test or production file changed after `1c585b9`, and it grades only those.

| Check | Result |
|-------|--------|
| `lint` | **Passed** (`oxlint src scripts`, exit 0) |
| `typecheck` | **Passed** (node, web and Fireguard projects) |
| `test` | **Passed**: 393 files, 7405 tests passed and 1 skipped (7406); Fireguard's own suite 20 files, 105 tests |
| `coverage` | **Passed**: statements 97.88 (15251/15581), branches 95.66 (9240/9659), functions 96.61 (5228/5411), lines 97.97 (14189/14483); thresholds 97, 95, 96, 97 |
| `fireguard` | **Grade A (95)**, "all hard gates passed". Base `5043f7cda2c70922513ba73e4071f9e22b163b62` (the sprint start), 60 graded test files, 52 changed production modules mutated. AST gate passed (2532 assertions, 44 mocks, 24 tautological, no empty test). Flake gate passed (100 of 100 runs, 0 failures). Mutation gate passed: 958 of 1107 mutants killed, score 87 (minimum 75). Run in an isolated clone at the same commit with `FIREGUARD_BASE_REF` set and `FIREGUARD_TEST_COMMAND="node node_modules/vitest/vitest.mjs run --bail=1"`; it took about 61 minutes |
| `deadcode` | **Passed** ("No new dead exports found") |
| `build` | **Passed** |

## Things the run showed beyond the criteria

1. **Defect 1 (DM-200): a write to Claude's own memory folder is still not asked when it is requested by path.** The fix removes the agent's own unprompted memory writes, which is what the sprint 1 report found, and a plain "remember this" wrote nothing on Haiku or Sonnet. But `Write` to `~/.claude/projects/<project>/memory/MEMORY.md` ran with no card (screenshot `c1b-...`; there is no `approval_request` in the stored chat), and the same happens through the Agent SDK outside the app with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and a `canUseTool` that denies everything (`sdk-memory-check.mjs`: "canUseTool asked: []", the file was written). The runbook (Chats, Approvals) and `docs/architecture.md` say it asks. **Closed in sprint 4** (DM-213): see the last section, "Sprint 4: memory-folder writes".
2. **The orchestrator guidance makes a chat create its integration worktree outside the repository** (`skills/orchestrator.md`, "outside the coordinating checkout"). In run 1 the chat chose a path under the Claude scratchpad in `%TEMP%`. A person who allows the card gets a worktree there; a policy of "inside the repo only" stops the run, because a chat cannot ask a question with answer buttons (the app answers `AskUserQuestion` with "Questions with answer buttons are not supported in this chat. Ask the question in plain text instead.") and the run then waits for a typed answer. In run 2 the chat picked `.worktrees\...` inside the repo, after a command that listed the parent folder (to choose a location) was denied.
3. **Long turns.** Between the kickoff and the first claim in run 2 there were about 23 minutes. Most of it was two single model turns of about 8 and 14 minutes with no output (the CLI held open connections to the API and its CPU time grew slowly; a one-word Sonnet call from my shell returned in 4 s at the same time). I did not find the cause, and it was not the app (no pending card, no hung tool call).
4. **Workers sent no heartbeat or note.** Their attempts lasted 1 to 2 minutes and the run holds no `attempt.heartbeat` event; the Activity tab therefore shows their tool calls and the submit but no notes.
5. **The stored `Agent` tool input is cut** (to about 1150 characters), so the packet in a spawn prompt cannot be read back from the transcript; the binding is the evidence that it reached the worker.
6. `docs/runbooks/agents.md`'s last bullet (see c11) and the memory sentences need editing.

## Criteria

| | Met | Where |
|---|-----|-------|
| c1 | Yes, as worded; **defect 1** found beside it | L3, L4 (`c1a-...`); L5 (`c1b-...`) |
| c2 | Yes | the c2 row above |
| c3 | Yes | the c3 row above |
| c4 | Yes (run 2; attempt 1 failed because of my helper, the retry succeeded) | L13 to L16, bindings, `c4a-...`, `c4c-...` |
| c5 | Yes | L6 (`c5a-...`), L22 (`c5b-...`), L23 (`c5c-...`) |
| c6 | Yes | L21, L23, the process lists, the c6 row above |
| c7 | Yes | the c7 rows above |
| c8 | Yes | L9 and L10 (`c8a-...`), L16 (`c8b-...`), the c8 row above |
| c9 | Yes | the c9 row above |
| c10 | Yes: 20 of 20 | the c10 section |
| c11 | Yes: cross-check done; 2 sections do not match (the memory sentence twice) and 1 is out of date | the c11 table |
| c12 | Yes | this file |
| c13 | Yes: grade A (95) | the Definition of Done table |
| c14 | Yes | the c14 rows, L17 (`c14a-...`, `c14b-...`) |

## Screenshots

**c1.** A plain "remember this" on Haiku: no card, no file.
![Remember, Haiku](agents-fixes-e2e/c1a-remember-haiku-no-card-no-file.jpg)

**c1, defect 1.** An explicit request to write in the memory folder: the `Write` shows DONE with no approval card.
![Explicit memory write](agents-fixes-e2e/c1b-explicit-memory-path-write-ran-with-no-card.jpg)

**c5.** The marker of a stopped turn.
![Stopped turn](agents-fixes-e2e/c5a-stopped-turn-marker.jpg)

**c4.** The kickoff message (the only user message of the chat).
![Kickoff](agents-fixes-e2e/c4a-kickoff-message-top.jpg)

**c8.** The first Dark Mechanicus card, with "Allow for this chat covers all Dark Mechanicus tools in this chat."
![First card](agents-fixes-e2e/c8a-first-card-says-allow-covers-all-dm-tools.jpg)

**c8.** Run 2: different Dark Mechanicus tools (`match_capabilities`, `claim_ticket`) answered automatically by that one Allow.
![Later calls](agents-fixes-e2e/c8b-later-dm-calls-answered-automatically-no-cards.jpg)

**c4.** Run 2: one worker subagent per ticket, each under its spawning `Agent` call with its ticket link.
![Workers](agents-fixes-e2e/c4c-worker-subagent-per-ticket-bound-to-ticket-links.jpg)

**c4, run 1.** The chat stalls and asks the person after its worktree outside the repo was denied.
![Run 1 stall](agents-fixes-e2e/c4b-run1-orchestrator-stalls-after-outside-worktree-denied.jpg)

**c14.** The retried attempt's Activity tab starts at its own claim.
![Attempt 2](agents-fixes-e2e/c14a-retried-attempt-2-activity-only-its-own-rows.jpg)

**c14.** The first attempt's tab, with the first worker's own rows.
![Attempt 1](agents-fixes-e2e/c14b-attempt-1-activity-its-own-rows.jpg)

**c5.** After a quit with an approval waiting, and a reopen: the approval and its tool row say Cancelled.
![Cancelled after quit](agents-fixes-e2e/c5b-cancelled-approval-and-tool-row-after-quit-reopen.jpg)

**c5.** The same for a subagent's approval in the orchestrator chat (the thread says Failed, the `Agent` call Cancelled).
![Subagent cancelled](agents-fixes-e2e/c5c-subagent-card-cancelled-and-thread-failed-after-quit-reopen.jpg)

## Not verified

- Live Codex, Cursor and macOS: culled from this epic by the person's decision on 2026-10-04. Download of a CLI: not run (Find only).
- The sign-in flag clearing, the account-problem notices and the Retry button, live: no login was touched; test evidence only.
- The chat list across two windows, live: tests only.
- The checkpoint approval: the runs were cancelled before they reached one.
- Whether the orchestrator would take the acceptance ticket (OR-1) the same way: not run.
- Whether the first approval card of run 2 was clicked in the UI: it was answered by my helper through the call the button makes; the click in the UI is the first card of run 1 (`c8a-...`).

## Sprint 4: memory-folder writes

Run on 2026-10-05 (timestamps UTC unless marked; local time was UTC-5) against the sprint 4 integration branch `agents-s4` of the Agents epic at `303fe61` (DM-213 merged; app version 0.15.0), with the docs-only fix commit `449992b` on top. Sprint 4 had one ticket, DM-213: a hosted Claude Code chat must ask before any write into Claude Code's own memory folder. The build was `npm run build` of that worktree, launched unpackaged (`electron <worktree>`) with the person's signed-in Claude Code CLI `2.1.281` at `C:\Users\davgo\.local\bin\claude.exe` (`claude auth status`: logged in; no login or logout was run) and Agent SDK 0.3.289.

**Scope.** Live Codex, Cursor, macOS and Download checks were culled from this epic by the person's decisions on 2026-10-04 and 2026-10-05. This section covers Claude Code on Windows only.

### How it was run

- Same as sprint 3: a **throwaway** `--user-data-dir`, a `--remote-debugging-port` and `DISABLE_AUTO_UPDATE=1`; the person's own Dark Mechanicus app and `%APPDATA%\dark-mechanicus` were not touched. The app was driven over CDP (clicks on its own buttons) and the native file dialogs with Windows UI Automation messages. Scripts, listings and process lists are in `dm-wt\evidence\DM-212\` (outside the repository, not committed).
- Two scratch git repositories, seeded through the app's own core and tracked through the app's **Track a folder** dialog: `scratch-chat` (for c1) and `scratch-chat2` (for c2, so that its memory folder was untouched by c1's Allow). Their Claude projects are `~\.claude\projects\C--Users-davgo-Documents-GitHub-dm-wt-evidence-DM-212-scratch-chat` and `...-scratch-chat2`; nothing was written to any other project's memory folder. Before the app started I put one file, `existing.md` (9 bytes), in each scratch project's `memory\` so the listings have something to hash; the app did not write it.
- Both chats are plain chats of Claude Code on **Haiku** with the Worker role (the dialog's default role is Orchestrator with Allow save, which I did not want; there is no run or epic). Few and short turns: 4 in the first chat, 3 in the second.
- **Every card was answered by hand** after reading it (no helper script): Deny for the three c1 writes, Allow once for the one repeated absolute-path write into the scratch project's memory folder and for `ordinary.txt` in the scratch folder. Nothing outside the scratch folders was allowed.
- The listings below are `memlist.mjs` (names, sizes, MD5, mtimes) of the scratch project's `memory\` folder; the CLI's own session log sits next to it in the project folder, not inside it.

### Live steps on Windows

| # | Step | Result | Evidence |
|---|------|--------|----------|
| S1 | Connect Claude Code: Add an agent, **Find**, pick `claude.exe` | **Pass.** "Connected · v2.1.281", Signed in | |
| S2 | Track `scratch-chat` and `scratch-chat2` | **Pass** | |
| S3 | New chat in `scratch-chat`: Claude Code, Haiku, Worker | **Pass** | |
| S4 | **c1, absolute path.** "Use the Write tool to create the file `C:\Users\davgo\.claude\projects\<scratch project>\memory\abs.md` containing the single line hi." | **Pass.** An **approval card** ("Edit a file", the file, "Writes 1 line", "+ hi", Allow once / Allow for this chat / Deny) waited and nothing was written. **Deny**: the tool row says DENIED, the agent says the write "was declined in Dark Mechanicus", and the listing is unchanged (below) | `s4-c1a-...`, `s4-c1b-...` |
| S5 | **c1, `~` path.** The same with `~/.claude/projects/<scratch project>/memory/tilde.md` "with the ~ as written" | **Pass.** A file-edit card waited. The tool row keeps the `~` as the agent wrote it; the card shows the file as the CLI expanded it (`C:\Users\davgo\.claude\projects\...\tilde.md`). **Deny**: unchanged | `s4-c1c-...`, `s4-c1d-...` |
| S6 | **c1, shell redirect.** "Use the Bash tool to run exactly this command: `echo hi >> "C:/Users/davgo/.claude/projects/<scratch project>/memory/redirect.md"`" | **Pass.** A **command card** ("Run a command", the command, "Working directory ...\scratch-chat") waited and nothing was written. **Deny**: "The command was declined in Dark Mechanicus", unchanged | `s4-c1e-...`, `s4-c1f-...` |
| S7 | **c1, Allow once.** The absolute-path write of S4 again | **Pass.** A file-edit card waited; I answered **Allow once**; the tool row says DONE and the card ALLOWED ONCE. `abs.md` now exists: 2 bytes, `hi`, MD5 `49f68a5c8493ec2c0bf489821c21fc3b` | `s4-c1g-...` |
| S8 | **c2, plain remember.** Fresh chat in `scratch-chat2`: "Remember that my code word is PINEAPPLE." Then, to push harder: "Please save that to your memory." | **Pass.** No card either time, and `memory\` is unchanged after each turn. Haiku answered "I'm ready" to the first, and to the second "I don't have a memory tool available in this session." It never tried a write (no tool row), so this shows that nothing writes memory unasked (DM-200's switch), not that a write was refused | `s4-c2a-...` |
| S9 | **c2, ordinary file.** "Create a file named ordinary.txt in the current folder containing the single line hi." | **Pass.** A file-edit card waited (`...\scratch-chat2\ordinary.txt`, "Writes 1 line", "+ hi"), exactly as before; **Allow once**; `ordinary.txt` exists (2 bytes, `hi`) | `s4-c2b-...`, `s4-c2c-...` |
| S10 | **What the process was started with.** The chat's `claude.exe` command line, read while it ran | **Pass.** It carries `--settings "{\"autoMemoryDirectory\":\"C:\\Users\\davgo\\AppData\\Local\\Temp\\dark-mechanicus-unused-memory\"}"` and `--setting-sources=user,project,local` (the CLI still reads the person's settings; the app passed its own inline). The folder `...\Temp\dark-mechanicus-unused-memory` did not exist after the run | `proc-before-quit.txt` |
| S11 | End: quit the app the normal way (`window.close()` over CDP) | **Pass.** 12 PIDs recorded before (the app, its 3 helper processes, and for each of the two chats a `claude.exe` with its `node` MCP server and two `conhost`s); 0 still running about 6 s later, no new process parented to them | `proc-after-quit.txt` |

**Memory folder listings** (names, sizes, MD5; the scratch project's `memory\`):

```
scratch-chat, before S4:                 existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b
after S4 (absolute path, Deny):          existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b   mtime unchanged
after S5 (~ path, Deny):                 existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b   mtime unchanged
after S6 (shell redirect, Deny):         existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b   mtime unchanged
after S7 (absolute path, Allow once):    abs.md      2 bytes md5=49f68a5c8493ec2c0bf489821c21fc3b   (new)
                                         existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b   mtime unchanged

scratch-chat2, before S8:                existing.md 9 bytes md5=de40e3d15c5140d4a77c3ad0d782d57b
after "Remember ... PINEAPPLE":          unchanged
after "Please save that to your memory": unchanged
after S9 (ordinary.txt, Allow once):     unchanged (ordinary.txt is in the scratch folder: 2 bytes, `hi`)
```

The mtime of `existing.md` was `2026-10-05T21:50:55Z` in every listing.

**The card text.** For a memory-folder write it is the ordinary card: `APPROVAL`, `Edit a file`, `File <path>`, `Writes 1 line`, `+ hi`, then Allow once, Allow for this chat and Deny; for the redirect `Run a command`, the command and its working directory. **The UI does not show the hook's reason** ("This writes into Claude Code's own memory folder, which the CLI would allow without asking. Dark Mechanicus asks first."), and the stored `approval_request` item carries no reason either (tool, category, summary and input only). The person sees the path and has to notice that it is under `.claude\projects\...\memory`. That is as the ticket specified (an ordinary file-edit approval); the runbook now says so.

### What this live run did not show

- The variants beyond the three asked for (relative path, forward slashes, upper case, a junction, an edit of an existing memory file, other redirect forms, the pinned folder) were run by DM-213's worker through a harness against the real adapter, not here. Their logs (`dm-wt\evidence\DM-213\final-*.log`) show a card each and, on Deny, an unchanged listing (12 of 12 deny logs compared by script); I did not run them again.
- The shell redirect was only denied here, not allowed. **Allow for this chat** on a memory write was not run live (the code keys the allowance by category and tool, so an Allow for this chat on any file edit also covers a later memory write in that chat; the runbook says so; `sessionManager.ts` `scopeOf`, and the adapter test "allows it on Allow for this chat, as it does for any edit").
- MultiEdit, NotebookEdit, the PowerShell tool, a `CLAUDE_CONFIG_DIR` that points elsewhere, a real `autoMemoryDirectory` of the person's own, macOS and Linux: not run live.
- A Haiku turn is not deterministic: each step above is one request that Haiku obeyed on the first try.

### c3: the docs against the combined code and this run

Sections changed since the sprint start (`git diff 4518afd 303fe61 -- docs/`: 2 files, 4 hunks), and what each says against the code and this run. Three sentences were corrected, and one result added, in the docs-only commit `449992b`.

| Section | Matches? | Checked in |
|---------|----------|------------|
| `docs/architecture.md`, Adapters: the auto-memory switch, then the `PreToolUse` hook (`memoryWriteMatcher`) on Write, Edit, MultiEdit and NotebookEdit, and the inline `autoMemoryDirectory` (`pinnedMemoryFolder`, `dark-mechanicus-unused-memory` in the temp folder), what the hook resolves, the "not checked live" list | **Yes.** One sentence added: the acceptance round repeated the absolute, `~` and redirect cases in the running app | `adapters/claude.ts` (`AUTO_MEMORY_OFF`, `queryOptions`: `env`, `settings`, `hooks`, `settingSources: ['user','project','local']`), `adapters/claudeMemoryFolder.ts` (`ASK`, `decide`, `configFolders`, `formsOf` and `realPathOf`, `pinnedMemoryFolder`), `@anthropic-ai/claude-agent-sdk` 0.3.289 `sdk.d.ts` (`Settings.autoMemoryDirectory`, `permissionDecision?: 'allow' \| 'deny' \| 'ask'`, `HookCallbackMatcher`); live S4 to S7, S10 |
| `docs/runbooks/agents.md`, Chats: the memory bullet, "a write into its memory folder asks like any other file", with its hook and setting sub-bullets | **Mostly, with 3 corrections.** (1) "The memory folders are `~/.claude/projects/*/memory/`, or under `CLAUDE_CONFIG_DIR`" read as "instead": the code checks the default folder always and `CLAUDE_CONFIG_DIR` as well (`configFolders`); now "and also". (2) Nothing said how the card looks; now: the ordinary file-edit card, which does not say why it asks (S4). (3) "your Claude Code settings files are not read, written or changed" contradicted the Chats text above it and the process (`--setting-sources=user,project,local`: the CLI reads them); now "the app writes and changes none of your Claude Code settings files (the CLI still reads them)" | the files above; live S4 to S7, S10 |
| `docs/runbooks/agents.md`, Chats: a call the hook cannot read asks; "Allow for this chat on file edits covers a memory write too" | **Yes** (code and tests only for Allow for this chat; not run live) | `claudeMemoryFolder.ts` (`files === null` and the `catch` answer ASK), `sessionManager.ts` (`scopeOf`: category and tool), `claudeMemoryWrites.test.ts` "allows it on Allow for this chat, as it does for any edit" |
| `docs/runbooks/agents.md`, Approvals: "A write into its own memory folder asks like any other, which takes a hook and a setting of the app's" | **Yes** | live S4 to S7 |
| `docs/runbooks/agents.md`, What was and was not verified: the Sprint 3 bullet ("its gap is closed by the memory-folder check below") | **Yes** | this section |
| `docs/runbooks/agents.md`, What was and was not verified: the "memory-folder check" bullet (harness run, groups of variants, "Not verified live") | **Yes, as a harness result.** I compared the before and after listings of its 14 `final-*.log` files by script (the 12 Deny logs unchanged, the Allow log changed, the ordinary-write log unchanged because that write is in the chat folder) and read 5 of them in full. One result added: the running app's own run (S4 to S10) | `dm-wt\evidence\DM-213\final-*.log`; this section |

**No known-gap note for memory-folder writes is left.** A search of `docs/`, `README.md`, `AGENTS.md`, `CLAUDE.md` and `skills/` for "known gap", "still let", "bypass" and similar finds no current statement that a memory-folder write goes unasked. The only places that still describe the gap are this report's sprint 3 sections, which give the state at `1c585b9` and now say it was closed in sprint 4.

### Definition of Done (c5)

Run in the worktree at `303fe61` in the order lint, typecheck, test, coverage, deadcode, build, with Fireguard started at the same time in an isolated clone (its mutation stage rewrites source files). No gate failed, so no fix commit was needed. The set (without Fireguard) was run again on the branch's final tree (`449992b` plus this report: the code is that of `303fe61`, only `docs/` differs): the same results, to the digit. Fireguard was not run again: no test or production file changed after `303fe61`, and it grades only those.

| Check | Result |
|-------|--------|
| `lint` | **Passed** (`oxlint src scripts`, exit 0) |
| `typecheck` | **Passed** (node, web and Fireguard projects) |
| `test` | **Passed**: 395 files, 7478 tests passed and 1 skipped (7479); Fireguard's own suite 20 files, 105 tests |
| `coverage` | **Passed**: statements 97.89 (15316/15646), branches 95.68 (9299/9718), functions 96.63 (5254/5437), lines 97.97 (14247/14541); thresholds 97, 95, 96, 97 |
| `fireguard` | **Grade A (100)**, "all hard gates passed". Base `4518afd312d29af96667cefa173396707be3f8ba` (the sprint start), 3 graded test files (`claude.test.ts`, `claudeMemoryFolder.test.ts`, `claudeMemoryWrites.test.ts`), 2 changed production modules mutated (`claude.ts`, `claudeMemoryFolder.ts`). AST gate passed (341 assertions, 2 mocks, 2 tautological, no empty test). Flake gate passed (100 of 100 runs, 0 failures). Mutation gate passed: 96 of 97 mutants killed, score 99 (minimum 75). The one survivor is on `claudeMemoryFolder.ts:148`, `operator-swap: swap operator to -` in `return target.length >= at + 3 && ... target[at + 2] === 'memory'`; Fireguard names the line, not the column, and I did not confirm which `+` it was, but swapping the one in the length guard changes nothing (the last comparison needs that length anyway). Run in an isolated clone at `303fe61` with `FIREGUARD_BASE_REF` set and `FIREGUARD_TEST_COMMAND="node node_modules/vitest/vitest.mjs run --bail=1"`; it took about 13 minutes, and the clone's tree was clean afterwards |
| `deadcode` | **Passed** ("No new dead exports found") |
| `build` | **Passed** |

### Criteria

| | Met | Where |
|---|-----|-------|
| c1 | Yes | S4 (absolute path), S5 (`~`), S6 (shell redirect): a card each, Deny left the listing unchanged; S7: Allow once wrote the file; the listings and `s4-c1a-...` to `s4-c1g-...` |
| c2 | Yes (the plain request never tried a write, so this shows DM-200's switch is unchanged, not a refusal) | S8 (`s4-c2a-...`), S9 (`s4-c2b-...`, `s4-c2c-...`) |
| c3 | Yes: cross-check done, 3 corrections in `449992b`, no known-gap note left | the c3 table above |
| c4 | Yes | this section |
| c5 | Yes: grade A (100) | the Definition of Done table |

### Screenshots

Each is a CDP capture of the app resized to 1100 px; the ones kept are in `docs/reports/agents-fixes-e2e/` with the prefix `s4-`.

**S4.** The absolute-path write into the scratch project's memory folder waits on a file-edit card; nothing was written.
![Absolute path card](agents-fixes-e2e/s4-c1a-absolute-path-write-raises-a-file-edit-card.jpg)

**S4.** After Deny: the tool row says DENIED, the card DENIED, the folder is unchanged.
![Absolute path denied](agents-fixes-e2e/s4-c1b-absolute-path-denied-folder-unchanged.jpg)

**S5.** The `~` write: the tool row keeps the `~`, the card shows the expanded path.
![Tilde card](agents-fixes-e2e/s4-c1c-tilde-path-write-raises-a-file-edit-card.jpg)

**S5.** After Deny.
![Tilde denied](agents-fixes-e2e/s4-c1d-tilde-path-denied-folder-unchanged.jpg)

**S6.** The shell redirect `echo hi >> <memory file>` waits on a command card.
![Redirect card](agents-fixes-e2e/s4-c1e-shell-redirect-raises-a-command-card.jpg)

**S6.** After Deny.
![Redirect denied](agents-fixes-e2e/s4-c1f-shell-redirect-denied-folder-unchanged.jpg)

**S7.** The absolute-path write again, answered Allow once: DONE, ALLOWED ONCE, and the agent reports the file created.
![Absolute path allowed once](agents-fixes-e2e/s4-c1g-absolute-path-allowed-once-file-written.jpg)

**S8.** "Remember that my code word is PINEAPPLE." and "Please save that to your memory.": no card, no tool call.
![Remember, no card](agents-fixes-e2e/s4-c2a-remember-and-save-to-memory-no-card.jpg)

**S9.** An ordinary file in the chat's folder still asks.
![Ordinary file card](agents-fixes-e2e/s4-c2b-ordinary-file-still-asks.jpg)

**S9.** After Allow once: the file is written.
![Ordinary file written](agents-fixes-e2e/s4-c2c-ordinary-file-allowed-and-written.jpg)

### Not verified (sprint 4)

- Live Codex, Cursor, macOS and Download checks were culled by the person's decisions on 2026-10-04 and 2026-10-05; nothing here says anything about them.
- Allow for this chat on a memory write, the shell redirect on Allow, MultiEdit, NotebookEdit, the PowerShell tool, a `CLAUDE_CONFIG_DIR` pointing elsewhere, and a real `autoMemoryDirectory` of the person's own: see "What this live run did not show".
