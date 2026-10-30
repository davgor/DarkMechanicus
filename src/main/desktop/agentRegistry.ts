/**
 * Machine-local registry of connected agents, stored in the `agents` table of the app database.
 * One row per agent id. A built-in agent's (`claude`, `codex`, or `cursor`) id is its kind; a custom
 * agent's is `cu_` and a ULID, with its own protocol, display name and arguments.
 */
import type { Db } from '../../core/db/database'
import { AGENT_DEFINITIONS } from '../../shared/desktop/agentKinds'
import type { AgentId, AgentProtocol, AgentView, BuiltInAgentKind } from '../../shared/desktop/api'

/** A built-in agent's own fields; its id, protocol, display name and (empty) arguments follow from its kind. */
type BuiltInAgentEntry = Pick<AgentView, 'executablePath' | 'version' | 'connectedVia' | 'connectedAt' | 'lastProbed'> & {
  kind: BuiltInAgentKind
}

/** What a caller supplies when connecting a built-in agent; the registry stamps the timestamps. */
export type AgentConnection = Omit<BuiltInAgentEntry, 'connectedAt' | 'lastProbed'>

/** What a caller supplies when adding a custom agent; the registry stamps the timestamps. */
export interface CustomAgentEntry {
  /** `cu_` and a ULID. */
  id: AgentId
  protocol: AgentProtocol
  displayName: string
  executablePath: string
  args: readonly string[]
  version: string | null
}

/** What an edit may change of a custom agent: never its id or its protocol. */
type CustomAgentChange = Pick<CustomAgentEntry, 'displayName' | 'executablePath' | 'args' | 'version'>

export interface AgentRegistry {
  /** Connected agents in insertion order, at most one per id. */
  list(): AgentView[]
  /** The connected agent with this id, or null. */
  get(id: AgentId): AgentView | null
  /** Replaces the entry for the built-in agent's kind, or adds one; `connectedAt` survives a replacement. */
  upsert(agent: AgentConnection): AgentView
  /** Removes only the registry entry for an id (never uninstalls the CLI or touches the executable). */
  remove(id: AgentId): void
  /** Inserts a custom agent row (kind and `connected_via` `custom`); throws when the id is taken. */
  addCustom(agent: CustomAgentEntry): AgentView
  /** Changes a custom agent's row in place, refreshing `lastProbed`; null when no custom agent has the id. */
  updateCustom(id: AgentId, change: CustomAgentChange): AgentView | null
}

const PROTOCOL_BY_KIND: Readonly<Record<BuiltInAgentKind, AgentProtocol>> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'acp',
  autonomous: 'acp'
}

interface AgentRow {
  id: AgentId
  kind: AgentView['kind']
  protocol: AgentProtocol
  display_name: string
  executable_path: string
  args_json: string
  version: string | null
  connected_via: AgentView['connectedVia']
  connected_at: string
  last_probed: string
}

const SELECT_AGENTS = `SELECT id, kind, protocol, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed FROM agents`

function toView(row: AgentRow): AgentView {
  return {
    id: row.id,
    kind: row.kind,
    protocol: row.protocol,
    displayName: row.display_name,
    executablePath: row.executable_path,
    args: JSON.parse(row.args_json) as string[],
    version: row.version,
    connectedVia: row.connected_via,
    connectedAt: row.connected_at,
    lastProbed: row.last_probed
  }
}

/**
 * Inserts a built-in agent row, or (when `replace`) updates the row of that kind in place, keeping
 * `connected_at` and its position. Shared with the legacy importer so both write identical rows.
 */
export function writeBuiltInAgent(db: Db, agent: BuiltInAgentEntry, replace: boolean): void {
  const conflict = replace
    ? `DO UPDATE SET executable_path = excluded.executable_path, version = excluded.version,
       connected_via = excluded.connected_via, last_probed = excluded.last_probed`
    : 'DO NOTHING'
  db.run(
    `INSERT INTO agents (id, kind, protocol, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
     ON CONFLICT (id) ${conflict}`,
    agent.kind,
    agent.kind,
    PROTOCOL_BY_KIND[agent.kind],
    AGENT_DEFINITIONS[agent.kind].displayName,
    agent.executablePath,
    agent.version,
    agent.connectedVia,
    agent.connectedAt,
    agent.lastProbed
  )
}

function getAgent(db: Db, id: AgentId): AgentView | null {
  const row = db.get<AgentRow>(`${SELECT_AGENTS} WHERE id = ?`, id)
  return row === undefined ? null : toView(row)
}

function insertCustomAgent(db: Db, agent: CustomAgentEntry, stamp: string): AgentView {
  db.run(
    `INSERT INTO agents (id, kind, protocol, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed)
     VALUES (?, 'custom', ?, ?, ?, ?, ?, 'custom', ?, ?)`,
    agent.id,
    agent.protocol,
    agent.displayName,
    agent.executablePath,
    JSON.stringify(agent.args),
    agent.version,
    stamp,
    stamp
  )
  const view = getAgent(db, agent.id)
  if (view === null) {
    throw new Error(`agent row ${agent.id} vanished after insert`)
  }
  return view
}

/** Only a custom row is changed, and never its id, kind, protocol or connected_at. */
function updateCustomAgent(db: Db, id: AgentId, change: CustomAgentChange, stamp: string): AgentView | null {
  db.run(
    `UPDATE agents SET display_name = ?, executable_path = ?, args_json = ?, version = ?, last_probed = ?
     WHERE id = ? AND kind = 'custom'`,
    change.displayName,
    change.executablePath,
    JSON.stringify(change.args),
    change.version,
    stamp,
    id
  )
  const view = getAgent(db, id)
  return view?.kind === 'custom' ? view : null
}

export function createAgentRegistry(options: {
  db: Db
  /** ISO timestamp source for `connectedAt` and `lastProbed`. */
  now?: () => string
}): AgentRegistry {
  const { db } = options
  const now = options.now ?? (() => new Date().toISOString())
  return {
    list: () => db.all<AgentRow>(`${SELECT_AGENTS} ORDER BY rowid`).map((row) => toView(row)),
    get: (id) => getAgent(db, id),
    upsert: (agent) => {
      const stamp = now()
      // One statement: a replacement keeps connected_at and refreshes last_probed.
      writeBuiltInAgent(db, { ...agent, connectedAt: stamp, lastProbed: stamp }, true)
      const view = getAgent(db, agent.kind)
      if (view === null) {
        throw new Error(`agent row ${agent.kind} vanished after upsert`)
      }
      return view
    },
    remove: (id) => {
      db.run('DELETE FROM agents WHERE id = ?', id)
    },
    addCustom: (agent) => insertCustomAgent(db, agent, now()),
    updateCustom: (id, change) => updateCustomAgent(db, id, change, now())
  }
}
