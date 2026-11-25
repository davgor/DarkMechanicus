# Performance revamp: baseline and integrated results

The DM-959 measurement of what the person sees, measured on the epic start before any revamp change. It covers how long an epic plan, a ticket panel and the Kanban board take to load, both idle and during a sync. It also covers click to paint in the built desktop, write-lock holds by caller, the counters of an unchanged reconcile, and built-CLI agent latency and error codes. Every later ticket in the epic is judged against these numbers. The sprint acceptance node reruns the same matrix on the integrated branch and fills the *Integrated branch* columns and the [Integrated branch run](#integrated-branch-run) section. Until then those cells are empty on purpose. The per-ticket runs below them were measured on intermediate revisions of a shared host, and they are not the integrated result. What was built, and why, is in [`architecture.md`](../architecture.md#repository-owned-persistence) and [decision 0007](../decisions/0007-targeted-reconcile.md).

Raw rows: [`forge-performance-data/revamp-baseline.jsonl`](forge-performance-data/revamp-baseline.jsonl). Every row carries its per-sample data, and one `revamp-identity` row records the build revision. The earlier harness report is [forge-performance.md](forge-performance.md) (DM-904).

## Revision, host and load

- **App behaviour measured:** the epic start `4d3486bb` (v0.83.0, `epic/performance-revamp` after DM-957 merged). The run was built from `2065b5b7` on `work/perf-DM-959`. That revision is `4d3486bb` plus instrumentation and harness code only: the `Db` hold observer (off unless a caller installs one), the pool's slow-operation log line, and `scripts/spike`. No reconcile, export, queue or command behaviour differs from `4d3486bb`. These numbers were measured before the sprint branch (DM-965, DM-966, DM-967) was merged into this branch.
- **Run:** 2026-11-25 04:55:12Z to 05:01:10Z, `npm run build` then `node --import tsx scripts/spike/forge-performance.ts revamp <out.jsonl> <DarkMechanicus member>`, with Electron 42.11.18 and Node 24.19.0 in the app (system Node 24.16.0 for the harness and CLI).
- **Host:** Intel Core Ultra 9 275HX, 24 cores / 24 logical processors, 32 GB RAM, Windows 11 Home 10.0.26300. The fixtures, the Electron profile and the real-store copy were on the system NVMe SSD (WD PC SN5000S 2 TB), under `%LOCALAPPDATA%\Temp`, not OneDrive.
- **Concurrent load:** the host was shared. Six other agent workers ran targeted tests, and the person's desktop app and many agents' `DarkMechanicus.exe` CLI processes were live. Each row records the whole-host CPU busy share sampled every second while it ran, as mean and max in the *CPU busy* columns. Compare an acceptance rerun with these columns as well as with the latencies.
- **One run:** the matrix was run once. An earlier start (at `739a862d`) failed on the 1,000-ticket fixture with no result for it. The cause was a harness defect: the click-to-paint renderer reloads dropped the liveness probe that the next fixture's cold open calls. That was fixed in `2065b5b7` and the matrix then ran once to completion with no failed or timed-out scenario.

## Fixtures

The generated fixtures are repository-mode projects of saved, completed epics (1,000 tickets per epic), each with two revisions, one run, one image attachment and 32 comments per epic, plus 13 Kanban cards. Twelve of those cards are for the CLI agents. Each fixture is opened cold through the production folder picker.

| Tickets | Epics | Revisions | Runs | Images | Comments | Portable bytes | Cold open ms | Main max gap ms | Integrated branch: cold open ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 100 | 1 | 2 | 1 | 1 | 32 | 428,698 | 440.8 | 16.4 | |
| 1,000 | 1 | 2 | 1 | 1 | 32 | 2,756,105 | 605.5 | 22.9 | |
| 10,000 | 10 | 20 | 10 | 10 | 320 | 27,521,251 | 17,801.5 | 22.5 | |

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

| Tickets | Changed reconcile ms | Its write transactions | Its longest hold ms | Command + flush ms | Its write transactions | Integrated branch: changed reconcile transactions / longest hold ms | Integrated branch: flush longest hold ms |
|---:|---:|---:|---:|---:|---:|---|---|
| 100 | 61.2 | 1 | 13.7 | 28.3 | 3 | | |
| 1,000 | 105.6 | 1 | 26.4 | 30.1 | 3 | | |
| 10,000 | 409.4 | 1 | 104.2 | 80.0 | 3 | | |

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

Integrated branch: calls ___, outcomes ___, desktop syncs ___ (failed ___), CPU busy ___. Sync-lane write-lock hold p95 / max ___ ms, acquire max ___ ms.

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

## DM-969: one-pass epic and ticket open

Before and after on the same host and harness, each a full `revamp` matrix with the DarkMechanicus member copied (tracked files plus a read-only `VACUUM INTO` snapshot). Before: `b7e91ec1` (sprint head), 2026-11-25 05:09Z, [`dm969-before.jsonl`](forge-performance-data/dm969-before.jsonl). After: `678d0ee6`, 2026-11-25 05:31Z, [`dm969-after.jsonl`](forge-performance-data/dm969-after.jsonl). The host was shared with other workers, so compare the CPU column too.

An earlier after-run at `678d0ee6` (05:21Z) completed the 100 and 1,000-ticket fixtures and then stopped in the 10,000-ticket *ticket during a sync* scenario with the harness's own `A sync did not import its changed epic state.` Its rows are kept in [`dm969-after-failed-run.jsonl`](forge-performance-data/dm969-after-failed-run.jsonl). That check is on the sync's import, which this ticket does not touch (no reconcile, export or queue change); the cause was not diagnosed here.

### What dominated (measured first)

- **Fixtures:** render. On 10,000 tickets the plan click to paint was 293 ms p50, of which 208 ms was from the last reply to the paint; the 1.1 MB `listTickets` plus plan payload and its rendering, not the owner (54 ms) or the queue (20 ms).
- **Real store copy (134-ticket epic):** a 4.2 MB payload. Per read: `getPlan` saved 1.2 MB (the bundle's tickets), `getTransfer` 1.1 MB (the transfer packet the saved plan builds), `getRun` 0.6 MB, `getCheckpoint` 80 KB. That epic has no draft, so no draft read was in its open; the draft skip saves the draft plan, tickets and validation (another plan-sized transfer) for epics with an unchanged draft.
- **History:** the ticket panel read the epic's whole log in pages; with the `ticketId` filter the store copy's busiest ticket reads 217 of 4,180 events in 0.6 ms through the existing `events_epic (epic_id, seq)` index, so no new index or migration.

### Click to paint (built desktop over CDP, 30 clicks each), p50 / p95 / max ms

| Tickets | View | Before | After | Render before → after (p50) | Owner run before → after (p50) | CPU busy before / after |
|---:|---|---|---|---|---|---|
| 100 | plan | 39.1 / 61.2 / 83.9 | 36.9 / 42 / 86.9 | 22.4 → 22.7 | 13.4 → 11.9 | 31 % / 27 % |
| 100 | ticket | 14 / 19.9 / 23.3 | 10.6 / 17 / 18.3 | 8.4 → 6.7 | 3.8 → 3.3 | 25 % / 14 % |
| 1,000 | plan | 219.6 / 263.1 / 289.9 | 186 / 198.6 / 210.2 | 160 → 148.2 | 41 → 34.7 | 36 % / 39 % |
| 1,000 | ticket | 64.7 / 82.2 / 82.5 | 51.8 / 62.3 / 65 | 49.6 → 41.4 | 10.2 → 7.5 | 32 % / 26 % |
| 10,000 | plan | 292.9 / 402.5 / 542.2 | 183.9 / 197.7 / 200.1 | 207.8 → 141.1 | 54.4 → 34.9 | 57 % / 30 % |
| 10,000 | ticket | 68.2 / 94.3 / 97.5 | 34.6 / 40.1 / 45.5 | 53.6 → 24.3 | 10.9 → 7.7 | 36 % / 20 % |
| real store copy | plan | 301.3 / 371.2 / 372.2 | 256.8 / 275.1 / 300.2 | 100 → 76.4 | 106 → 88 | 35 % / 27 % |
| real store copy | ticket | 43.7 / 55.9 / 59.2 | 31.3 / 40.6 / 44.8 | 27.2 → 17.7 | 13.1 → 11.9 | 23 % / 15 % |

Every row is under 500 ms p95. The plan's queue wait rose on the fixtures (10,000: 19.5 → 34.8 ms p50) because its reads now arrive in the owner together instead of in three rounds; the end-to-end time still fell. The before run's host was busier on the 10,000 rows (57 % mean CPU against 30 %), so part of that row's gain is load, not code.

Renderer view loads on 10,000 tickets (production IPC, p50 / p95 ms): plan idle 88.8 / 114.2 → 54.3 / 61.9, ticket idle 18.1 / 25.4 → 14.5 / 17.9; during a sync plan 633 / 691 → 433 / 485, ticket 478 / 613 → 389 / 429 (sync rows remain dominated by queue wait behind the reconcile, which is other tickets' scope).

Render was the largest share on the fixtures, but no single component hotspot was isolated in this ticket: the plan render fell with the smaller, single-round load, and no component change (step 5) was made.

## Per-ticket harness runs

Each ticket that changed reconcile, export or the read path measured its own branch with the same harness. Those branches were intermediate revisions, measured on the shared host while other workers ran, so these rows show direction only. The acceptance node's integrated run is the result of record. Every number below is copied from the committed rows named in each line. 10,000-ticket fixture unless stated; p95 in ms.

| Ticket, revision | Rows | View load during a sync (plan / ticket / board) | Changed-epic reconcile: write transactions, longest hold | Explicit unchanged reconcile: write transactions, text reads | Flush longest hold | 12 CLI agents for 60 s |
|---|---|---|---|---|---|---|
| Baseline `4d3486bb` (+ DM-959 instrumentation) | [`revamp-baseline.jsonl`](forge-performance-data/revamp-baseline.jsonl) | 484.4 / 465.8 / 442.9 | 1, 104.2 | 1 (held 276.9), 424 | 11.7 | 221 calls, all `ok` |
| DM-964 `d33e5076` (staged export, no sync lane yet) | [`dm964-revamp.jsonl`](forge-performance-data/dm964-revamp.jsonl) | 640.8 / 616.5 / 615.4 | 1, 142.9 | 1 (held 115.8), 402 | 4.9 | 107 calls, all `ok` (CPU 66 %) |
| DM-963 `f27dadd2` (sync lane) | [`revamp-DM-963-at3.jsonl`](forge-performance-data/revamp-DM-963-at3.jsonl) | 73.6 / 19.6 / 15.8 | 1, 118 | 1 (held 303.4), 424 | 12.1 | 115 calls, all `ok`; lane hold max 1,347, acquire max 1,944.9 (CPU 61 %) |
| DM-962 `c0c1ed75` (per-record transactions; includes DM-961, DM-963, DM-964) | [`dm962-revamp.jsonl`](forge-performance-data/dm962-revamp.jsonl) | 48.4 / 16.9 / 9.9 | 2, 33.8 | 0, 400 | 2.6 | 186 calls, all `ok`; lane hold max 56.9, acquire max 25.6 (CPU 62 %) |

- The view loads at `d33e5076` were measured before the sync lane existed. They still queue behind the reconcile in the owner, and they were measured on a busier host than the baseline.
- At `f27dadd2` the lane served the views, but every explicit reconcile prepared again under the writer lock, so the lane's holds grew. DM-962's per-record transactions (re-prepare outside the lock) bring the lane's longest hold to 56.9 ms in the 12-agent stage and 37.3 ms in the view rows.
- In the harness, the explicit unchanged reconcile is a full read. At `c0c1ed75` it still reads every record (400 text bodies) but takes no write transaction.
- **DM-961, built `dm call list_kanban_cards`, 10 calls each** ([`dm961-cli-list-kanban-cards.jsonl`](forge-performance-data/dm961-cli-list-kanban-cards.jsonl), `7a313649`), wall p50 / p95: with the fingerprint gate hit, 298.4 / 312.5 (fixture with an unborn HEAD) and 320.1 / 343 (committed fixture). With the gate missing on every call, a full reconcile on the unborn-HEAD fixture (fallback `unborn_head`) took 2,019.5 / 2,100.8, and a targeted reconcile on the committed fixture took 405.1 / 426. Every call returned `ok`.
- **DM-963 packaged-build probe** ([`sync-lane-probe-DM-963.jsonl`](forge-performance-data/sync-lane-probe-DM-963.jsonl), `3ad59e13`, the packaged app over CDP): during an explicit reconcile, p95 plan 49, ticket 15, board 8 and a card mutation 116. 30 of 30 loads of each finished while the reconcile was still running. Verdict GO.
- **DM-969** is measured in its own section above.

## Integrated branch run

Filled in by the sprint acceptance node from one full `revamp` matrix on the integrated branch, with the real-store copy. Leave a field empty rather than estimate it.

- **Revision measured:** ___ (`revamp-identity` row)
- **Run:** ___ (UTC start and end, app Electron and Node versions)
- **Host and concurrent load:** ___ (as in [Revision, host and load](#revision-host-and-load); compare the CPU busy columns)
- **Raw rows:** ___ (`forge-performance-data/<file>.jsonl`)
- **Failed or timed-out scenarios:** ___ (with their rows; a failure is reported, never rerun away)
- **Epic success criteria:** s1 (plan, ticket and board under 300 ms p95 during a sync, real store) ___; s2 (an unchanged reconcile takes no write lock; a reconcile after a pull reads only git-reported records) ___; s3 (no reconcile or finalizer write transaction over 250 ms on 10,000 tickets) ___; s4 (a CLI read under 2 s; 12 agents during a sync with no `database is locked` and no new codes) ___.

## How to rerun

From a clean worktree of the revision under test: `npm run build`, then `env -u ELECTRON_RUN_AS_NODE node --import tsx scripts/spike/forge-performance.ts revamp <new.jsonl> [<project to copy>]`. Give the project argument only when the harness should copy a real store; it is copied, never opened in place. `DM_REVAMP_SMOKE=1` runs a quick shake-out instead: the 100-ticket fixture with 3 samples and a 10-second agent run. The smoke scale is not a measurement.
