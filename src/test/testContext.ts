/** Deterministic test fixtures shared by core, MCP, and desktop tests. Not shipped. */
import { capabilitiesForRole, type Capability, type SessionContext } from '../core/authz'
import type { Clock } from '../core/clock'
import type { Ctx } from '../core/context'
import { openDatabase, type Db } from '../core/db/database'
import { migrate } from '../core/db/migrations'
import { encodeBase32, ID_PREFIXES, type IdGenerator } from '../core/ids'
import type { DefinitionOfDoneCheck, SessionRole } from '../shared/domain/views'

export interface TestClock extends Clock {
  advanceSeconds(seconds: number): void
  set(iso: string): void
}

export function createTestClock(startIso = '2026-01-01T00:00:00.000Z'): TestClock {
  let now = Date.parse(startIso)
  return {
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
    advanceSeconds: (seconds) => {
      now += seconds * 1000
    },
    set: (iso) => {
      now = Date.parse(iso)
    }
  }
}

/** Valid-format ids with a predictable counter: `tk_0000000000000000000000000001`-style. */
export function createSequentialIds(): IdGenerator {
  let counter = 0
  let secrets = 0
  return {
    next(kind) {
      counter += 1
      return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(counter), 26)}`
    },
    secret() {
      secrets += 1
      return `secret-${secrets}`
    }
  }
}

export function createTestDb(path = ':memory:'): Db {
  const db = openDatabase(path)
  migrate(db)
  return db
}

interface TestCtxOptions {
  db?: Db
  role?: SessionRole
  capabilities?: Capability[]
  allowSave?: boolean
  clock?: TestClock
  ids?: IdGenerator
  machineId?: string
  projectId?: string
  sessionId?: string
  assertBranch?: () => void
  checkout?: { branch: string | null; commit: string | null }
  /** The project's Definition of Done (default: none). */
  definitionOfDone?: DefinitionOfDoneCheck[]
}

export interface TestCtx extends Ctx {
  clock: TestClock
}

function testSession(options: TestCtxOptions = {}): SessionContext {
  const role = options.role ?? 'orchestrator'
  const capabilities =
    options.capabilities ?? capabilitiesForRole(role, { allowSave: options.allowSave ?? true })
  return {
    id: options.sessionId ?? 'ss_00000000000000000000000000',
    role,
    label: `test ${role}`,
    capabilities: new Set(capabilities)
  }
}

/** A migrated in-memory database plus deterministic clock/ids and a session for `role`. */
export function createTestCtx(options: TestCtxOptions = {}): TestCtx {
  return {
    db: options.db ?? createTestDb(),
    clock: options.clock ?? createTestClock(),
    ids: options.ids ?? createSequentialIds(),
    session: testSession(options),
    machineId: options.machineId ?? 'mc_00000000000000000000000001',
    projectId: options.projectId ?? 'pj_00000000000000000000000001',
    assertBranch: options.assertBranch ?? (() => undefined),
    checkout: () => options.checkout ?? { branch: 'main', commit: '0123456789abcdef0123456789abcdef01234567' },
    definitionOfDone: () => options.definitionOfDone ?? []
  }
}

/** Same database and clock, different session (e.g. desktop vs orchestrator). */
export function withRole(ctx: TestCtx, role: SessionRole, extra: TestCtxOptions = {}): TestCtx {
  return {
    ...ctx,
    session: testSession({ role, sessionId: `ss_${role.padEnd(26, '0').slice(0, 26)}`, ...extra })
  }
}
