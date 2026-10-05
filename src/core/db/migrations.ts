import { fail } from '../errors'
import type { Db } from './database'

/** Highest schema version this build understands. Newer databases are refused, never downgraded. */
export const SCHEMA_VERSION = 8

interface Migration {
  version: number
  sql: string
}

const V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('desktop','planner','orchestrator','worker','reviewer')),
  label TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  transport TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('backlog','in_progress','completed')),
  current_revision_id TEXT,
  branch_json TEXT,
  provenance_json TEXT,
  outcome_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  number INTEGER NOT NULL,
  base_revision_id TEXT,
  content_hash TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','saved','failed')),
  created_at TEXT NOT NULL,
  saved_at TEXT,
  created_by TEXT
);
CREATE INDEX plan_revisions_epic ON plan_revisions(epic_id, number);

CREATE TABLE drafts (
  epic_id TEXT PRIMARY KEY REFERENCES epics(id),
  base_revision_id TEXT,
  draft_revision INTEGER NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE ticket_status (
  ticket_id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  status TEXT NOT NULL CHECK (status IN ('backlog','in_progress','completed')),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX ticket_status_epic ON ticket_status(epic_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  number INTEGER NOT NULL,
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  state TEXT NOT NULL CHECK (state IN ('queued','running','awaiting_checkpoint','paused','failed','canceled','completed')),
  active_sprint_id TEXT,
  orchestrator_session_id TEXT,
  host_json TEXT,
  host_catalog_id TEXT,
  skill_version TEXT,
  owner_machine_id TEXT NOT NULL,
  pause_reason TEXT,
  auto_continue INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX runs_one_active_per_epic ON runs(epic_id)
  WHERE state IN ('queued','running','awaiting_checkpoint','paused');

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  ticket_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work','carry_forward')),
  state TEXT NOT NULL CHECK (state IN ('claimed','running','submitted','accepted','rejected','failed','canceled','lease_expired')),
  fencing_token INTEGER NOT NULL,
  claim_secret TEXT,
  worker_json TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  ticket_content_hash TEXT NOT NULL,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  outputs_json TEXT,
  evidence_json TEXT,
  failure_json TEXT,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  reconciled_at TEXT,
  superseded_at TEXT,
  UNIQUE (run_id, ticket_id, number)
);
CREATE UNIQUE INDEX attempts_one_open_per_ticket ON attempts(run_id, ticket_id)
  WHERE state IN ('claimed','running','submitted');
CREATE INDEX attempts_run_state ON attempts(run_id, state);

CREATE TABLE retry_grants (
  run_id TEXT NOT NULL REFERENCES runs(id),
  ticket_id TEXT NOT NULL,
  extra INTEGER NOT NULL,
  PRIMARY KEY (run_id, ticket_id)
);

CREATE TABLE sprint_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sprint_id TEXT NOT NULL,
  report_revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  submitted_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sprint_id, report_revision)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sprint_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('advanced','completed')),
  policy TEXT NOT NULL CHECK (policy IN ('human','auto')),
  approval_id TEXT,
  decided_by TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT
);

CREATE TABLE host_catalogs (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  host_type TEXT NOT NULL,
  catalog_revision TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  registered_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  epic_id TEXT,
  run_id TEXT,
  ticket_id TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_epic ON events(epic_id, seq);
CREATE INDEX events_run ON events(run_id, seq);

CREATE TABLE idempotency (
  command TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (command, key)
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history')),
  epic_id TEXT,
  run_id TEXT,
  revision_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);

CREATE VIRTUAL TABLE search_index USING fts5(
  doc_type UNINDEXED,
  doc_id UNINDEXED,
  epic_id UNINDEXED,
  run_id UNINDEXED,
  ticket_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
`

/**
 * v2 widens the outbox and sync state to comment and profile records and adds `outbox.entity_id` for
 * records keyed by something other than an epic, run, or revision. SQLite cannot alter a CHECK
 * constraint, so both tables are rebuilt; row ids and the outbox id sequence carry over.
 */
const V2 = `
CREATE TABLE outbox_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history','comment','profile')),
  epic_id TEXT,
  run_id TEXT,
  revision_id TEXT,
  entity_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
INSERT INTO outbox_v2 (id, kind, epic_id, run_id, revision_id, state, attempts, last_error, created_at, done_at)
  SELECT id, kind, epic_id, run_id, revision_id, state, attempts, last_error, created_at, done_at FROM outbox;
DELETE FROM sqlite_sequence WHERE name = 'outbox_v2';
INSERT INTO sqlite_sequence (name, seq) SELECT 'outbox_v2', seq FROM sqlite_sequence WHERE name = 'outbox';
DROP TABLE outbox;
ALTER TABLE outbox_v2 RENAME TO outbox;
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state_v2 (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run','comment','profile')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
INSERT INTO sync_state_v2 (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
  SELECT kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at FROM sync_state;
DROP TABLE sync_state;
ALTER TABLE sync_state_v2 RENAME TO sync_state;
`

/**
 * v3 adds comments: append-only Markdown notes on an epic (`ticket_id` NULL) or one of its tickets.
 * The author is the writing session's role and label, never caller input.
 */
const V3 = `
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epics(id),
  ticket_id TEXT,
  body TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('desktop','planner','orchestrator','worker','reviewer')),
  author_label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_epic_ticket ON comments(epic_id, ticket_id, created_at);
`

/**
 * v4 adds named capability profiles: reusable, provider-neutral presets keyed by a file-safe name and
 * exported as `.darkmechanicus/profiles/<name>.json`. `revision` is this database's optimistic
 * concurrency counter for saves; it is not part of the tracked record.
 */
const V4 = `
CREATE TABLE profiles (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  capability_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

/**
 * v5 adds row checks: the orchestrator's record that one dependency row of a sprint (`row_no`, counted
 * from 1) combined cleanly at `commit_ref`. `number` counts the checks of a run in the order they were
 * recorded, so the latest check of a row is its highest number. A check passed when every entry in
 * `checks_json` passed; that is derived on read, never stored. Exported with the run history.
 */
const V5 = `
CREATE TABLE row_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  sprint_id TEXT NOT NULL,
  row_no INTEGER NOT NULL CHECK (row_no >= 1),
  commit_ref TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  recorded_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, number)
);
CREATE INDEX row_checks_run ON row_checks(run_id, sprint_id, row_no);
`

/**
 * v6 stores the server's verdict on a sprint increment with the acceptance-node attempt that named it:
 * `increment_json` is NULL for every attempt that named none (all attempts before this version, and
 * every work ticket's), and otherwise the `SprintIncrement` written when the submission arrived. The
 * `increment_merged` gate reads it, so the verdict never has to be recomputed. Exported with the run history.
 */
const V6 = `
ALTER TABLE attempts ADD COLUMN increment_json TEXT;
`

/**
 * v7 records, with each sprint report, the plan revision the run executed when it was submitted. A run that
 * later adopts a revision changing the sprint beyond removing the retro's leftovers needs a new report revision
 * before approval, and this is what that is measured against. It is a local fact like the approval grants, not
 * exported: NULL for every report before this version and for reports imported from tracked records, and such a
 * report is taken as current.
 */
const V7 = `
ALTER TABLE sprint_reports ADD COLUMN revision_id TEXT;
`

/**
 * v8 records when a run was paused (`paused_at`, set by every pause and cleared by resume). A run paused for
 * sign-in keeps its open leases, and resume extends each by the time the run spent paused, which is measured
 * from this. It is a local fact like leases and heartbeats, not exported: NULL for every run before this version,
 * for every run that is not paused, and for runs imported from tracked records, and such a pause extends nothing.
 */
const V8 = `
ALTER TABLE runs ADD COLUMN paused_at TEXT;
`

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
  { version: 7, sql: V7 },
  { version: 8, sql: V8 }
]

export function readSchemaVersion(db: Db): number {
  return db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0
}

/**
 * Applies pending migrations under the write lock (BEGIN IMMEDIATE doubles as the migration lock).
 * A database written by a newer build is refused rather than migrated by competing clients.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): { from: number; to: number } {
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  return db.tx(() => {
    const from = readSchemaVersion(db)
    if (from > target) {
      fail(
        'incompatible_schema',
        `Database schema v${from} is newer than this build supports (v${target}). Update Dark Mechanicus.`,
        { found: from, supported: target }
      )
    }
    for (const migration of migrations) {
      if (migration.version > from) {
        db.exec(migration.sql)
      }
    }
    if (target !== from) {
      db.exec(`PRAGMA user_version = ${target}`)
    }
    return { from, to: target }
  })
}
