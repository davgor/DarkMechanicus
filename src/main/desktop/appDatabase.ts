import { join } from 'node:path'
import { type Db, openDatabase } from '../../core/db/database'
import { type Migration, migrate } from '../../core/db/migrations'

const V1 = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claude','codex','cursor','autonomous','custom')),
  protocol TEXT NOT NULL CHECK (protocol IN ('claude','codex','acp')),
  display_name TEXT NOT NULL,
  executable_path TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  version TEXT,
  connected_via TEXT NOT NULL CHECK (connected_via IN ('found','downloaded','custom')),
  connected_at TEXT NOT NULL,
  last_probed TEXT NOT NULL,
  CHECK (kind = 'custom' OR id = kind),
  CHECK (kind <> 'custom' OR substr(id, 1, 3) = 'cu_')
);
CREATE TABLE folder_agent_defaults (
  folder TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * v2 stores the agent name a custom CLI's handshake reported with its version (`reported_name`), so it is
 * shown as "<name> <version>". NULL for every built-in row, and for every custom row written before this
 * version, which keeps its version and shows it alone until an edit runs the handshake again.
 */
const V2 = `
ALTER TABLE agents ADD COLUMN reported_name TEXT;
`

/**
 * v3 is the cutover to terminal chats (`docs/design/chat-shells.md`, SH-8): a custom CLI is a program and its
 * arguments, run in a chat's terminal, with no protocol and no handshake. The `protocol` column goes, and with it
 * `reported_name` and a custom row's `version`, which only the handshake set.
 *
 * A custom row whose protocol was not Claude Code's (ACP or Codex app-server) has arguments that start a JSON-RPC
 * server, not an interactive program, so it is marked `needs_review`: no chat starts it until the person has
 * confirmed its arguments again (and could edit them) in the native confirmation, which clears the mark. It is
 * marked unless its protocol is `claude`, so no protocol value runs unreviewed. A Claude-protocol row is the program
 * itself and starts as is. Built-in rows never need review.
 *
 * `ALTER TABLE ... DROP COLUMN` keeps the table, its row ids and its checks: rebuilding `agents` would delete
 * every row of it first, and the delete would cascade to `folder_agent_defaults`.
 */
const V3 = `
ALTER TABLE agents ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1));
UPDATE agents SET needs_review = 1 WHERE kind = 'custom' AND protocol IS NOT 'claude';
UPDATE agents SET version = NULL WHERE kind = 'custom';
ALTER TABLE agents DROP COLUMN reported_name;
ALTER TABLE agents DROP COLUMN protocol;
`

/**
 * v4 lets `kind` be `omp`. SQLite cannot alter a CHECK, so `agents` is rebuilt with the same columns and checks and
 * every row copied. Dropping the old table cascades to `folder_agent_defaults`, so its rows are held in a temp table
 * and put back (a transaction cannot switch `foreign_keys` off).
 */
const V4 = `
CREATE TEMP TABLE folder_agent_defaults_keep AS SELECT folder, agent_id, updated_at FROM folder_agent_defaults;
CREATE TABLE agents_v4 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claude','codex','cursor','autonomous','omp','custom')),
  display_name TEXT NOT NULL,
  executable_path TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  version TEXT,
  connected_via TEXT NOT NULL CHECK (connected_via IN ('found','downloaded','custom')),
  connected_at TEXT NOT NULL,
  last_probed TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  CHECK (kind = 'custom' OR id = kind),
  CHECK (kind <> 'custom' OR substr(id, 1, 3) = 'cu_')
);
INSERT INTO agents_v4 (id, kind, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed, needs_review)
  SELECT id, kind, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed, needs_review FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v4 RENAME TO agents;
INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) SELECT folder, agent_id, updated_at FROM folder_agent_defaults_keep;
DROP TABLE folder_agent_defaults_keep;
`

/** Schema of the app-wide database in user data. Separate from the per-folder `MIGRATIONS`. */
export const APP_MIGRATIONS: Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 }
]

/**
 * Opens `<userDataDir>/app.sqlite` and brings it to the latest app schema. A file written by a
 * newer build throws `incompatible_schema`; callers let that propagate.
 */
export function openAppDatabase(userDataDir: string): Db {
  const db = openDatabase(join(userDataDir, 'app.sqlite'))
  try {
    migrate(db, APP_MIGRATIONS)
  } catch (error: unknown) {
    db.close()
    throw error
  }
  return db
}
