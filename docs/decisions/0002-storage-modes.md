# 0002 — Storage modes: records in the repository, or database only

- **Status:** accepted
- **Date:** 2026-10-13

## Context

Dark Mechanicus was built around one storage shape: the portable records live in the repository
under `.darkmechanicus/` and travel with the code in Git, while `.darkmechanicus/local/state.sqlite`
is a derived working database rebuilt from them. That is the right shape for a repository whose
plan belongs with its code.

It is the wrong shape for a checkout that must not carry planning data — most obviously someone
else's repository, where a `.darkmechanicus/` directory, a `.gitignore` entry, a `.mcp.json` and
installed skills are all files a person then has to explain, exclude or keep deleting. Exercising
the Dark Mechanicus workflow against such a checkout should change nothing in it.

## Decision

A repository folder has a **storage mode**, fixed when it is set up:

- **`repo`** (default, unchanged): the records are files in `.darkmechanicus/`, tracked by Git, with
  the working database beside them in the Git-ignored `local/`.
- **`db`**: the project lives entirely in one machine-local SQLite database under the Dark
  Mechanicus home directory (`$DARKMECHANICUS_HOME`, else `~/.darkmechanicus`), in
  `projects/<folder-name>-<path-digest>/`. **Nothing whatsoever is written into the repository.**

### How the mode is known

A database-only project announces itself by existing: `resolveStorageMode` reports `db` when
`<home>/projects/<key>/project.json` is there, and `repo` otherwise. There is no mode setting to
keep in sync, and the desktop app and the headless MCP server resolve the same mode from the
repository path alone. `initialize_repository` refuses to set a folder up one way when it is
already set up the other, so one folder never has two projects.

### How `db` mode works

`resolveLayout` moves the whole owned layout — including the record directories that mode never
writes — into the project directory, so no owned path can name anything inside the repository, and
the existing containment checks then guard that directory instead of `.darkmechanicus/`.

The outbox is kept rather than bypassed, because the database side of a save is completed by the
finalizer's `onSnapshotSaved` hook once the snapshot is durable. In `db` mode the finalizer uses a
handler table that runs that hook and writes no file; every other kind of entry names a file that
mode does not have, and the database already holds the record, so the entry is simply completed.
Reconcile returns an empty result: there is nothing tracked to import, nothing records the checkout
branch, and moving the checkout therefore never pauses a run.

The two desktop operations that would otherwise drop a file into the checkout — installing the
skills into `.claude/skills/`, and writing `.mcp.json` — are refused for a `db` folder with
`unsupported_capability`, rather than silently skipped. The connection snippet is still shown, to
be copied into the agent host's own configuration.

The snippet pins `DARKMECHANICUS_HOME` to the directory the app resolved. A GUI app does not
inherit a shell's environment, so leaving each process to resolve the home directory for itself
could give the desktop app and a shell-launched agent different ones, and they would never find the
same project.

### What a `db` project does not get

The checkout branch is never recorded for a `db` project, so the branch guard never fires: saving,
dispatching and commenting go on across a branch switch, and a branch change does not pause a run.
For the *plan* that is simply correct — it is not in the checkout, so it cannot disagree with it.
For a *run* it is a real trade-off and not only a simplification: an epic still records the branch
it was started on, the work still lands in the checkout, and in `repo` mode moving the checkout
pauses every active run. A `db` project gets no such pause. The alternative — recording the branch
to keep the pause — would also turn the guard back on and block saves that have no reason to be
blocked, so the two would have to be split before that is worth doing.

## Consequences

- A `db` project is machine-local. It does not travel with the repository, a clone sees none of it,
  and it is not backed up by committing. That is the point of the mode, and the setup screen and
  storage card say so.
- Branch-scoped behaviour (the branch guard, `list_branch_epics`, pausing runs on a branch change)
  does not apply: the plan is not in the checkout, so it cannot disagree with it.
- The project record itself stays a `project.json` file, in the project directory rather than the
  repository. It is configuration, not a ticket, and keeping it a file keeps it readable and
  hand-editable, and keeps `readProject`, the Definition of Done writer and initialization working
  unchanged.
- Converting a folder between modes is not implemented. It would be an explicit migration command.

## Known limitations

These follow from the central promise — that the repository holds no Dark Mechanicus file — and so
cannot be fixed by anything written into the repository. Each one is a real hole, not a hypothetical.

- **A different home directory fails open.** `resolveStorageMode` has no "I don't know" state: if
  `<home>/projects/<key>/project.json` is not visible, for any reason, the folder reads as `repo`.
  A process with a different `DARKMECHANICUS_HOME` (a GUI app inherits no shell environment) will
  therefore see a `db` folder as unset-up, and an agent that then calls `initialize_repository`
  creates a second, empty project **in the repository**. The snippet the app produces pins
  `DARKMECHANICUS_HOME` for exactly this reason; an agent configured by hand, or by
  `claude mcp add`, does not get that pin.
- **Moving or renaming the folder orphans the project.** The key is a digest of the folder's path,
  so after a move the folder reads as unset-up and the old project is unreachable. Nothing is lost
  on disk, and the project record names the folder it was created for (`repoRoot`) so it can be
  identified by hand, but there is no re-point command and no warning.
- **Setting a folder up twice at once is a race.** `assertSingleProject` is checked before anything
  is created and again immediately before the project record is written, but the two modes write
  into different directories and there is no atomic way to claim both. Two processes initializing
  the same folder in different modes at the same instant can still produce two projects; the `db`
  one then wins every later resolution and the repository one becomes invisible.
- **The home directory must be on a local disk.** The database runs in WAL mode. Pointing
  `DARKMECHANICUS_HOME` at a synced or network folder (Dropbox, iCloud, a share) risks corruption,
  and nothing validates it.
