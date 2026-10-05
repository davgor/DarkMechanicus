# Live activity end-to-end check: Claude Code on Windows

Run on 2026-10-05 (timestamps below are UTC) against the sprint 2 integration branch `agents-s2` of the Agents epic at commit `523d96d` (app version 0.15.0). The build was `npm run build` of that worktree, launched unpackaged (`electron <worktree>`) with the person's own signed-in Claude Code CLI `2.1.281` at `C:\Users\davgo\.local\bin\claude.exe`.

**Scope.** macOS, and live Codex and Cursor, were culled from this epic by the person. This report covers Claude Code on Windows only. Codex and Cursor are covered by their adapter tests and `docs/runbooks/agents.md` (criterion c7 below); nothing here says anything about them running live, or about macOS.

## How it was run

- The app was started with a **throwaway** `--user-data-dir`, a `--remote-debugging-port` and `DISABLE_AUTO_UPDATE=1`. The person's own Dark Mechanicus app and its `%APPDATA%` data were not touched, and only processes this run started were stopped.
- Three scratch git repositories sit outside this repository: `scratch-a` (epic **External host run**, for part A), `scratch-b` and `scratch-c` (orchestrated by a Claude Code chat, part B). Each epic has two trivial tickets ("Create a.txt containing hello", "Create b.txt containing world"; scratch-c: c.txt/foo, d.txt/bar) plus the sprint acceptance ticket the plan adds by itself. The epics were created through the app's own core library (a seed script), and every call below went to the scratch repository's own MCP server or to the app's own command path, never to this repository's records.
- The app was driven over the Chrome DevTools Protocol (clicks, typing, `window.dm` calls from the page). Native dialogs (Find, Track a folder) were driven with Windows UI Automation window messages. Screenshots are CDP page captures resized to 1100 px wide, in `docs/reports/live-activity-e2e/` (file names are given in the tables below).
- Part A: a script played an **external orchestrator and a worker** over the scratch repo's MCP server (`out/main/mcp.js`, built from this worktree, one stdio server per role) while the app showed the run.
- Part B: a real Claude Code (Sonnet) ran the epics in orchestrator chats started with **Start run, Run with agent**. Every approval card was answered under a fixed policy: Dark Mechanicus tool calls and plain tools allowed (Allow for this chat), file writes and harmless commands inside the scratch repo allowed once, anything naming a path outside the scratch repo denied. Of 56 approval requests in the two chats none named a path outside the scratch repos.
- Live agent work was kept small: two chats, two trivial tickets each (plus the acceptance ticket in the first). Both runs were cancelled when the evidence was captured; the first had reached its checkpoint and was never approved.

## Part A: an external agent host drives a run

| # | Step | Result | Evidence |
|---|------|--------|----------|
| A1 | Open the scratch folder in the app; the epic shows with **Start run** | **Pass** | |
| A2 | The script (orchestrator role) calls `start_run`; the **orchestrator chip** appears in the run bar before any claim | **Pass.** Chip text "External orchestrator (script)" | `a1-orchestrator-chip-in-run-bar.jpg` |
| A3 | `claim_ticket` (EX-2) and a first heartbeat with a progress note: an **hourglass** appears on the working node in the graph | **Pass.** Graph: "EX-2 is being worked on" | `a2-hourglass-in-graph.jpg` |
| A4 | The same ticket in the **list** view | **Pass.** EX-2 row has the hourglass, EX-3 and EX-1 do not | `a3-hourglass-in-list.jpg` |
| A5 | The orchestrator chip opens the **live feed** (Run started, Claimed EX-2 with model, effort and rationale) | **Pass** | `a5-orchestrator-feed-live.jpg` |
| A6 | The hourglass opens the **Activity tab**: claim, "Working since", the first note | **Pass** | `a4-activity-tab-updating-masked-notes.jpg` (later state) |
| A7 | Three more notes arrive: **the Activity tab updates without a reload** (a marker set on `window` before survived) | **Pass** | `a4-activity-tab-updating-masked-notes.jpg` |
| A8 | One note holds the claim token the attempt was issued, another a made-up token of the same shape: shown **masked** in the tab (neither secret appears in the page text) | **Pass.** Both read "[claim token masked]" | `a4-activity-tab-updating-masked-notes.jpg` |
| A9 | `submit_attempt` by the worker, `accept_attempt` by the orchestrator; the tab says "Attempt ended: Accepted" | **Pass** | |
| A10 | Second ticket (EX-3): claim, two notes, submit, accept. The feed shows the new claim, the earlier accept and submit, **without a reload** | **Pass** | `a6-orchestrator-feed-second-claim.jpg` |
| A11 | `cancel_run`: the **chip leaves the run bar** and the run says canceled | **Pass** | `a7-chip-gone-after-run-ended.jpg` |

### c1: the note rows are masked, and the exported history holds no notes

Rows of `attempt.progress` in the scratch database (`.darkmechanicus/local/state.sqlite`, table `events`), read after the run:

| seq | note as stored |
|-----|----------------|
| 11 | Read the ticket: create a.txt containing hello |
| 12 | Writing a.txt. Pasted by mistake while debugging: `[claim token masked]` (the token the attempt was issued) |
| 13 | Another stray token in a note: `[claim token masked]` (not issued by anyone) (a made-up token of the same shape) |
| 14 | a.txt written and checked |
| 21, 22 | the second attempt's two notes |

- No event payload holds either secret, and no event payload holds a string of the shape `at_` + 26 ids + `.` + 16 or more secret characters.
- The issued secret exists in the scratch repo only in the `attempts` table (column `claim_secret`, in the database file and its WAL), where the server keeps it to check heartbeats. That column is from the original schema, is not a note, and is not exported.
- After `cancel_run`, the exported history `.darkmechanicus/history/rn_01m46cfxmwbn316fvpfgbsptfw/run.json` (state `canceled`, 2 accepted attempts) holds none of the note texts, no `attempt.progress`, no token or secret. A byte search of every file of the scratch repo (11 files, the database and its WAL included) found no token-shaped string (`at_` + 26 ids + `.` + 16 or more secret characters) anywhere; the only hit for the issued secret is the `claim_secret` row in the WAL, as above. The made-up token's secret was found nowhere.

### c2: attempt and run timelines through the desktop command path

Called from the page with `window.dm.command(folder, 'getAttemptTimeline' | 'getRunTimeline', ...)` while the run was live. EX-2's attempt timeline:

| Poll | `sinceSeq` | cursor returned | Entries |
|------|-----------|-----------------|---------|
| 1 (after claim and one note) | none | 11 | `claim` (event 9), `alive` span, `note` (11) |
| 2 (after three more notes, submit, accept) | 11 | 17 | `alive` span again (same id, longer `until`), `note` 12, 13, 14, `submitted` 15, `decision` 17 |

- **Pass.** The full attempt timeline lists claim, notes, submission and review in time order; the second poll returned only entries newer than the cursor, plus the alive span, which the design re-sends with the same id on any page that follows a change (`docs/architecture.md`).
- The **run timeline** lists, by session and oldest first, `run started`, `claim` (EX-2), `submitted`, `decision accepted`, `claim` (EX-3), `submitted`, `decision accepted` (cursor 25, 7 entries in 2 groups: the orchestrator's and the worker's). A poll taken right after the second claim returned cursor 19; polling again with that cursor after the second ticket was accepted returned only the second `submitted` (event 23) and `decision` (event 25).
- **Caveat on the wording of c2.** The run timeline carries claims, submissions and reviews but **not notes**: by design, "notes and heartbeats stay in the attempt timeline" (`docs/architecture.md`). Notes are in the attempt timeline only.

## Part B: an orchestrator chat runs the epic

### Chat 1 (`scratch-b`, epic "Claude orchestrated run")

| # | Step | Result | Evidence |
|---|------|--------|----------|
| B1 | **Find** the Claude Code install (file dialog pointed at `claude.exe`) | **Pass.** "Connected · v2.1.281", Signed in | |
| B2 | **Track a folder**: `scratch-b` | **Pass** | |
| B3 | Epic page, **Start run**, **Run with agent**: Claude Code, Sonnet | **Pass.** Run queued, chat "Orchestrator · Claude orchestrated run" created and kicked off; the run bar links the chat | |
| B4 | The kickoff's step 2 ("load the darkmechanicus-orchestrator prompt") | **Cannot be done by a Claude Code chat** (known, a sprint 3 fix). It tried `Skill` and `ToolSearch` for about a minute (16:00:01 to 16:00:58), said it found no way to load a prompt, and carried on | |
| B5 | The orchestrator starts **a worker subagent per ticket** | **Yes, but without the execution packet.** It claimed CL-2 and CL-3, started two `Agent` subagents in parallel whose prompts hold the task and the repo path only (no attempt id, no claim token), then **submitted and accepted both attempts itself** after checking the files. The workers never called `heartbeat_attempt` or `submit_attempt` | `b1-chat-two-subagent-threads.jpg` |
| B6 | Two subagent threads under their spawning calls; collapsible; Dark Mechanicus action markers ("claimed CL-2", "submitted CL-2", "accepted CL-3", ...) | **Pass** (c6, c10) | `b1-chat-two-subagent-threads.jpg`, `b2-chat-threads-collapsed-with-markers.jpg` |
| B7 | Click a marker ("accepted CL-2"): its **ticket** opens on the Activity tab | **Pass** (c10) | `b3-marker-opens-ticket.jpg` |
| B8 | I pressed **Stop**, then told the chat: for the acceptance ticket CL-1, start the worker with the whole execution packet and have it heartbeat and submit itself (a message from me; the orchestrator would not do this on its own, see B5). It did: one worker subagent with the packet sent a heartbeat note and called `submit_attempt` itself | **Pass**, as a prompted step | `b5-activity-tab-worker-thread-items.jpg` |
| B9 | The CL-1 worker's thread shows its ticket link "CL-1 Activity"; the CL-1 **Activity tab holds the worker subagent's items** (its tool calls, the heartbeat approval and note, the submit) merged with the attempt's claim, note, submission and review | **Pass** (c9, after the worker had finished) | `b5-activity-tab-worker-thread-items.jpg` |
| B10 | The tab's **Open chat** lands on the chat with that thread expanded and the others collapsed (checked after a reload: a plain open of the chat shows all three collapsed) | **Pass** (c9) | `b6-open-chat-thread-expanded.jpg` |
| B11 | **Quit and reopen the app** (same user data): the chat opens with its three subagent threads under their calls, the ticket link still on the bound one | **Pass** (c6) | `b4-threads-after-app-restart.jpg` |
| B12 | The orchestrator filed the sprint report and the run stood at **Awaiting checkpoint**; I did not approve it and cancelled the run | | |

### Chat 2 (`scratch-c`, epic "Live worker stream run")

The second sample exists to watch a bound worker live and to get workers that carry their packets from the start. **Start run, Run with agent** (Sonnet) as before; an in-page helper answered approval cards under the same policy and, right after `start_run` completed, stopped the kickoff turn and sent the chat the instruction that B8 gave (packet in each worker's prompt, workers heartbeat and submit themselves, skip the acceptance ticket).

| # | Step | Result | Evidence |
|---|------|--------|----------|
| C1 | Orchestrator claims LV-2 and LV-3 and starts two workers in the background, each with its full packet | **Pass** | `b8-second-chat-threads-bound-to-tickets.jpg` |
| C2 | Both threads show a ticket link ("LV-2 Activity", "LV-3 Activity") | **Pass** (c8) | `b8-second-chat-threads-bound-to-tickets.jpg` |
| C3 | The workers' file writes were **denied by my approval helper by mistake** (its path check mishandled doubled backslashes, so it failed closed on writes inside the scratch repo). Both workers reported `fail_attempt` (attempt 1 failed). I fixed the helper, told the chat, the orchestrator claimed both tickets again (attempt 2) and re-sent the workers their new tokens, they wrote the files, sent notes and submitted, and the orchestrator accepted both | **Pass**, with the retry (6 denied requests, all inside the scratch repo, all mine) | |
| C4 | While attempt 2 of LV-2 ran, its **Activity tab streamed the worker subagent's items** ("Updating live", the heartbeat approval, the note "Write policy fixed; created c.txt ...") | **Pass** (c9, live) | `b7-activity-tab-live-worker-stream.jpg` |
| C5 | Both runs cancelled in the app (confirm dialog); the chip is gone | **Pass** | |

## c8: what is bound, and the token search

`userData\agents\activity-bindings.jsonl` after both chats (14 lines): for each run, the **main thread bound to the run** as orchestrator (and, because it called `claim_ticket`, to each attempt it claimed, as orchestrator); each worker subagent thread that was given its packet **bound to its attempt as worker**:

- Chat 1: run `rn_01m46cmw1e8m1yphfxy4d6xqjr` (main thread); attempts of CL-2, CL-3 and CL-1 (main thread); the CL-1 worker thread bound to its attempt. **The CL-2 and CL-3 worker threads are bound to nothing**, because the orchestrator did not put the attempt id or token in their prompts (B5).
- Chat 2: run `rn_01m46defhystwwtq5vw7y6jkhf` (main thread); the main thread bound to all four attempts (two failed, two accepted); each of the two worker threads bound to both of its attempts (the same subagent took the retry).

**Search.** The claim tokens of all 7 attempts issued in the two runs were read from the scratch databases and searched for, in full, by secret, and by the first and last 12 characters of the secret, in: the bindings file (1 file), every chat JSONL (4 files), and the whole throwaway user-data directory (55 files). Result: **none found**, and no token-shaped string (`at_` + 26 ids + `.` + 16 or more secret characters) in any of them. The chat store holds 40 "[claim token masked]" markers where tokens passed through. Script and output: not committed (they print counts only); the command is `searchTokens.mjs` in the evidence folder.

## c5 and c7: the non-live checks

- **c5.** The MCP server's `darkmechanicus-worker` prompt says to send, with each heartbeat, a `progress` note "(at most 280 characters)" and "Never include the claim token or any other secret"; the `darkmechanicus-orchestrator` prompt says to relay a worker's status as a `progress` note "(at most 280 characters)" and "Never put the claim token or any other secret in a note". `get_capabilities` serves `skillsVersion` **1.5.1**, and `src/core/version.ts` changed from `1.5.0` to `1.5.1` in this sprint.
- **c7.** `docs/runbooks/agents.md` ("Subagents in a chat") says Codex shows subagent threads (from the Codex source, not run against a real Codex) and Cursor keeps **one thread** (the subagent task is shown as the tool call it is). `codexSubagents.test.ts` (threads from multi-agent v1 and v2, nested, resumed) and `cursorSubagents.test.ts` ("keeps one thread") pass: 172 tests across them and the Claude adapter's.

## Definition of Done on `523d96d`

Run in the worktree, in this order. No gate failed, so no fix commit was needed.

| Check | Result |
|-------|--------|
| `lint` | Passed (`oxlint src scripts`, exit 0) |
| `typecheck` | Passed (node, web and Fireguard projects) |
| `test` | Passed: 377 files, 7013 tests passed and 1 skipped; Fireguard's own suite 20 files, 105 tests |
| `coverage` | Passed: statements 97.84, branches 95.55, functions 96.57, lines 97.94 (thresholds 97, 95, 96, 97) |
| `fireguard` | **Grade A (92)**, "all hard gates passed". Base `417a1543c20a2583e60d1e71d59a1055e29c08c4`, 58 graded test files, 82 changed production modules. AST gate passed (2552 assertions, 2 mocks, 2 tautological). Flake gate passed (100 of 100 runs, 0 failures). Mutation gate passed: 1091 of 1388 mutants killed, score 79 (minimum 75). Run in an isolated clone with `FIREGUARD_TEST_COMMAND="node node_modules/vitest/vitest.mjs run --bail=1"`; the run took about 75 minutes |
| `deadcode` | Passed ("No new dead exports found") |
| `build` | Passed |

## Things the run showed beyond the criteria

1. **The sprint's live features depend on the orchestrator following the orchestrator skill.** Without it (the kickoff cannot load it), the orchestrator wrote worker prompts with no packet: those workers never heartbeat (no notes, no hourglass-level detail beyond the claim), and their threads are not bound to their attempts, so their Activity tabs show no thread items. The bindings and the live stream worked as soon as a prompt carried the packet. This is the sprint 3 kickoff fix's job; it is listed here because it decides whether c8 and c9 hold in an ordinary run.
2. **A thread that serves a retry shows its earlier rows in the later attempt.** LV-2's attempt 2 Activity tab starts with the worker thread's rows from 11:14 and 11:15 (the denied writes of attempt 1) although attempt 2 was claimed at 11:16, because the whole bound thread is merged by time, not clipped to the attempt (`b9-retried-attempt-activity-earlier-rows.jpg`).
3. **"Allow for this chat" covers one tool name**, so each Dark Mechanicus tool raised a card the first time in each chat (15 and 10 cards in the two chats; later calls of the same tool were answered automatically).
4. **Stop** cancels the cards that were waiting; answering one afterwards returns "no longer waiting for an answer", which my helper counted as errors but is harmless.

## Not verified

- Codex, Cursor and macOS (culled); Download of a CLI (not run).
- A bound worker's Activity tab streaming **in chat 1** (the CL-1 worker had finished by the time I opened the tab; the live stream was captured in chat 2 instead).
- That the orchestrator uses the packet **on its own**: both samples needed my instruction in chat (B8, chat 2).
- The checkpoint approval (left unapproved; both runs cancelled).
