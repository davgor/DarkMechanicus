# 0001 — SQLite driver: built-in `node:sqlite`

- **Status:** accepted
- **Date:** 2026-09-30
- **Tickets:** 009.2 (driver and migrations), 009.6 (desktop + headless share one database)

## Context

Dark Mechanicus keeps its live working state in a repository-local SQLite database
(`.darkmechanicus/local/state.sqlite`). Two kinds of process open that same file, often at the same time:

- the **desktop app**, inside Electron 42's main process (Node 24 runtime), and
- the **headless MCP server** (`out/main/mcp.js`), launched by an agent host with system Node, or packaged as the
  app executable with `ELECTRON_RUN_AS_NODE=1`.

The driver therefore has to load in both runtimes from one build, support WAL with several processes writing,
serialize writers, offer full-text search for history, and take consistent online backups.

## Decision

Use the built-in **`node:sqlite`** module (`DatabaseSync`, synchronous API) through the thin wrapper in
`src/core/db/database.ts`. No native `.node` binary is shipped or rebuilt.

## Verification

Run on 2026-09-30 in this repository (Linux x64):

| Runtime | Command | Result |
|---------|---------|--------|
| Electron 42.11.9 (Node 24.19.0) | `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -e "require('node:sqlite')"` | Loads with **no warning**; SQLite **3.53.3** |
| System Node 22.22.2 | `node -e "require('node:sqlite')"` | Loads; SQLite **3.51.2**; prints only `ExperimentalWarning: SQLite is an experimental feature` (harmless) |

In both runtimes a scripted check confirmed the features the app relies on: `PRAGMA journal_mode = WAL`
returns `wal` for a file database, `BEGIN IMMEDIATE` transactions commit, an FTS5 table with
`tokenize = 'porter unicode61'` (the `search_index` schema) is created, and `VACUUM INTO ?` writes a copy that
opens with the same rows.

## Alternatives rejected

- **better-sqlite3** — a native module compiled against one Node/Electron ABI. The desktop (Electron's Node 24 ABI)
  and the headless MCP server (system Node) would need different binaries, rebuilt per Electron upgrade and per
  platform/architecture in packaging, which is exactly the fragility this project cannot afford for a process
  that agents launch on their own.
- **sql.js / other WASM builds** — the database lives in memory and is written back as a whole file. There is no WAL,
  no file locking, and no safe multi-process access, so the desktop and an MCP process would overwrite each other.

## Consequences

- **Concurrency:** every database is opened with `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`,
  and `synchronous = FULL`. All writes go through `db.tx()`, which starts with `BEGIN IMMEDIATE` (nested calls use
  savepoints), so processes queue on the write lock instead of failing lock upgrades. The finalizer holds that
  lock while writing repository records, which also serializes finalizers across processes.
- **Schema:** `PRAGMA user_version` is the schema version; migrations run under the write lock, and a newer database
  is refused with `incompatible_schema` instead of being downgraded.
- **Backups:** `VACUUM INTO` (a consistent snapshot of a live WAL database, run outside any transaction), never a raw
  file copy. See `src/core/repo/backup.ts`.
- **Runtime floor:** Node **≥ 22.13** (where `node:sqlite` is available without a flag) for the headless server;
  Electron 42 already bundles Node 24. On Node 22 the module prints an `ExperimentalWarning` to stderr, which never
  touches the MCP stdio protocol on stdout.
- **API stability:** `node:sqlite` is still marked experimental on Node 22. The wrapper interface (`Db`) is the only
  place that touches it, so a future API change stays a one-file change.
