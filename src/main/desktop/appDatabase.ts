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

/** Schema of the app-wide database in user data. Separate from the per-folder `MIGRATIONS`. */
export const APP_MIGRATIONS: Migration[] = [{ version: 1, sql: V1 }]

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
