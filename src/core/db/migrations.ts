import { fail } from '../errors'
import { redactedJson } from '../storedSecrets'
import type { Db } from './database'

/** Highest schema version this build understands. Newer databases are refused, never downgraded. */
export const SCHEMA_VERSION = 39

export interface Migration {
  version: number
  sql: string
  /** Rewrites rows after `sql` ran, in the same transaction, where SQL alone cannot express the change. */
  data?: (db: Db) => void
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

/**
 * v9 adds grants, and the `reader` role the sessions they govern fall back to.
 *
 * A session's role used to come from the flags its process was launched with, which only a person
 * could set because only a person wrote the MCP configuration. A local CLI has no such property:
 * anything that can run it can pass any flag. So a role is instead *granted* — a person issues one
 * in the desktop app, and the grant is what a session presents. Only the hash of the token is kept,
 * so the database never holds anything that could be replayed; `machine_id` ties a grant to the
 * machine it was issued on, and a grant expires and can be revoked.
 *
 * A session with no grant runs as `reader`, which may only read, so the sessions table has to admit
 * that role. SQLite cannot alter a CHECK constraint, so the table is rebuilt the way v2 rebuilt the
 * outbox. Grants never carry a human-only capability (`HUMAN_ONLY_CAPABILITIES`): approving a
 * checkpoint, deleting an epic and issuing a further grant stay with the person at the desktop.
 */
const V9 = `
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('planner','orchestrator','worker','reviewer','reader')),
  allow_save INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  issued_by_session TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX grants_active ON grants(revoked_at, expires_at);

CREATE TABLE sessions_v2 (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('desktop','planner','orchestrator','worker','reviewer','reader')),
  label TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  transport TEXT NOT NULL,
  pid INTEGER,
  grant_id TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);
INSERT INTO sessions_v2 (id, role, label, capabilities_json, transport, pid, grant_id, started_at, last_seen_at, ended_at)
  SELECT id, role, label, capabilities_json, transport, pid, NULL, started_at, last_seen_at, ended_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
`

/**
 * v10 changes no schema: it scrubs the secrets that stored idempotent responses kept before
 * `withIdempotency` redacted them. A `claimTicket` response held its claim token in plaintext, so
 * replaying the key returned a working token. Every stored response is put through the same
 * redaction new ones get (`storedSecrets.ts`), so the claim token reads back as null and a token
 * pasted into any other response is masked. A response that changes nothing is left byte for byte;
 * one that cannot be parsed cannot be checked, so it is dropped, and its key executes afresh.
 */
function scrubStoredResponses(db: Db): void {
  const rows = db.all<{ command: string; key: string; response_json: string }>('SELECT command, key, response_json FROM idempotency')
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.response_json)
    } catch {
      db.run('DELETE FROM idempotency WHERE command = ? AND key = ?', row.command, row.key)
      continue
    }
    const scrubbed = redactedJson(parsed)
    if (scrubbed !== JSON.stringify(parsed)) {
      db.run('UPDATE idempotency SET response_json = ? WHERE command = ? AND key = ?', scrubbed, row.command, row.key)
    }
  }
}

/**
 * V11: a person-authorized transfer of a saved epic to Linear, the Linear items it has created so far, and the
 * read-back an agent is sending in parts (`readback_json`, cleared as soon as a final part arrives).
 */
const V11 = `
CREATE TABLE transfers (
  epic_id TEXT PRIMARY KEY REFERENCES epics(id),
  target TEXT NOT NULL CHECK (target IN ('linear')),
  status TEXT NOT NULL CHECK (status IN ('queued','in_progress','verified','canceled')),
  revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
  packet_hash TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  project_id TEXT,
  project_url TEXT,
  last_mismatches_json TEXT,
  readback_json TEXT,
  queued_by TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  session_id TEXT
);

CREATE TABLE transfer_items (
  epic_id TEXT NOT NULL REFERENCES transfers(epic_id),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','milestone','issue','relation')),
  linear_id TEXT NOT NULL,
  identifier TEXT,
  url TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (epic_id, ref)
);
`

/**
 * v12 records, for an epic of a folder of repositories, the epic branch as bound in each repository its runs'
 * saved plans name (`repository_branches_json`: a JSON array of `EpicBranch`, one per repository, each with its
 * own start commit). `branch_json` keeps the epic's own branch, so its readers are unchanged. NULL for every epic
 * before this version and for every single-repository epic. Exported with the epic state as `repositoryBranches`.
 */
const V12 = `
ALTER TABLE epics ADD COLUMN repository_branches_json TEXT;
`

/**
 * v13 adds the Kanban board: cards (keyed from the project's ticket sequence, so no card and plan ticket share a
 * key), their attempts (at most one open per card, holding the claim secret and lease) and one event per transition.
 * The outbox and sync state gain the `kanban_card` and `kanban_event` record kinds; SQLite cannot alter a CHECK
 * constraint, so both tables are rebuilt the way v2 rebuilt them, keeping every row, id and the outbox id sequence.
 */
const V13 = `
CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  acceptance_criteria_json TEXT NOT NULL,
  expected_artifacts_json TEXT NOT NULL,
  references_json TEXT NOT NULL,
  priority TEXT NOT NULL,
  size TEXT,
  lane TEXT NOT NULL CHECK (lane IN ('backlog','in_progress','ready_for_review','done')),
  play_requested_at TEXT,
  play_requested_by TEXT,
  created_by_role TEXT NOT NULL,
  created_by_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT,
  compacted_at TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE kanban_attempts (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES kanban_cards(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  state TEXT NOT NULL CHECK (state IN ('claimed','running','submitted','accepted','rejected','failed','lease_expired')),
  claim_secret TEXT NOT NULL,
  machine_id TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  progress_note TEXT,
  outputs_json TEXT,
  evidence_json TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  UNIQUE (card_id, number)
);
CREATE UNIQUE INDEX kanban_attempts_one_open_per_card ON kanban_attempts(card_id)
  WHERE state IN ('claimed','running','submitted');

CREATE TABLE kanban_events (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES kanban_cards(id),
  kind TEXT NOT NULL,
  attempt_id TEXT,
  actor_role TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX kanban_events_card ON kanban_events(card_id, created_at, id);

CREATE TABLE outbox_v13 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history','comment','profile','kanban_card','kanban_event')),
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
INSERT INTO outbox_v13 (id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at)
  SELECT id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at FROM outbox;
DELETE FROM sqlite_sequence WHERE name = 'outbox_v13';
INSERT INTO sqlite_sequence (name, seq) SELECT 'outbox_v13', seq FROM sqlite_sequence WHERE name = 'outbox';
DROP TABLE outbox;
ALTER TABLE outbox_v13 RENAME TO outbox;
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state_v13 (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run','comment','profile','kanban_card','kanban_event')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
INSERT INTO sync_state_v13 (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
  SELECT kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at FROM sync_state;
DROP TABLE sync_state;
ALTER TABLE sync_state_v13 RENAME TO sync_state;
`

/**
 * v14 adds image attachments: one row per PNG or JPEG, its metadata and its bytes (`data`, a BLOB). A row is staged
 * (no owner) until a record claims it. `missing` marks a row whose bytes a repository file import could not find.
 * The outbox and sync state gain the `attachment` kind; both tables are rebuilt the way v13 rebuilt them, keeping
 * every row, id and the outbox id sequence.
 */
const V14 = `
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  width INTEGER NOT NULL CHECK (width >= 1),
  height INTEGER NOT NULL CHECK (height >= 1),
  label TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('evidence','reference')),
  owner_kind TEXT CHECK (owner_kind IN ('attempt','kanban_attempt','comment','kanban_card','ticket')),
  owner_id TEXT,
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0,1)),
  data BLOB,
  created_by_role TEXT NOT NULL,
  created_by_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((owner_kind IS NULL) = (owner_id IS NULL))
);
CREATE INDEX attachments_owner ON attachments(owner_kind, owner_id);

CREATE TABLE outbox_v14 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history','comment','profile','kanban_card','kanban_event','attachment')),
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
INSERT INTO outbox_v14 (id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at)
  SELECT id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at FROM outbox;
DELETE FROM sqlite_sequence WHERE name = 'outbox_v14';
INSERT INTO sqlite_sequence (name, seq) SELECT 'outbox_v14', seq FROM sqlite_sequence WHERE name = 'outbox';
DROP TABLE outbox;
ALTER TABLE outbox_v14 RENAME TO outbox;
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state_v14 (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run','comment','profile','kanban_card','kanban_event','attachment')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
INSERT INTO sync_state_v14 (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
  SELECT kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at FROM sync_state;
DROP TABLE sync_state;
ALTER TABLE sync_state_v14 RENAME TO sync_state;
`

/**
 * v15 adds local agent mail between Skitarii chats (`services/agentMailStore.ts`). Every table is local-only: no
 * outbox kind, sync state, portable record, event body or search index ever carries a row, so in `repo` mode too the
 * database holds the only copy.
 *
 * - `agent_mail_endpoints`: one opaque mailbox per (machine, trusted chat id) of this project's database. Rows are never
 *   deleted: a deleted chat leaves a `deleted` tombstone that keeps its sequence high-water (`last_seq`), so a
 *   recipient sequence is never handed out twice, and delivered copies elsewhere keep a valid sender. `human_seen_seq`
 *   is the person's own cursor, separate from agent acknowledgement.
 * - `agent_mail_bindings`: which grant speaks for which endpoint, with the trusted canonical folder and logical
 *   machine id it was bound in. A grant binds once; a closed binding is never reopened; an endpoint has at most one
 *   open binding.
 * - `agent_mail_messages`: received direct messages and replies. `in_reply_to` deliberately has no foreign key, so
 *   purging one mailbox never cascades into another. `expires_at` is set only by acknowledgement.
 * - `agent_mail_receipts`: body-free sender receipts keyed by (sender, client message id), with no link to message
 *   rows, so a retry replays its original acceptance after the recipient or the message is gone.
 */
const V15 = `
CREATE TABLE agent_mail_endpoints (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','suspended','deleting','deleted')),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  human_seen_seq INTEGER NOT NULL DEFAULT 0 CHECK (human_seen_seq >= 0 AND human_seen_seq <= last_seq),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleting_at TEXT,
  deleted_at TEXT,
  UNIQUE (machine_id, chat_id)
);

CREATE TABLE agent_mail_bindings (
  grant_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id),
  machine_id TEXT NOT NULL,
  canonical_folder TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('replaced','suspended','deleted','grant_ended')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX agent_mail_bindings_one_open ON agent_mail_bindings(endpoint_id) WHERE closed_at IS NULL;

CREATE TABLE agent_mail_messages (
  id TEXT PRIMARY KEY,
  recipient_endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id),
  recipient_seq INTEGER NOT NULL CHECK (recipient_seq >= 1),
  sender_endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id),
  client_message_id TEXT NOT NULL,
  in_reply_to TEXT,
  body TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes BETWEEN 1 AND 16384),
  accepted_at TEXT NOT NULL,
  acked_at TEXT,
  expires_at TEXT,
  CHECK ((acked_at IS NULL) = (expires_at IS NULL)),
  UNIQUE (recipient_endpoint_id, recipient_seq)
);
CREATE INDEX agent_mail_messages_pending ON agent_mail_messages(recipient_endpoint_id, recipient_seq) WHERE acked_at IS NULL;
CREATE INDEX agent_mail_messages_expiry ON agent_mail_messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX agent_mail_messages_retained ON agent_mail_messages(recipient_endpoint_id, expires_at, acked_at);

CREATE TABLE agent_mail_receipts (
  sender_endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id),
  client_message_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (sender_endpoint_id, client_message_id)
);
CREATE INDEX agent_mail_receipts_sender_expiry ON agent_mail_receipts(sender_endpoint_id, expires_at);
CREATE INDEX agent_mail_receipts_expiry ON agent_mail_receipts(expires_at);
`

/**
 * v16 adds what authorized agent mail (`services/agentMail.ts`) keeps beside the v15 store, local-only like it:
 *
 * - `agent_mail_wakes`: one row per endpoint holding its one-shot, non-accumulating wake credit. Only the person's
 *   desktop arms it (`armed`, with the endpoint-scoped `request_nonce` of the arming request); an agent can only
 *   consume it. `revision` moves on every arm and every consumption, so a delayed arming request that names an old
 *   revision never mints a second credit. `attempt_id`/`attempted_at` record the last consumption: an attempt to
 *   wake the chat, never a delivery or read receipt.
 * - `agent_mail_poll_sessions`: the one dedicated `sessions` row each (endpoint, grant) reuses for its restricted
 *   status/wake polls, so polling never grows the sessions table. Such a session is never referenced by activity.
 */
const V16 = `
CREATE TABLE agent_mail_wakes (
  endpoint_id TEXT PRIMARY KEY REFERENCES agent_mail_endpoints(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  armed INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0, 1)),
  request_nonce TEXT,
  armed_at TEXT,
  attempt_id TEXT,
  attempted_at TEXT,
  CHECK (armed = 0 OR (request_nonce IS NOT NULL AND armed_at IS NOT NULL)),
  CHECK ((attempt_id IS NULL) = (attempted_at IS NULL))
);

CREATE TABLE agent_mail_poll_sessions (
  endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id),
  grant_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (endpoint_id, grant_id)
);
`

/**
 * v17 adds the metric observation ledger: one immutable row per SPACE observation (`observation_json`, the contract
 * record as stored), with its scope ids, metric, source kind and measurement state copied into columns for lookups.
 * `payload_hash` is the observation's identity without the server's `recorded_at`, so a repeated delivery is
 * recognized and a changed payload under the same id is refused. No existing table or record changes. The outbox
 * and sync state gain the `metric_observation` kind; both tables are rebuilt the way v14 rebuilt them, keeping every
 * row, id and the outbox id sequence.
 */
const V17 = `
CREATE TABLE metric_observations (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('project','epic','sprint','run','ticket','attempt')),
  epic_id TEXT REFERENCES epics(id),
  sprint_id TEXT,
  run_id TEXT REFERENCES runs(id),
  ticket_id TEXT,
  attempt_id TEXT REFERENCES attempts(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('human','server','host','agent')),
  measurement_state TEXT NOT NULL CHECK (measurement_state IN ('observed','estimated','missing')),
  recorded_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  observation_json TEXT NOT NULL
);
CREATE INDEX metric_observations_epic ON metric_observations(epic_id, recorded_at, id);
CREATE INDEX metric_observations_run ON metric_observations(run_id, recorded_at, id);
CREATE INDEX metric_observations_attempt ON metric_observations(attempt_id);

CREATE TABLE outbox_v17 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history','comment','profile','kanban_card','kanban_event','attachment','metric_observation')),
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
INSERT INTO outbox_v17 (id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at)
  SELECT id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at FROM outbox;
DELETE FROM sqlite_sequence WHERE name = 'outbox_v17';
INSERT INTO sqlite_sequence (name, seq) SELECT 'outbox_v17', seq FROM sqlite_sequence WHERE name = 'outbox';
DROP TABLE outbox;
ALTER TABLE outbox_v17 RENAME TO outbox;
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state_v17 (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run','comment','profile','kanban_card','kanban_event','attachment','metric_observation')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
INSERT INTO sync_state_v17 (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
  SELECT kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at FROM sync_state;
DROP TABLE sync_state;
ALTER TABLE sync_state_v17 RENAME TO sync_state;
`

/**
 * v18 freezes a SPACE scorecard with each sprint report revision (`scorecard_json`): the sprint's, run's and epic's
 * grades and every ticket grade of the sprint, computed once when the report was submitted, as canonical JSON. It is
 * never recomputed or rewritten, and it is exported with the run history (unlike `revision_id`), so a snapshot reads
 * byte for byte the same on every machine. NULL for every report before this version: such a report stays ungraded.
 */
const V18 = `
ALTER TABLE sprint_reports ADD COLUMN scorecard_json TEXT;
`

/**
 * v19 stores the later events of retro experiments (`ExperimentEvent`, see `src/shared/domain/experiments.ts`): one
 * immutable row per status or result, never inside the report whose retro defines the experiment, so recording one
 * never changes an approved report's content, hash or scorecard. `number` counts an experiment's events 1, 2, 3, … as
 * recorded (two in the same millisecond keep their order); `event_json` is the event as exported with the run history.
 */
const V19 = `
CREATE TABLE experiment_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  experiment_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (experiment_id, number)
);
CREATE INDEX experiment_events_run ON experiment_events(run_id, experiment_id, number);
`

/**
 * v20 keeps the receipts of corrective work this project's retros asked of another project (the Dark Mechanicus
 * source; `src/core/services/crossRepoCorrections.ts`): one row per experiment and target project (`key`), written
 * `pending` with the fully specified draft (`packet_json`) before anything is written to the target, and `linked`
 * with the target's epic and tickets (`target_json`) once the target holds them. A pending row is the outbox a retry
 * finishes. A linked row keeps what it last brought back from the target epic for measuring the experiment
 * (`evidence_json`: its sealed scorecards, scope starts, corrective tickets and planned sizes). Identities, hashes and
 * plan text only, never a machine path. A local fact like the idempotency cache: not exported, and deleted with the
 * source epic.
 */
const V20 = `
CREATE TABLE correction_links (
  key TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  source_epic_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','linked')),
  target_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  linked_at TEXT,
  evidence_json TEXT
);
CREATE INDEX correction_links_experiment ON correction_links(experiment_id);
CREATE INDEX correction_links_epic ON correction_links(source_epic_id);
`

/**
 * v21 indexes the metric observation ledger by server time (`recorded_at`, then id): the id allocator looks up the
 * highest id recorded at one instant, and unfiltered observation lists read in that order. No row changes.
 */
const V21 = `
CREATE INDEX metric_observations_recorded ON metric_observations(recorded_at, id);
`

/**
 * v22 lets a Kanban message event own its attached images independently of the card definition and card attempts.
 * SQLite cannot alter the owner-kind CHECK constraint, so the table is rebuilt without changing any row.
 */
const V22 = `
CREATE TABLE attachments_v22 (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  width INTEGER NOT NULL CHECK (width >= 1),
  height INTEGER NOT NULL CHECK (height >= 1),
  label TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('evidence','reference')),
  owner_kind TEXT CHECK (owner_kind IN ('attempt','kanban_attempt','kanban_message','comment','kanban_card','ticket')),
  owner_id TEXT,
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0,1)),
  data BLOB,
  created_by_role TEXT NOT NULL,
  created_by_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((owner_kind IS NULL) = (owner_id IS NULL))
);
INSERT INTO attachments_v22
  SELECT id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
    created_by_role, created_by_label, created_at
  FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_v22 RENAME TO attachments;
CREATE INDEX attachments_owner ON attachments(owner_kind, owner_id);
`

/** Local elevation state is never portable; its audit is append-only and survives revocation. */
const V23 = `
CREATE TABLE yolo_chat_bindings (
  grant_id TEXT PRIMARY KEY REFERENCES grants(id),
  chat_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  desktop_id TEXT NOT NULL,
  desktop_pid INTEGER NOT NULL,
  fence_path TEXT NOT NULL,
  proof_endpoint TEXT NOT NULL,
  proof_public_key TEXT NOT NULL,
  folder TEXT NOT NULL,
  card_id TEXT
);
CREATE TABLE yolo_elevations (
  grant_id TEXT PRIMARY KEY REFERENCES grants(id),
  chat_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  desktop_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  run_id TEXT,
  card_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE yolo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  run_id TEXT,
  capability TEXT NOT NULL,
  command TEXT NOT NULL,
  result TEXT NOT NULL,
  target_id TEXT,
  card_id TEXT
);
CREATE TRIGGER yolo_audit_no_update BEFORE UPDATE ON yolo_audit BEGIN SELECT RAISE(ABORT, 'YOLO audit is append-only'); END;
CREATE TRIGGER yolo_audit_no_delete BEFORE DELETE ON yolo_audit BEGIN SELECT RAISE(ABORT, 'YOLO audit is append-only'); END;
CREATE INDEX yolo_audit_run ON yolo_audit(run_id, id);
`

const V24 = `
ALTER TABLE sessions ADD COLUMN launch_capabilities_json TEXT NOT NULL DEFAULT '[]';
UPDATE sessions SET launch_capabilities_json = capabilities_json;
CREATE TABLE save_permission_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  grant_id TEXT REFERENCES grants(id),
  machine_id TEXT NOT NULL,
  requester_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_session_id TEXT REFERENCES sessions(id),
  decision_reason TEXT
);
CREATE INDEX save_permission_grant ON save_permission_requests(grant_id, status);
CREATE INDEX save_permission_session ON save_permission_requests(session_id, status);
`

/** Machine-local, incident-scoped workflow interruption; no portable plan or claim is rewritten. */
const V25 = `
CREATE TABLE tooling_chat_grants (
  grant_id TEXT PRIMARY KEY REFERENCES grants(id),
  chat_id TEXT NOT NULL
);
CREATE TABLE tooling_holds (
  chat_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  run_id TEXT,
  card_id TEXT,
  held_at TEXT NOT NULL,
  previous_run_state TEXT
);
CREATE TABLE tooling_held_attempts (
  incident_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (incident_id, attempt_id, kind)
);
CREATE TABLE tooling_lease_returns (
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  ms INTEGER NOT NULL
);
`

/** Return time from retired holds once per still-open lease, then remove the workflow gate. */
function retireToolingHolds(db: Db): void {
  const now = new Date().toISOString()
  for (const [kind, table] of [['run', 'attempts'], ['card', 'kanban_attempts']] as const) {
    const attempts = db.all<{ id: string; held_at: string; granted_at: string; lease_expires_at: string }>(
      `SELECT a.id, MIN(h.held_at) AS held_at, COALESCE(a.heartbeat_at, a.created_at) AS granted_at, a.lease_expires_at
       FROM tooling_held_attempts t JOIN tooling_holds h ON h.incident_id = t.incident_id
       JOIN ${table} a ON a.id = t.attempt_id
       WHERE t.kind = ? AND a.state IN ('claimed', 'running') AND a.lease_expires_at IS NOT NULL
       GROUP BY a.id`, kind)
    for (const attempt of attempts) {
      const ms = Date.parse(now) - Math.max(Date.parse(attempt.held_at), Date.parse(attempt.granted_at))
      if (ms <= 0) continue
      const expires = new Date(Date.parse(attempt.lease_expires_at) + ms).toISOString()
      db.run(`UPDATE ${table} SET lease_expires_at = ? WHERE id = ?`, expires, attempt.id)
      db.run('INSERT INTO tooling_lease_returns(attempt_id, kind, at, granted_at, ms) VALUES (?, ?, ?, ?, ?)',
        attempt.id, kind, now, attempt.granted_at, ms)
    }
  }
  db.run(`WITH prior AS (
      SELECT r.id, (SELECT h.previous_run_state FROM tooling_holds h
        WHERE h.run_id = r.id AND h.previous_run_state IN ('queued', 'running', 'awaiting_checkpoint')
        ORDER BY h.held_at, h.chat_id LIMIT 1) AS state
      FROM runs r WHERE r.state = 'paused' AND r.pause_reason = 'tooling_recovery'
    )
    UPDATE runs SET state = COALESCE(prior.state, 'paused'), pause_reason = NULL,
      paused_at = CASE WHEN prior.state IS NULL THEN runs.paused_at END, updated_at = ?, revision = revision + 1
    FROM prior WHERE runs.id = prior.id`, now)
  db.exec(`DROP TABLE tooling_held_attempts;
    DROP TABLE tooling_holds;
    DROP TABLE tooling_chat_grants;
    ALTER TABLE tooling_lease_returns RENAME TO legacy_tooling_lease_credits;`)
}

/**
 * v31 stores the learning loop: published learning records (`src/shared/domain/learnings.ts`), the one generated
 * learning card of each run and sprint, and the recoverable integration that publishes an approved card's records.
 * It only adds tables, so no existing row, Kanban or run record (or its content hash) changes. Sources are kept by id
 * without foreign keys, as plans and imported records may arrive in any order; a record's definition and source are
 * immutable, only its lifecycle columns change, and a replacement chain can never close on itself.
 */
const V31 = `
CREATE TABLE learning_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL CHECK (definition_hash GLOB 'sha256:*'),
  state TEXT NOT NULL CHECK (state IN ('active','retired')),
  replaces_id TEXT REFERENCES learning_records(id),
  replaced_by_id TEXT REFERENCES learning_records(id),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  CHECK (replaces_id IS NULL OR replaces_id <> id),
  CHECK (replaced_by_id IS NULL OR replaced_by_id <> id),
  CHECK (state <> 'active' OR (retired_at IS NULL AND retired_reason IS NULL AND replaced_by_id IS NULL)),
  CHECK (state <> 'retired' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX learning_records_replaced_once ON learning_records(replaces_id) WHERE replaces_id IS NOT NULL;
CREATE INDEX learning_records_state ON learning_records(state, created_at, id);
CREATE INDEX learning_records_source ON learning_records(run_id, sprint_id, card_id);
CREATE TRIGGER learning_records_immutable BEFORE UPDATE OF id, run_id, sprint_id, card_id, attempt_id, definition_json,
  definition_hash, replaces_id, created_at ON learning_records
BEGIN SELECT RAISE(ABORT, 'A learning record''s definition and source are immutable'); END;
CREATE TRIGGER learning_records_no_cycle BEFORE INSERT ON learning_records WHEN NEW.replaces_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'A learning replacement chain cannot form a cycle')
  WHERE EXISTS (
    WITH RECURSIVE chain(id) AS (
      SELECT NEW.replaces_id
      UNION SELECT r.replaces_id FROM learning_records r JOIN chain ON r.id = chain.id WHERE r.replaces_id IS NOT NULL
    ) SELECT 1 FROM chain WHERE id = NEW.id
  );
END;

CREATE TABLE sprint_learning_cards (
  card_id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash GLOB 'sha256:*'),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sprint_id)
);

CREATE TABLE learning_integrations (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','integrating','integrated','published','conflicted','aborted')),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash GLOB 'sha256:*'),
  failure_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX learning_integrations_one_open_per_card ON learning_integrations(card_id)
  WHERE state IN ('prepared','integrating','integrated');
`

/**
 * v32 adds the append-only history of human learning management. Each publication, retirement and replacement
 * appends one row per learning it touched, carrying who acted, why, the learning's revision afterwards and its
 * immutable source links; no row is ever updated or deleted. Only a table is added, so no existing row changes.
 */
const V32 = `
CREATE TABLE learning_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  learning_id TEXT NOT NULL REFERENCES learning_records(id),
  kind TEXT NOT NULL CHECK (kind IN ('published','retired','replaced','created_by_replacement')),
  related_id TEXT REFERENCES learning_records(id),
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_role TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  at TEXT NOT NULL,
  CHECK ((kind IN ('replaced','created_by_replacement')) = (related_id IS NOT NULL))
);
CREATE INDEX learning_events_learning ON learning_events(learning_id, seq);
CREATE TRIGGER learning_events_no_update BEFORE UPDATE ON learning_events
BEGIN SELECT RAISE(ABORT, 'Learning history is append-only'); END;
CREATE TRIGGER learning_events_no_delete BEFORE DELETE ON learning_events
BEGIN SELECT RAISE(ABORT, 'Learning history is append-only'); END;
`

/**
 * v33 adds the durable identity of learning publication. A sprint learning card's attempt stages its proposed drafts
 * with the evidence items they cite, quoted verbatim (`learning_stagings`, one row per attempt, replaceable only while
 * no publication exists for it). Publishing the approved attempt records which attempt, which exact drafts and which
 * records it created (`learning_publications`, one per attempt and one per card), so a replay never publishes twice.
 * A publication is never updated or deleted. No foreign key reaches Kanban tables, so card deletion is unchanged.
 */
const V33 = `
CREATE TABLE learning_stagings (
  attempt_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash GLOB 'sha256:*'),
  drafts_json TEXT NOT NULL,
  drafts_hash TEXT NOT NULL CHECK (drafts_hash GLOB 'sha256:*'),
  evidence_json TEXT NOT NULL,
  staged_by_role TEXT NOT NULL,
  staged_by_label TEXT NOT NULL,
  staged_at TEXT NOT NULL
);
CREATE TABLE learning_publications (
  attempt_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  sprint_id TEXT NOT NULL,
  drafts_hash TEXT NOT NULL CHECK (drafts_hash GLOB 'sha256:*'),
  evidence_json TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  published_by_role TEXT NOT NULL,
  published_by_label TEXT NOT NULL,
  published_at TEXT NOT NULL
);
CREATE TRIGGER learning_stagings_frozen_update BEFORE UPDATE ON learning_stagings
  WHEN EXISTS (SELECT 1 FROM learning_publications p WHERE p.attempt_id = OLD.attempt_id)
BEGIN SELECT RAISE(ABORT, 'Published learning drafts are immutable'); END;
CREATE TRIGGER learning_stagings_frozen_delete BEFORE DELETE ON learning_stagings
  WHEN EXISTS (SELECT 1 FROM learning_publications p WHERE p.attempt_id = OLD.attempt_id)
BEGIN SELECT RAISE(ABORT, 'Published learning drafts are immutable'); END;
CREATE TRIGGER learning_publications_no_update BEFORE UPDATE ON learning_publications
BEGIN SELECT RAISE(ABORT, 'A learning publication is immutable'); END;
CREATE TRIGGER learning_publications_no_delete BEFORE DELETE ON learning_publications
BEGIN SELECT RAISE(ABORT, 'A learning publication is immutable'); END;
`

/**
 * v34 (DM-937) completes the link of a generated sprint learning card. Advancing a checkpoint writes, with the card,
 * the checkpoint it followed, the run's pinned revision, the exact evidence snapshot (`snapshot_json`, whose hash is
 * `evidence_hash`) and the completed increment of every affected repository (`bases_json`). Columns are only added,
 * so no existing row changes; once written, the link never changes.
 */
const V34 = `
ALTER TABLE sprint_learning_cards ADD COLUMN checkpoint_id TEXT;
ALTER TABLE sprint_learning_cards ADD COLUMN revision_id TEXT;
ALTER TABLE sprint_learning_cards ADD COLUMN snapshot_json TEXT;
ALTER TABLE sprint_learning_cards ADD COLUMN bases_json TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER sprint_learning_cards_immutable BEFORE UPDATE ON sprint_learning_cards
BEGIN SELECT RAISE(ABORT, 'A sprint learning card link is immutable'); END;
`

// ─── DM-935: v35 learning record kinds in the outbox and sync state ────────────────────────────────────────────────
/**
 * v35 lets the outbox and sync state carry learning records (`learning_record`: a learning with its append-only
 * history) and learning integration recovery manifests (`learning_integration`), so both are exported to and
 * reconciled from portable files like every other record. SQLite cannot alter a CHECK constraint, so both tables are
 * rebuilt the way v17 rebuilt them, keeping every row, id, index, the outbox id sequence and v30's `next_attempt_at`.
 */
const V35 = `
CREATE TABLE outbox_v35 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','epic_state','run_history','comment','profile','kanban_card','kanban_event','attachment','metric_observation','learning_record','learning_integration')),
  epic_id TEXT,
  run_id TEXT,
  revision_id TEXT,
  entity_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  next_attempt_at TEXT
);
INSERT INTO outbox_v35 (id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at, next_attempt_at)
  SELECT id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at, done_at, next_attempt_at FROM outbox;
DELETE FROM sqlite_sequence WHERE name = 'outbox_v35';
INSERT INTO sqlite_sequence (name, seq) SELECT 'outbox_v35', seq FROM sqlite_sequence WHERE name = 'outbox';
DROP TABLE outbox;
ALTER TABLE outbox_v35 RENAME TO outbox;
CREATE INDEX outbox_state ON outbox(state, id);

CREATE TABLE sync_state_v35 (
  kind TEXT NOT NULL CHECK (kind IN ('epic','run','comment','profile','kanban_card','kanban_event','attachment','metric_observation','learning_record','learning_integration')),
  entity_id TEXT NOT NULL,
  exported_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  imported_hash TEXT,
  conflict TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
INSERT INTO sync_state_v35 (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
  SELECT kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at FROM sync_state;
DROP TABLE sync_state;
ALTER TABLE sync_state_v35 RENAME TO sync_state;
`
// ─── End DM-935 ───

// ─── DM-950: machine-local execution authority over learning integrations ─────────────────────────────────────────
/**
 * v36 records which machine may execute a learning integration. `owner_machine_id` is set only when this machine
 * prepared the integration itself; an imported integration, a changed import of a local one and every row that
 * existed before this version have none, so they are inert until a person re-prepares them. `superseded_by` names the
 * locally prepared integration that replaced an inert one. Both are local state: no portable file carries them.
 */
const V36 = `
ALTER TABLE learning_integrations ADD COLUMN owner_machine_id TEXT;
ALTER TABLE learning_integrations ADD COLUMN superseded_by TEXT;
`
// ─── End DM-950 ───

// ─── DM-835: sprint delivery checks ─────────────────────────────────────────
/**
 * v37 stores sprint delivery checks and person waivers, following v5's row checks. `number` counts a run's delivery
 * records in the order they were recorded. `verdict_json` holds `{checks, reasons, releaseVersion, installedVersion}`
 * for a check and `{reason}` for a waiver. Whether a record passed is derived on read, never stored. Exported with the
 * run history only when a run has any.
 */
const V37 = `
CREATE TABLE delivery_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  sprint_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check','waiver')),
  commit_ref TEXT,
  release_tag TEXT,
  verdict_json TEXT NOT NULL,
  recorded_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, number)
);
CREATE INDEX delivery_checks_run ON delivery_checks(run_id, sprint_id);
`
// ─── End DM-835 ───

// ─── DM-1047: trusted epic and role of agent mail endpoints ─────────────────────────────────────────
/**
 * v38 records, on each agent mail endpoint, the epic its chat is bound to and the chat's Dark Mechanicus role. Only
 * main writes them, from its own chat record (never from an agent), so peers can trust them, unlike the display
 * `name`. Both are nullable: rows that existed before this version, and chats with no epic binding, have none.
 */
const V38 = `
ALTER TABLE agent_mail_endpoints ADD COLUMN epic_id TEXT;
ALTER TABLE agent_mail_endpoints ADD COLUMN chat_role TEXT CHECK (chat_role IN ('planner','orchestrator','worker','reviewer'));
`
// ─── End DM-1047 ───

/**
 * v39 (DM-738): `run_save = 0` takes a grant out of the DM-900 run-ownership Save exception (`requireSaveAuthority`), so
 * it saves only with Allow save. Cult Magos grants are issued so; every other grant keeps the exception (default 1).
 */
const V39 = `
ALTER TABLE grants ADD COLUMN run_save INTEGER NOT NULL DEFAULT 1 CHECK (run_save IN (0, 1));
`

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
  { version: 7, sql: V7 },
  { version: 8, sql: V8 },
  { version: 9, sql: V9 },
  { version: 10, sql: '', data: scrubStoredResponses },
  { version: 11, sql: V11 },
  { version: 12, sql: V12 },
  { version: 13, sql: V13 },
  { version: 14, sql: V14 },
  { version: 15, sql: V15 },
  { version: 16, sql: V16 },
  { version: 17, sql: V17 },
  { version: 18, sql: V18 },
  { version: 19, sql: V19 },
  { version: 20, sql: V20 },
  { version: 21, sql: V21 },
  { version: 22, sql: V22 },
  { version: 23, sql: V23 },
  { version: 24, sql: V24 },
  { version: 25, sql: V25 },
  { version: 26, sql: `ALTER TABLE epics ADD COLUMN standards_json TEXT;
    ALTER TABLE kanban_cards ADD COLUMN standards_json TEXT;` },
  { version: 27, sql: `CREATE TABLE delivery_context_notices (
        endpoint_id TEXT NOT NULL REFERENCES agent_mail_endpoints(id) ON DELETE CASCADE,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        attempt_id TEXT,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY(endpoint_id,assignment_id,item_kind,item_id)
      );` },
  { version: 28, sql: `CREATE INDEX kanban_cards_open_lanes ON kanban_cards(lane)
        WHERE lane IN ('backlog', 'in_progress', 'ready_for_review');` },
  { version: 29, sql: '', data: retireToolingHolds },
  /** v30: when a failed outbox entry may be retried by an automatic flush (null: at once); an explicit flush ignores it. */
  { version: 30, sql: 'ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;' },
  { version: 31, sql: V31 },
  { version: 32, sql: V32 },
  { version: 33, sql: V33 },
  { version: 34, sql: V34 },
  { version: 35, sql: V35 },
  { version: 36, sql: V36 },
  { version: 37, sql: V37 },
  { version: 38, sql: V38 },
  { version: 39, sql: V39 }
]

export function readSchemaVersion(db: Db): number {
  return db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0
}

/**
 * Applies pending migrations under the write lock (BEGIN IMMEDIATE doubles as the migration lock).
 * A database written by a newer build is refused rather than migrated by competing clients. A database already at
 * the target version is only checked, without taking the write lock: every open, each mailbox poll included, does it.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): { from: number; to: number } {
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  if (readSchemaVersion(db) === target) {
    return { from: target, to: target }
  }
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
        migration.data?.(db)
      }
    }
    if (target !== from) {
      db.exec(`PRAGMA user_version = ${target}`)
    }
    return { from, to: target }
  })
}
