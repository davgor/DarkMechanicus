# Performance revamp: baseline

The DM-959 measurement of what the person sees, measured on the epic start before any revamp change. It covers how long an epic plan, a ticket panel and the Kanban board take to load, both idle and during a sync. It also covers click to paint in the built desktop, write-lock holds by caller, the counters of an unchanged reconcile, and built-CLI agent latency and error codes. Every later ticket in the epic is judged against these numbers. The sprint acceptance node reruns the same matrix on the integrated branch and fills the *Integrated branch* columns.

Raw rows: [`forge-performance-data/revamp-baseline.jsonl`](forge-performance-data/revamp-baseline.jsonl). Every row carries its per-sample data, and one `revamp-identity` row records the build revision. The earlier harness report is [forge-performance.md](forge-performance.md) (DM-904).

## Revision, host and load

- **App behaviour measured:** the epic start `4d3486bb` (v0.83.0, `epic/performance-revamp` after DM-957 merged). The run was built from `2065b5b7` on `work/perf-DM-959`. That revision is `4d3486bb` plus instrumentation and harness code only: the `Db` hold observer (off unless a caller installs one), the pool's slow-operation log line, and `scripts/spike`. No reconcile, export, queue or command behaviour differs from `4d3486bb`. These numbers were measured before the sprint branch (DM-965, DM-966, DM-967) was merged into this branch.
- **Run:** 2026-11-25 04:55:12Z to 05:01:10Z, `npm run build` then `node --import tsx scripts/spike/forge-performance.ts revamp <out.jsonl> <DarkMechanicus member>`, with Electron 42.11.18 and Node 24.19.0 in the app (system Node 24.16.0 for the harness and CLI).
- **Host:** Intel Core Ultra 9 275HX, 24 cores / 24 logical processors, 32 GB RAM, Windows 11 Home 10.0.26300. The fixtures, the Electron profile and the real-store copy were on the system NVMe SSD (WD PC SN5000S 2 TB), under `%LOCALAPPDATA%\Temp`, not OneDrive.
- **Concurrent load:** the host was shared. Six other agent workers ran targeted tests, and the person's desktop app and many agents' `DarkMechanicus.exe` CLI processes were live. Each row records the whole-host CPU busy share sampled every second while it ran, as mean and max in the *CPU busy* columns. Compare an acceptance rerun with these columns as well as with the latencies.
- **One run:** the matrix was run once. An earlier start (at `739a862d`) failed on the 1,000-ticket fixture with no result for it. The cause was a harness defect: the click-to-paint renderer reloads dropped the liveness probe that the next fixture's cold open calls. That was fixed in `2065b5b7` and the matrix then ran once to completion with no failed or timed-out scenario.

## Fixtures

The generated fixtures are repository-mode projects of saved, completed epics (1,000 tickets per epic), each with two revisions, one run, one image attachment and 32 comments per epic, plus 13 Kanban cards. Twelve of those cards are for the CLI agents. Each fixture is opened cold through the production folder picker.

| Tickets | Epics | Revisions | Runs | Images | Comments | Portable bytes | Cold open ms | Main max gap ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 2 | 1 | 1 | 32 | 428,698 | 440.8 | 16.4 |
| 1,000 | 1 | 2 | 1 | 1 | 32 | 2,756,105 | 605.5 | 22.9 |
| 10,000 | 10 | 20 | 10 | 10 | 320 | 27,521,251 | 17,801.5 | 22.5 |

**Real store copy.** The DarkMechanicus member's tracked `.darkmechanicus` files (without `local/`), plus a read-only `VACUUM INTO` snapshot of its database, were copied into the temporary fixture. The live store was never opened for writing. The copy has 31 epics, and its first command after tracking answered in 256.1 ms. Click to paint used its largest saved epic (134 tickets).

## Results

### Plan view, ticket panel and Kanban board (production IPC, 30 samples each)

p50 / p95 / max in ms. End to end is the renderer's whole load sequence; queue wait and owner run come from the main-process taps over the same window. During a sync, each sample starts a renderer reconcile of one changed epic state plus the desktop's 15-second heartbeat, then loads the view.

| Tickets | View | Condition | End to end (baseline) | Queue wait | Owner run | Payload bytes (p50) | Sync duration | CPU busy | Integrated branch: end to end |
|---:|---|---|---|---|---|---:|---|---|---|
| 100 | plan | idle | 14 / 16.8 / 21 | 4.2 / 5.2 / 5.9 | 14.6 / 17.5 / 18.4 | 141,505 | – | 17 % (max 17 %) | |
| 100 | ticket | idle | 5.5 / 6.8 / 9.5 | 3.1 / 3.6 / 3.9 | 5.1 / 6.1 / 7.8 | 2,043 | – | 0 % (max 0 %) | |
| 100 | kanban | idle | 4.9 / 5.5 / 6 | 2.7 / 5.1 / 5.5 | 4.7 / 8.7 / 9 | 2,844 | – | 0 % (max 0 %) | |
| 100 | plan | sync | 60 / 70.9 / 71.5 | 50.4 / 60.8 / 61.1 | 11.8 / 13.8 / 13.8 | 122,764 | 74.3 / 84.2 / 85.7 | 10.5 % (max 11.4 %) | |
| 100 | ticket | sync | 57.7 / 71.4 / 90.1 | 105.2 / 134.9 / 169.7 | 5.6 / 8.5 / 8.7 | 2,043 | 70.5 / 78.6 / 103.3 | 10.4 % (max 10.7 %) | |
| 100 | kanban | sync | 56.6 / 66.2 / 75.3 | 99.7 / 123.1 / 139 | 4.7 / 8.3 / 10.4 | 2,844 | 69.4 / 80.8 / 85.6 | 10.7 % (max 11.9 %) | |
| 1,000 | plan | idle | 45.4 / 52.4 / 59.3 | 13.5 / 18.7 / 28.4 | 33.4 / 38.2 / 43.8 | 1,127,186 | – | 14.5 % (max 15.7 %) | |
| 1,000 | ticket | idle | 9.2 / 11.4 / 11.7 | 6.6 / 7.7 / 8.6 | 8.7 / 9.8 / 10.7 | 2,043 | – | 0 % (max 0 %) | |
| 1,000 | kanban | idle | 4.9 / 5.5 / 6 | 4.6 / 5.2 / 5.3 | 6.1 / 8.8 / 9.2 | 2,862 | – | 0 % (max 0 %) | |
| 1,000 | plan | sync | 115 / 151.1 / 153.9 | 79.3 / 114.8 / 116.7 | 32.9 / 42.7 / 43.2 | 1,127,186 | 126.7 / 165.3 / 173.3 | 15.9 % (max 18.1 %) | |
| 1,000 | ticket | sync | 77.9 / 99.8 / 112 | 142 / 182.7 / 210.1 | 9.9 / 13.6 / 13.8 | 2,043 | 90.4 / 114.4 / 123.7 | 15.8 % (max 17.5 %) | |
| 1,000 | kanban | sync | 69.4 / 94.2 / 111.5 | 129.7 / 181.1 / 210.6 | 4.8 / 8 / 8.1 | 2,844 | 83 / 105.4 / 125.1 | 13.1 % (max 15.5 %) | |
| 10,000 | plan | idle | 62.7 / 72.1 / 77.6 | 14.9 / 17.8 / 17.9 | 39.8 / 48.3 / 48.5 | 1,127,186 | – | 14.4 % (max 14.8 %) | |
| 10,000 | ticket | idle | 14.2 / 20.1 / 21.3 | 8 / 10.1 / 12.1 | 10.3 / 14.9 / 15.6 | 2,043 | – | 15.7 % (max 15.7 %) | |
| 10,000 | kanban | idle | 9.7 / 12.4 / 12.6 | 3.2 / 4.7 / 7.3 | 5.5 / 7.5 / 8.8 | 2,844 | – | 0 % (max 0 %) | |
| 10,000 | plan | sync | 394.9 / 484.4 / 502.5 | 343.3 / 437.6 / 456 | 38.4 / 48.9 / 51.1 | 1,127,186 | 406.2 / 498.1 / 524.8 | 17.1 % (max 24.8 %) | |
| 10,000 | ticket | sync | 397.6 / 465.8 / 490.9 | 770.7 / 906.2 / 950.3 | 12.8 / 16.9 / 17.4 | 2,043 | 419.4 / 488.2 / 503.6 | 22.3 % (max 28.3 %) | |
| 10,000 | kanban | sync | 362.5 / 442.9 / 469.4 | 712.6 / 862.7 / 916.9 | 6.1 / 8.1 / 8.3 | 2,844 | 382.7 / 455.4 / 480.8 | 19.2 % (max 24.4 %) | |

### Click to paint (built desktop over CDP, 30 clicks each)

Plan: a cold epic open (renderer reloaded so its view cache is empty), clicked in the sidebar, until a ticket node of the graph is painted. Ticket: a ticket node clicked in the open graph, until the ticket panel title is painted. Render is from the last reply's arrival in main to the paint, so it includes the IPC hop back to the renderer.

| Tickets | View | Click to paint (baseline) | Queue wait | Owner run (incl. identity checks) | Payload bytes (p50) | Render | CPU busy | Integrated branch: click to paint |
|---:|---|---|---|---|---:|---|---|---|
| 100 | plan | 37.2 / 47.3 / 96 | 4.5 / 6.9 / 7.9 | 13 / 17.6 / 19.6 | 122,765 | 20.5 / 26.8 / 69.4 | 17.2 % (max 21.8 %) | |
| 100 | ticket | 11.1 / 18.8 / 19.1 | 0.3 / 0.5 / 0.5 | 3.5 / 5.6 / 5.7 | 1,731 | 6.5 / 13.4 / 14.4 | 8.6 % (max 11.5 %) | |
| 1,000 | plan | 167.7 / 209.5 / 224.8 | 13.4 / 17.8 / 50.5 | 33.9 / 40.1 / 43.3 | 1,127,187 | 121.8 / 154.3 / 159.1 | 17.3 % (max 23.4 %) | |
| 1,000 | ticket | 47.4 / 61.8 / 66.3 | 0.4 / 0.7 / 0.7 | 7.7 / 10.7 / 10.9 | 1,138 | 36.4 / 48.1 / 54.1 | 11.3 % (max 16.7 %) | |
| 10,000 | plan | 191.6 / 296.9 / 310.2 | 14.5 / 20.4 / 50.7 | 37.8 / 53.1 / 80.9 | 1,127,187 | 140.6 / 212.8 / 221.9 | 28.4 % (max 64 %) | |
| 10,000 | ticket | 47.1 / 64.6 / 70.3 | 0.4 / 0.7 / 0.7 | 8.7 / 11.6 / 13.8 | 1,138 | 37 / 52.3 / 56.2 | 16.8 % (max 29.5 %) | |
| real store copy | plan | 253.4 / 282.7 / 285.4 | 52.3 / 67.3 / 71.4 | 92.9 / 109.1 / 111.4 | 4,170,045 | 77.2 / 105.3 / 118 | 19.5 % (max 36.4 %) | |
| real store copy | ticket | 32.2 / 40.4 / 44.4 | 0.4 / 0.7 / 0.7 | 12.4 / 17.9 / 18.5 | 11,745 | 15.8 / 24.7 / 25.2 | 9 % (max 11.5 %) | |

### Write-lock holds by caller (BEGIN IMMEDIATE to COMMIT/ROLLBACK)

From a profiler utility with the `Db` hold observer: open, an automatic heartbeat, an explicit unchanged reconcile, a reconcile of one changed epic state, then a command with its flush. `untagged` is a depth-0 write outside `reconcile()`, `flush()` and command execution (session touch and open bookkeeping).

| Tickets | Caller | Transactions | Rollbacks | Hold p50 / p95 / max ms | Acquire max ms | Integrated branch: hold max |
|---:|---|---:|---:|---|---:|---|
| 100 | untagged | 2 | 0 | 0.5 / 2.7 / 2.7 | 0 | |
| 100 | reconcile | 2 | 0 | 13.7 / 15.1 / 15.1 | 0 | |
| 100 | command | 1 | 0 | 3.4 / 3.4 / 3.4 | 0 | |
| 100 | flush | 2 | 0 | 10.5 / 11.7 / 11.7 | 0 | |
| 1,000 | untagged | 2 | 0 | 0.7 / 1.8 / 1.8 | 0 | |
| 1,000 | reconcile | 2 | 0 | 14.2 / 26.4 / 26.4 | 0 | |
| 1,000 | command | 1 | 0 | 7.1 / 7.1 / 7.1 | 0 | |
| 1,000 | flush | 2 | 0 | 9.1 / 11.7 / 11.7 | 0 | |
| 10,000 | untagged | 2 | 0 | 0.6 / 1.1 / 1.1 | 0 | |
| 10,000 | reconcile | 2 | 0 | 104.2 / 276.9 / 276.9 | 0 | |
| 10,000 | command | 1 | 0 | 55.2 / 55.2 / 55.2 | 0 | |
| 10,000 | flush | 2 | 0 | 10.6 / 11.7 / 11.7 | 0 | |

Changed-epic reconcile (the sync's import) and the command with its flush, per fixture:

| Tickets | Changed reconcile ms | Its write transactions | Its longest hold ms | Command + flush ms | Its write transactions |
|---:|---:|---:|---:|---:|---:|
| 100 | 61.2 | 1 | 13.7 | 28.3 | 3 |
| 1,000 | 105.6 | 1 | 26.4 | 30.1 | 3 |
| 10,000 | 409.4 | 1 | 104.2 | 80.0 | 3 |

### Unchanged reconcile counters (warm, no changes)

| Tickets | Case | Elapsed ms | Text body reads | Binary body reads | Stamps | Realpaths | Stat calls | Write transactions | Integrated branch: reads / stats / writes |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 100 | automatic heartbeat | 5.1 | 3 | 0 | 101 | 1 | 264 | 1 | |
| 100 | explicit reconcile | 146.0 | 69 | 1 | 421 | 1429 | 3853 | 1 | |
| 1,000 | automatic heartbeat | 7.2 | 3 | 0 | 101 | 1 | 264 | 1 | |
| 1,000 | explicit reconcile | 182.4 | 69 | 1 | 421 | 1429 | 3853 | 1 | |
| 10,000 | automatic heartbeat | 21.6 | 3 | 0 | 497 | 1 | 750 | 1 | |
| 10,000 | explicit reconcile | 1,514.1 | 424 | 10 | 2479 | 9874 | 23899 | 1 | |

### Built CLI wall time (10,000-ticket fixture, no tracked changes, 10 calls each)

| Command | Wall p50 / p95 / max ms | Outcomes | CPU busy | Integrated branch: wall |
|---|---|---|---|---|
| `dm call list_kanban_cards` | 237.8 / 1,454.7 / 1,454.7 | ok 10 | 26.9 % (max 28.9 %) | |
| `dm call get_epic` | 247.9 / 275.4 / 275.4 | ok 10 | 29.9 % (max 30 %) | |

### 12 built-CLI agents for 60 s while the desktop syncs (10,000 tickets)

221 calls in total. Outcomes: `ok` 221. Desktop syncs during the run: 17, p50 / p95 / max 3,209 / 6,947.2 / 6,947.2 ms; failed syncs: none. CPU busy 45.9 % (max 79.8 %).

| Command | Outcomes by code | Wall p50 / p95 / max ms | Integrated branch: outcomes / wall |
|---|---|---|---|
| `list_kanban_cards` | `ok` 56 | 3,481.1 / 6,502 / 8,113.6 | |
| `get_ticket` | `ok` 55 | 4,016.3 / 6,986.2 / 11,867.3 | |
| `heartbeat_kanban_card` | `ok` 55 | 3,907.7 / 6,817 / 8,092.4 | |
| `add_comment` | `ok` 55 | 3,977.6 / 7,985 / 12,694.6 | |

## What the baseline shows

- **A sync stalls every view on the 10,000-ticket fixture.** Idle, the plan view loads in 63 ms p50, the ticket panel in 14 ms and the board in 10 ms. While one changed epic state is imported, all three take 360 to 400 ms p50 and up to about 500 ms. Almost all of that is queue wait behind the reconcile in the one owner. Owner run time hardly changes.
- **Reconcile holds the write lock for one long transaction.** On the 10,000 fixture, the changed-epic import held it for 104 ms. The explicit reconcile with nothing changed held it longer, for 277 ms, because its unchanged-record checks run inside the transaction.
- **An explicit unchanged reconcile reads everything again.** On 10,000 tickets it takes 1.5 s, with 424 text body reads, 10 binary reads, 9,874 realpaths and 23,899 stat calls. The automatic heartbeat is gated by DM-957's fingerprint and costs 22 ms.
- **CLI agents are slow even with no errors.** A lone built `dm call` takes about 240 ms. Twelve looping agents during a sync complete only 221 calls in 60 s, about 3.5 to 4 s p50 per call and up to 12.7 s. Every call returned `ok`, with no `busy` and no `internal` codes.
- **Click to paint is under 0.3 s.** On the fixtures the plan open is dominated by the 1.1 MB `listTickets` payload and its rendering. On the real store copy the plan payload is 4.2 MB, and the owner run accounts for 93 ms of the 253 ms p50.

## How to rerun

From a clean worktree of the revision under test: `npm run build`, then `env -u ELECTRON_RUN_AS_NODE node --import tsx scripts/spike/forge-performance.ts revamp <new.jsonl> [<project to copy>]`. Give the project argument only when the harness should copy a real store; it is copied, never opened in place. `DM_REVAMP_SMOKE=1` runs a quick shake-out instead: the 100-ticket fixture with 3 samples and a 10-second agent run. The smoke scale is not a measurement.
