# 0007 — Git-targeted, lock-light reconcile on SQLite

- **Status:** accepted
- **Date:** 2026-11-25

## Context

Plans, tickets and the Kanban board in the desktop app were slow to open on a large ticket store, worst during a Forge
World pull. Agents working through the `dm` CLI piled up behind the same work.

**Measured on 2026-11-24** against the DarkMechanicus ticket store (4,683 tracked files, a 133 MB `state.sqlite`, on
OneDrive; from the epic's intent):

- The reads themselves were cheap. The largest plan bundle is 1.21 MB and parses in 2.1 ms. The per-epic bundle query
  over all revisions takes 25.7 ms.
- The time went into waiting. Each project's Workspace ran in one utility process that served one job at a time, first
  in, first out. Reconcile shared that queue: the Forge sync's member reconcile, and a heartbeat every 15 s. Every
  `getEpic`, `getPlan`, `listTickets`, `getTicket` and `listKanbanCards` waited behind it.
- Every reconcile walked every tracked record. The in-memory hash cache holds 4,096 entries, fewer than the store's
  4,683 files, so it kept evicting. Under `BEGIN IMMEDIATE` the importer re-checked every observation, scanned
  observation folders, hashed attachments and wrote `last_reconcile_at` even when nothing had changed. When another
  process committed during the prepare step, it rescanned everything while holding the lock.
- Every `dm` CLI call opened a Workspace and ran that full reconcile before it answered. The Skitarii extension called
  `get_project` before every model request. More than 40 concurrent `get_project` CLI processes were seen piling up,
  and one `get_capabilities` took 186 s.
- Forge member views rendered nothing until a full member reconcile finished. A background job could retire the owner
  the person was looking at, which forced a cold reopen and another full reconcile.
- **SQLite was not the limit.** 24 concurrent writer processes with this app's settings sustained about 1,000
  commits/s, with a write p99 of 3 ms and a read p99 of 0.1 ms, both on local disk and on OneDrive.

**The DM-959 baseline** ([`reports/performance-revamp.md`](../reports/performance-revamp.md), measured at `4d3486bb`
on generated fixtures and a copy of the real store) confirmed the same shape:

- On the 10,000-ticket fixture the plan view, ticket panel and board load in 63 / 14 / 10 ms p50 when idle. While
  one changed epic state is imported they take 395 / 398 / 363 ms p50 (484 / 466 / 443 ms p95). Almost all of that is
  queue wait behind the reconcile; owner run time hardly changes.
- The changed-epic import held the write lock for 104 ms in one transaction. An explicit reconcile with nothing
  changed held it for 277 ms, because its unchanged-record checks ran inside the transaction. It took 1.5 s, with 424
  text body reads, 9,874 realpaths and 23,899 stat calls.
- A lone built `dm call` took about 240 ms. Twelve looping CLI agents during a desktop sync completed 221 calls in
  60 s, 3.5 to 4 s p50 per call and up to 12.7 s. Every call returned `ok`.

## Decision

Keep SQLite (`node:sqlite`, WAL, `synchronous=FULL`, one `BEGIN IMMEDIATE` writer; [0001](0001-sqlite-driver.md))
and remove the waiting instead. Read only what changed, hold the write lock only to write, and take reconcile off the
path that serves the screen. [`architecture.md`](../architecture.md#repository-owned-persistence) describes each part
as built.

1. **Skip what is known to be unchanged.** The DM-957 reconcile fingerprint stays the first fast path of an automatic
   reconcile (open and heartbeat).
2. **Ask git what changed.** When the fingerprint misses, an automatic reconcile takes one
   `git status --porcelain=v2` snapshot (HEAD, branch and paths). Only when HEAD has moved since the stored marker does
   it run an ancestry check and a diff. It reads only the records those paths name, plus every record in conflict,
   exported since the last reconcile, or left unsettled by it. Anything git cannot vouch for falls back to a full
   read, with a named reason (`gitChanges.ts`, `reconcileScope.ts`). The marker (`reconcile_base_commit`,
   `reconcile_importer_version`, `reconcile_dirty_paths`, capped at 5,000 paths) is written in the reconcile's own
   closing transaction. `IMPORTER_VERSION` forces one full read whenever import semantics change.
3. **Hold the writer lock only to write.** Prepare reads, validates and plans in a read snapshot. A reconcile that
   would change nothing takes no write transaction. Each changed epic, run, comment, profile and Kanban card is applied
   in its own short transaction, which first checks that HEAD, the record's files and its own database state
   (`recordGuard.ts`) are as prepared. A record that moved is prepared again outside the lock, at most twice, then left
   for the next reconcile. One closing transaction stores conflicts and records one `repository.reconciled` event.
   The consistency contract is per record: each record is all-old or all-new, and a reader may see some records of a
   reconcile before others.
4. **Stage exports outside the lock.** The finalizer writes, fsyncs and reads back temp files in a read transaction,
   then renames them into place in one short `BEGIN IMMEDIATE` that checks the content is still what it staged.
   Replaced files are restored inside the transaction on failure. Failed entries back off (15 s, doubling to 5 min).
   An explicit flush ignores the backoff, and a reconcile that imports an entry's records releases it.
5. **Move reconcile off the screen's path.** Each desktop project owner runs its reconcile on a worker thread with
   its own connection (the sync lane), with at most one running and one pending reconcile per project. Background work
   never retires an owner the screen used in the last 60 s; it may open one process beyond the two screen slots. A
   Forge member with a validated local import renders at once with a Syncing badge.
6. **Stop agents piling up.** The Skitarii extension shares one in-flight `get_project` per chat, caches a success for
   60 s, falls back to a read under 10 min old, and bounds each read's CLI child to 30 s.

No agent command gained an error code, capability, required argument, grant, lock, wait or retry loop, and no
agent command is refused or held because a sync is running. Claim fencing, idempotency, conflict detection,
untrusted-input validation of every imported record and branch-change semantics are unchanged.

## Alternatives considered

- **Port storage to Postgres** (rejected). Nothing measured pointed at SQLite: 24 writer processes sustained about
  1,000 commits/s with millisecond p99s, and the reads themselves took milliseconds. The cost was waiting in one queue
  and long lock holds, which a server database would not remove. The port itself is large. The plan counted 866
  synchronous database call sites in 112 files, all written against the synchronous `Db` interface, that would need
  rewriting to an asynchronous client. A narrower recount on the integrated branch (calls of `get`, `all`, `run`,
  `exec` and `tx` on database receivers, tests excluded) still finds 488 in 93 files. Every machine would need a
  server to install, run, upgrade and back up, where today the desktop and every headless CLI open one file. Claim
  fencing, idempotency and the single-writer ordering the lease and checkpoint rules rely on would all have to be
  proved again under another isolation model.
- **An asynchronous reconcile on the owner's own thread** (rejected). Making reconcile `async` and yielding between
  records would still run its parsing, hashing and validation on the thread that serves the screen, so reads would
  still queue behind each slice. The prepare phase also needs one consistent read snapshot, which a reconcile that
  yields to interleaved commands on the same connection cannot keep. A separate thread with its own connection lets
  WAL serve reads while the import runs. The DM-963 packaged-build probe (at `3ad59e13`) recorded GO for that design
  ([`sync-lane-probe-DM-963.jsonl`](../reports/forge-performance-data/sync-lane-probe-DM-963.jsonl): 10,000
  tickets during an explicit reconcile, p95 plan 49 / ticket 15 / board 8 ms, 30 of 30 loads finished while the
  reconcile was still running).
- **A larger or persistent hash cache alone** (not chosen). It would cut re-hashing but still walk every tracked file
  and hold the lock while checking it. The git change set removes the walk; the 4,096-entry cache is unchanged.

## Consequences

- **Measured on the way.** The per-ticket harness runs (raw rows in `docs/reports/forge-performance-data/`) show the
  direction. They come from a shared, busy host, so the integrated-branch columns of the
  [report](../reports/performance-revamp.md), filled in by the sprint acceptance node, are the numbers of record.
  - At `c0c1ed75` (DM-962, which includes the sync lane and the staged export) on 10,000 tickets during a sync, view
    loads were p95 plan 48.4, ticket 16.9 and board 9.9 ms (baseline 484 / 466 / 443 ms). The changed-epic reconcile
    took 2 write transactions, the longest held for 33.8 ms (baseline 1 transaction of 104 ms). An explicit unchanged
    reconcile took 0 write transactions (baseline 1 of 277 ms). Twelve CLI agents completed 186 calls, all `ok`,
    and the lane's longest hold was 56.9 ms.
  - DM-961 measured a built `dm call list_kanban_cards` on a committed 10,000-ticket fixture whose fingerprint missed on
    every call. With the targeted reconcile it answered in 405 ms p50, against 2,020 ms p50 for a full reconcile on
    the same fixture with an unborn HEAD.
- **A reconcile is no longer one atomic swap.** Readers can see records from the same pull arrive one by one. Each
  record stays internally consistent, and a run or comment waits for its epic. A record that keeps moving is left
  unsettled and picked up by the next reconcile, without an error.
- **Correctness now leans on git and on the marker.** Every case git cannot account for falls back to a full read:
  no or old marker, rewritten history, branch change, unborn HEAD, no work tree, git failure, `project.json`, unknown
  or ignored paths, and a record deleted here since the last reconcile. Import semantics changes must bump
  `IMPORTER_VERSION`.
- **Known gaps the workers recorded:**
  - *Wall-clock anchor for exports since the last reconcile.* `recheck` re-reads records whose outbox entry completed
    at or after `last_reconcile_at`. Both are written by the same clock, and equal times count. If the system clock
    steps backwards between an export and the next reconcile, an export written and then reverted in that window may
    not be re-read. A no-op reconcile leaves `last_reconcile_at` alone, which only widens the window.
  - *Change and revert racing the status read.* The status is taken before any file is read, so a change made after
    it is reported by the next status. A file changed after the status, read and imported by this reconcile, then
    reverted before the next status, leaves git nothing to report and the database holding the newer content until a
    full reconcile (the desktop's or the CLI's explicit `reconcile_repository`, or any fallback) reads it again. The
    fingerprint gate carries the same kind of limit: a rewrite that keeps a file's size, times and inode cannot be
    told apart.
  - *Up to three processes per desktop.* The pool serves the screen from two owner processes and may open a third for
    background work rather than retire an owner the person just used. Each owner now has a second SQLite connection on
    its sync-lane thread.
- **The desktop's explicit Reconcile is git-targeted as merged.** `Workspace.reconcile()` passes `{ full: true }` for
  an explicit reconcile, so `reconcile_repository` from the CLI or MCP reads everything. The desktop routes its
  `reconcileRepository` command (the Reconcile button and Forge source validation) to the sync lane in `explicit`
  mode, where it is ungated but called without `full`. It therefore reads what git reports, plus the rechecks and
  fallbacks, rather than every record.
- **The 250 ms hold target is a test, not a lock.** Nothing refuses or times out a long transaction. The `Db` hold
  observer (`onTransaction`, `tagTransactions`) and the pool's slow-operation log (over 1 s) make a regression
  visible.
- **Revisit** if a measurement shows SQLite's single writer, not waiting, is the limit, or if many processes on one
  machine must share writes at a rate the WAL writer cannot sustain.
