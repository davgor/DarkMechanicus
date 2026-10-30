import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { migrate } from '../../core/db/migrations'
import { createAgentRegistry, type AgentConnection } from './agentRegistry'
import { APP_MIGRATIONS } from './appDatabase'

function appDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db, APP_MIGRATIONS)
  return db
}

function counterNow(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
}

function connection(kind: AgentConnection['kind'], overrides: Partial<AgentConnection> = {}): AgentConnection {
  return { kind, executablePath: `/bin/${kind}`, version: '1.0.0', connectedVia: 'found', ...overrides }
}

interface AgentRow {
  id: string
  kind: string
  protocol: string
  display_name: string
  args_json: string
}

describe('createAgentRegistry listing', () => {
  it('returns an empty list for an empty table', () => {
    expect(createAgentRegistry({ db: appDb() }).list()).toEqual([])
  })

  it('reads agents already in the table, in insertion order', () => {
    const db = appDb()
    const first = createAgentRegistry({ db, now: counterNow() })
    first.upsert(connection('codex'))
    first.upsert(connection('claude'))

    const reopened = createAgentRegistry({ db })
    expect(reopened.list().map((agent) => agent.kind)).toEqual(['codex', 'claude'])
  })
})

describe('createAgentRegistry upsert', () => {
  it('adds an entry for a new kind and returns its view', () => {
    const registry = createAgentRegistry({ db: appDb(), now: () => '2026-01-01T00:00:00.000Z' })

    const view = registry.upsert(connection('claude'))

    expect(view).toEqual({
      id: 'claude',
      kind: 'claude',
      protocol: 'claude',
      displayName: 'Claude Code',
      args: [],
      executablePath: '/bin/claude',
      version: '1.0.0',
      connectedVia: 'found',
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastProbed: '2026-01-01T00:00:00.000Z'
    })
    expect(registry.list()).toEqual([view])
  })

  it('writes the built-in identity columns from the kind', () => {
    const db = appDb()
    const registry = createAgentRegistry({ db })
    registry.upsert(connection('claude'))
    registry.upsert(connection('codex'))
    registry.upsert(connection('cursor'))

    expect(db.all<AgentRow>('SELECT id, kind, protocol, display_name, args_json FROM agents ORDER BY rowid')).toEqual([
      { id: 'claude', kind: 'claude', protocol: 'claude', display_name: 'Claude Code', args_json: '[]' },
      { id: 'codex', kind: 'codex', protocol: 'codex', display_name: 'Codex', args_json: '[]' },
      { id: 'cursor', kind: 'cursor', protocol: 'acp', display_name: 'Cursor', args_json: '[]' }
    ])
  })

  it('replaces the entry for the same kind, keeping its position and other kinds', () => {
    const registry = createAgentRegistry({ db: appDb(), now: counterNow() })
    registry.upsert(connection('claude'))
    registry.upsert(connection('codex'))

    registry.upsert(connection('claude', { executablePath: '/opt/claude', version: null, connectedVia: 'downloaded' }))

    const agents = registry.list()
    expect(agents.map((agent) => agent.kind)).toEqual(['claude', 'codex'])
    expect(agents[0]).toMatchObject({ executablePath: '/opt/claude', version: null, connectedVia: 'downloaded' })
    expect(agents[1]).toMatchObject({ executablePath: '/bin/codex' })
  })

  it('keeps connectedAt and refreshes lastProbed on replacement', () => {
    const registry = createAgentRegistry({ db: appDb(), now: counterNow() })
    const first = registry.upsert(connection('codex'))

    const second = registry.upsert(connection('codex', { version: '2.0.0' }))

    expect(second.connectedAt).toBe(first.connectedAt)
    expect(second.lastProbed).not.toBe(first.lastProbed)
    expect(registry.list()).toEqual([second])
  })
})

describe('createAgentRegistry remove', () => {
  it('drops only the entry for that kind', () => {
    const registry = createAgentRegistry({ db: appDb() })
    registry.upsert(connection('claude'))
    registry.upsert(connection('codex'))

    registry.remove('claude')

    expect(registry.list().map((agent) => agent.kind)).toEqual(['codex'])
  })

  it('is a no-op for a kind that is not connected', () => {
    const registry = createAgentRegistry({ db: appDb() })
    registry.upsert(connection('codex'))

    registry.remove('cursor')

    expect(registry.list().map((agent) => agent.kind)).toEqual(['codex'])
  })
})
