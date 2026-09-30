import { describe, expect, it } from 'vitest'
import type { SessionRole } from '../../shared/domain/views'
import { createSequentialIds, createTestClock, createTestDb, type TestClock } from '../../test/testContext'
import { capabilitiesForRole } from '../authz'
import type { Db } from '../db/database'
import type { IdGenerator } from '../ids'
import {
  endSession,
  listSessions,
  registerSession,
  SESSION_ACTIVE_WINDOW_MS,
  sessionCapabilities,
  summarizeActiveSessions,
  touchSession
} from './sessions'

interface Fixture {
  db: Db
  clock: TestClock
  ids: IdGenerator
  deps: { db: Db; clock: TestClock; ids: IdGenerator }
}

function fixture(): Fixture {
  const db = createTestDb()
  const clock = createTestClock()
  const ids = createSequentialIds()
  return { db, clock, ids, deps: { db, clock, ids } }
}

function register(fx: Fixture, role: SessionRole = 'worker', pid: number | null = 4242): string {
  return registerSession(fx.deps, {
    role,
    label: `${role} label`,
    transport: 'stdio',
    pid,
    capabilities: capabilitiesForRole(role)
  }).id
}

function rawSession(fx: Fixture, id: string): { ended_at: string | null; last_seen_at: string } | undefined {
  return fx.db.get('SELECT ended_at, last_seen_at FROM sessions WHERE id = ?', id)
}

describe('registerSession', () => {
  it('returns the session context with a generated id and a capability set', () => {
    const fx = fixture()
    const session = registerSession(fx.deps, {
      role: 'reviewer',
      label: 'review bot',
      transport: 'stdio',
      pid: 7,
      capabilities: ['read', 'attempt.review']
    })
    expect(session.id).toBe('ss_00000000000000000000000001')
    expect(session.role).toBe('reviewer')
    expect(session.label).toBe('review bot')
    expect(session.capabilities).toBeInstanceOf(Set)
    expect([...session.capabilities].sort()).toEqual(['attempt.review', 'read'])
  })

  it('persists the registration', () => {
    const fx = fixture()
    fx.clock.set('2026-03-01T10:00:00.000Z')
    const id = register(fx, 'orchestrator', 99)
    expect(listSessions(fx.deps)).toEqual([
      {
        id,
        role: 'orchestrator',
        label: 'orchestrator label',
        transport: 'stdio',
        pid: 99,
        startedAt: '2026-03-01T10:00:00.000Z',
        lastSeenAt: '2026-03-01T10:00:00.000Z',
        active: true
      }
    ])
  })

})

describe('registerSession storage', () => {
  it('stores a missing pid as null and issues distinct ids', () => {
    const fx = fixture()
    const first = register(fx, 'desktop', null)
    const second = register(fx, 'desktop', null)
    expect(first).not.toBe(second)
    expect(listSessions(fx.deps).map((view) => view.pid)).toEqual([null, null])
  })

  it('stores hostile labels verbatim', () => {
    const fx = fixture()
    const label = `x'); DROP TABLE sessions; --`
    registerSession(fx.deps, { role: 'worker', label, transport: 'stdio', pid: null, capabilities: [] })
    expect(listSessions(fx.deps).map((view) => view.label)).toEqual([label])
  })

  it('stores capabilities so they can be read back', () => {
    const fx = fixture()
    const id = register(fx, 'worker')
    const row = fx.db.get<{ capabilities_json: string }>('SELECT capabilities_json FROM sessions WHERE id = ?', id)
    expect(sessionCapabilities(row ?? { capabilities_json: '' })).toEqual(capabilitiesForRole('worker'))
  })
})

describe('sessionCapabilities', () => {
  it('parses the stored JSON array', () => {
    expect(sessionCapabilities({ capabilities_json: '["read","plan.save"]' })).toEqual(['read', 'plan.save'])
    expect(sessionCapabilities({ capabilities_json: '[]' })).toEqual([])
  })

  it('falls back to no capabilities for empty text', () => {
    expect(sessionCapabilities({ capabilities_json: '' })).toEqual([])
  })
})

describe('touchSession and endSession', () => {
  it('touch moves lastSeenAt forward but not startedAt', () => {
    const fx = fixture()
    register(fx)
    fx.clock.advanceSeconds(10)
    touchSession(fx.deps, 'ss_00000000000000000000000001')
    const [view] = listSessions(fx.deps)
    expect(view?.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(view?.lastSeenAt).toBe('2026-01-01T00:00:10.000Z')
  })

  it('touch only affects the named session and ignores unknown ids', () => {
    const fx = fixture()
    const first = register(fx)
    const second = register(fx)
    fx.clock.advanceSeconds(5)
    touchSession(fx.deps, first)
    touchSession(fx.deps, 'ss_unknown')
    expect(rawSession(fx, first)?.last_seen_at).toBe('2026-01-01T00:00:05.000Z')
    expect(rawSession(fx, second)?.last_seen_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('end deactivates the session immediately', () => {
    const fx = fixture()
    const id = register(fx)
    expect(listSessions(fx.deps)[0]?.active).toBe(true)
    endSession(fx.deps, id)
    expect(listSessions(fx.deps)[0]?.active).toBe(false)
    expect(rawSession(fx, id)?.ended_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps the first end time when ended twice and ignores unknown ids', () => {
    const fx = fixture()
    const id = register(fx)
    const other = register(fx)
    endSession(fx.deps, id)
    fx.clock.advanceSeconds(30)
    endSession(fx.deps, id)
    endSession(fx.deps, 'ss_unknown')
    expect(rawSession(fx, id)?.ended_at).toBe('2026-01-01T00:00:00.000Z')
    expect(rawSession(fx, other)?.ended_at).toBeNull()
  })
})

describe('listSessions', () => {
  it('lists the newest session first', () => {
    const fx = fixture()
    const ids: string[] = []
    for (const role of ['desktop', 'planner', 'worker'] as const) {
      ids.push(register(fx, role))
      fx.clock.advanceSeconds(1)
    }
    expect(listSessions(fx.deps).map((view) => view.id)).toEqual([...ids].reverse())
  })

  it('limits the result, defaulting to 50', () => {
    const fx = fixture()
    for (let index = 0; index < 51; index += 1) {
      register(fx)
    }
    expect(listSessions(fx.deps)).toHaveLength(50)
    expect(listSessions(fx.deps, 3)).toHaveLength(3)
    expect(listSessions(fx.deps, 100)).toHaveLength(51)
  })

  it('returns nothing when no session registered', () => {
    expect(listSessions(fixture().deps)).toEqual([])
  })
})

describe('session activity window', () => {
  it('pins the window to sixty seconds', () => {
    expect(SESSION_ACTIVE_WINDOW_MS).toBe(60_000)
  })

  it('is active immediately and up to and including exactly 60 seconds', () => {
    const fx = fixture()
    register(fx)
    expect(listSessions(fx.deps)[0]?.active).toBe(true)
    fx.clock.set('2026-01-01T00:00:59.999Z')
    expect(listSessions(fx.deps)[0]?.active).toBe(true)
    fx.clock.set('2026-01-01T00:01:00.000Z')
    expect(listSessions(fx.deps)[0]?.active).toBe(true)
  })

  it('is inactive from 60.001 seconds after the last heartbeat', () => {
    const fx = fixture()
    register(fx)
    fx.clock.set('2026-01-01T00:01:00.001Z')
    expect(listSessions(fx.deps)[0]?.active).toBe(false)
  })

  it('is measured from the last touch, not from registration', () => {
    const fx = fixture()
    const id = register(fx)
    fx.clock.advanceSeconds(50)
    touchSession(fx.deps, id)
    fx.clock.advanceSeconds(60)
    expect(listSessions(fx.deps)[0]?.active).toBe(true)
    fx.clock.advanceSeconds(1)
    expect(listSessions(fx.deps)[0]?.active).toBe(false)
  })

  it('never counts an ended session as active', () => {
    const fx = fixture()
    const id = register(fx)
    touchSession(fx.deps, id)
    endSession(fx.deps, id)
    touchSession(fx.deps, id)
    expect(listSessions(fx.deps)[0]?.active).toBe(false)
  })
})

describe('summarizeActiveSessions', () => {
  it('reports no activity when there are no sessions', () => {
    expect(summarizeActiveSessions(fixture().deps)).toEqual({ active: 0, byRole: {} })
  })

  it('counts active sessions by role', () => {
    const fx = fixture()
    for (const role of ['orchestrator', 'worker', 'worker', 'desktop'] as const) {
      register(fx, role)
    }
    expect(summarizeActiveSessions(fx.deps)).toEqual({
      active: 4,
      byRole: { orchestrator: 1, worker: 2, desktop: 1 }
    })
  })

  it('leaves out ended and stale sessions', () => {
    const fx = fixture()
    const ended = register(fx, 'planner')
    register(fx, 'reviewer')
    endSession(fx.deps, ended)
    fx.clock.advanceSeconds(61)
    register(fx, 'worker')
    expect(summarizeActiveSessions(fx.deps)).toEqual({ active: 1, byRole: { worker: 1 } })
  })

  it('keeps a session at exactly the window edge and drops it just after', () => {
    const fx = fixture()
    register(fx, 'worker')
    fx.clock.advanceSeconds(60)
    expect(summarizeActiveSessions(fx.deps).active).toBe(1)
    fx.clock.advanceSeconds(0.001)
    expect(summarizeActiveSessions(fx.deps)).toEqual({ active: 0, byRole: {} })
  })
})
