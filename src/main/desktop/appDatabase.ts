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

/**
 * v5 adds cults (`src/main/cults/cultStore.ts`, contract in `src/shared/cults/cult.ts`). Cults are app-level, not
 * per folder, because a `sanctum` cult has no folder. A cult's roster slots are materialized from its archetype when
 * it is founded, so later catalog changes never rewrite it. A run is `starting`, `running`, `paused`,
 * `shutting_down` or `ended`; every state but `ended` is active, and a cult has at most one active run
 * (`cult_runs_one_active`). A NULL time limit is unlimited. Member display names are unique per run regardless of
 * case, and a member holds a roster slot or a run-scoped worker type, never both. Run-scoped worker types are kept
 * when retired, so their `dyn_<n>` ids are never handed out twice in a run, and they never join the cult definition.
 * Event kinds are validated by the store rather than a CHECK, so the pipeline can gain kinds without a table rebuild.
 * Deleting a cult cascades to its slots and runs, and a run to its members, petitions, events, reports and types.
 */
const V5 = `
CREATE TABLE cults (
  id TEXT PRIMARY KEY CHECK (substr(id, 1, 3) = 'ct_'),
  name TEXT NOT NULL,
  charter TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('folder','sanctum')),
  folder_path TEXT,
  archetype TEXT NOT NULL CHECK (archetype IN ('general','plan_forge','delivery','audit_red_team','research_creative','custom')),
  target_epic_id TEXT,
  magos_name TEXT NOT NULL,
  magos_model_id TEXT,
  default_time_limit_ms INTEGER CHECK (default_time_limit_ms IS NULL OR default_time_limit_ms >= 60000),
  default_cap INTEGER NOT NULL CHECK (default_cap BETWEEN 1 AND 24),
  acolyte_grace_ms INTEGER NOT NULL CHECK (acolyte_grace_ms BETWEEN 30000 AND 3600000),
  magos_window_ms INTEGER NOT NULL CHECK (magos_window_ms BETWEEN 30000 AND 3600000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'folder') = (folder_path IS NOT NULL)),
  CHECK (archetype <> 'plan_forge' OR (scope = 'folder' AND target_epic_id IS NOT NULL))
);

CREATE TABLE cult_role_slots (
  cult_id TEXT NOT NULL REFERENCES cults(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  label TEXT NOT NULL,
  mission TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (cult_id, slot_id),
  UNIQUE (cult_id, ordinal)
);

CREATE TABLE cult_runs (
  id TEXT PRIMARY KEY CHECK (substr(id, 1, 3) = 'cr_'),
  cult_id TEXT NOT NULL REFERENCES cults(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('starting','running','paused','shutting_down','ended')),
  end_reason TEXT CHECK (end_reason IN ('completed','expired','stopped','killed','interrupted','failed')),
  time_limit_ms INTEGER CHECK (time_limit_ms IS NULL OR time_limit_ms >= 60000),
  grace_ms INTEGER NOT NULL CHECK (grace_ms BETWEEN 30000 AND 3600000),
  magos_window_ms INTEGER NOT NULL CHECK (magos_window_ms BETWEEN 30000 AND 3600000),
  accumulated_running_ms INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_running_ms >= 0),
  running_since TEXT,
  cap INTEGER NOT NULL CHECK (cap BETWEEN 1 AND 24),
  work_dir TEXT NOT NULL,
  chronicle TEXT,
  shrine_path TEXT,
  shrine_revision TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((state = 'running') = (running_since IS NOT NULL)),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK (state NOT IN ('shutting_down','ended') OR end_reason IS NOT NULL)
);
CREATE UNIQUE INDEX cult_runs_one_active ON cult_runs(cult_id) WHERE state <> 'ended';
CREATE INDEX cult_runs_cult ON cult_runs(cult_id, started_at);

CREATE TABLE cult_run_worker_types (
  run_id TEXT NOT NULL REFERENCES cult_runs(id) ON DELETE CASCADE,
  type_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL,
  mission TEXT NOT NULL,
  rationale TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  creator_chat_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (run_id, type_id),
  UNIQUE (run_id, normalized_name),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  CHECK (required = 0 OR state = 'active')
);

CREATE TABLE cult_members (
  run_id TEXT NOT NULL REFERENCES cult_runs(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('magos','acolyte')),
  display_name TEXT NOT NULL,
  mission TEXT NOT NULL DEFAULT '',
  model TEXT,
  tier TEXT,
  tier_reason TEXT,
  slot_id TEXT,
  worker_type TEXT,
  run_worker_type_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('joining','active','concluded','dismissed','left')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (run_id, chat_id),
  FOREIGN KEY (run_id, run_worker_type_id) REFERENCES cult_run_worker_types(run_id, type_id),
  CHECK (slot_id IS NULL OR run_worker_type_id IS NULL),
  CHECK ((slot_id IS NULL) = (worker_type IS NULL)),
  CHECK (role = 'acolyte' OR (slot_id IS NULL AND run_worker_type_id IS NULL)),
  CHECK ((state IN ('joining','active')) = (left_at IS NULL))
);
CREATE UNIQUE INDEX cult_members_name ON cult_members(run_id, display_name COLLATE NOCASE);
CREATE UNIQUE INDEX cult_members_one_magos ON cult_members(run_id) WHERE role = 'magos' AND state IN ('joining','active');
CREATE INDEX cult_members_run ON cult_members(run_id, state, joined_at);

CREATE TABLE cult_petitions (
  id TEXT PRIMARY KEY CHECK (substr(id, 1, 3) = 'cp_'),
  run_id TEXT NOT NULL REFERENCES cult_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('acolytes','allow_save','folder_access')),
  payload TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied')),
  granted INTEGER CHECK (granted IS NULL OR granted >= 1),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((kind = 'allow_save') = (payload IS NULL)),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (granted IS NULL OR (kind = 'acolytes' AND state = 'approved'))
);
CREATE INDEX cult_petitions_run ON cult_petitions(run_id, state, created_at);

CREATE TABLE cult_events (
  run_id TEXT NOT NULL REFERENCES cult_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  at TEXT NOT NULL,
  member_name TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE cult_specialist_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  member_chat_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 32768),
  target_revision TEXT,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (run_id, member_chat_id) REFERENCES cult_members(run_id, chat_id) ON DELETE CASCADE
);
CREATE INDEX cult_specialist_reports_slot ON cult_specialist_reports(run_id, slot_id, id);
`

/** Schema of the app-wide database in user data. Separate from the per-folder `MIGRATIONS`. */
export const APP_MIGRATIONS: Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 }
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
