import { describe, expect, it } from 'vitest'
import type { SessionRole } from '../shared/domain/views'
import { thrownBy } from '../test/thrownBy'
import {
  type Capability,
  CAPABILITIES,
  capabilitiesForRole,
  HUMAN_ONLY_CAPABILITIES,
  requireCapability,
  type SessionContext
} from './authz'
import { DomainError } from './errors'

const PLANNER: Capability[] = ['read', 'repo.init', 'repo.flush', 'repo.reconcile', 'epic.create', 'draft.edit', 'comment.write']

const ORCHESTRATOR: Capability[] = [
  ...PLANNER,
  'repo.backup',
  'epic.status',
  'epic.branch',
  'ticket.status',
  'host.register',
  'run.start',
  'run.control',
  'run.takeover',
  'run.adopt',
  'attempt.claim',
  'attempt.heartbeat',
  'attempt.submit',
  'attempt.review',
  'attempt.fail',
  'attempt.reconcile',
  'attempt.carry_forward',
  'report.submit',
  'checkpoint.advance'
]

const WORKER: Capability[] = ['read', 'attempt.heartbeat', 'attempt.submit', 'attempt.fail', 'comment.write']
const REVIEWER: Capability[] = ['read', 'attempt.review', 'comment.write']

const DESKTOP: Capability[] = [
  'read',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'repo.backup',
  'epic.create',
  'epic.status',
  'epic.branch',
  'draft.edit',
  'plan.save',
  'ticket.status',
  'ticket.retry_grant',
  'run.queue',
  'run.control',
  'run.takeover',
  'run.adopt',
  'run.authorize_auto',
  'attempt.review',
  'attempt.reconcile',
  'checkpoint.approve',
  'checkpoint.advance',
  'comment.write'
]

/** Capabilities the desktop never holds: they belong to the agents that execute work. */
const AGENT_ONLY = [
  'attempt.claim',
  'attempt.heartbeat',
  'attempt.submit',
  'attempt.fail',
  'attempt.carry_forward',
  'report.submit',
  'run.start',
  'host.register'
] as const

const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer']
const ALL_ROLES: SessionRole[] = ['desktop', ...AGENT_ROLES]

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function sessionWith(role: SessionRole, capabilities: Capability[]): SessionContext {
  return { id: 'ss_test', role, label: 'test session', capabilities: new Set(capabilities) }
}

describe('capability vocabulary', () => {
  it('lists every capability exactly once', () => {
    expect(CAPABILITIES).toHaveLength(30)
    expect(new Set(CAPABILITIES).size).toBe(30)
    expect(sorted(CAPABILITIES)).toEqual(sorted([...DESKTOP, ...AGENT_ONLY]))
  })

  it('marks approval, auto-continue, retry grants and run queueing as human-only', () => {
    expect(sorted(HUMAN_ONLY_CAPABILITIES)).toEqual(
      sorted(['checkpoint.approve', 'run.authorize_auto', 'ticket.retry_grant', 'run.queue'])
    )
  })
})

describe('capabilitiesForRole exact sets', () => {
  it.each([
    ['worker', WORKER],
    ['reviewer', REVIEWER],
    ['planner', PLANNER],
    ['orchestrator', ORCHESTRATOR],
    ['desktop', DESKTOP]
  ] as const)('gives the %s role exactly its capabilities', (role, expected) => {
    expect(sorted(capabilitiesForRole(role))).toEqual(sorted(expected))
  })

  it.each(ALL_ROLES)('gives the %s role only known, distinct capabilities', (role) => {
    const capabilities = capabilitiesForRole(role, { allowSave: true })
    expect(new Set(capabilities).size).toBe(capabilities.length)
    expect(capabilities.filter((capability) => !CAPABILITIES.includes(capability))).toEqual([])
  })

  it.each(ALL_ROLES)('lets the %s role write comments', (role) => {
    expect(capabilitiesForRole(role).filter((capability) => capability === 'comment.write')).toEqual(['comment.write'])
  })

  it('lets the orchestrator do everything the planner can', () => {
    const orchestrator = capabilitiesForRole('orchestrator')
    expect(capabilitiesForRole('planner').filter((capability) => !orchestrator.includes(capability))).toEqual([])
  })

  it('returns a fresh array on every call', () => {
    const first = capabilitiesForRole('worker')
    first.push('plan.save')
    expect(capabilitiesForRole('worker')).toEqual(WORKER)
  })
})

describe('desktop and human-only capabilities', () => {
  it.each(HUMAN_ONLY_CAPABILITIES)('gives the desktop %s', (capability) => {
    expect(capabilitiesForRole('desktop')).toContain(capability)
  })

  it.each(AGENT_ROLES)('never gives the %s role a human-only capability', (role) => {
    for (const options of [{}, { allowSave: true }, { allowSave: false }]) {
      const granted = capabilitiesForRole(role, options)
      expect(HUMAN_ONLY_CAPABILITIES.filter((capability) => granted.includes(capability))).toEqual([])
    }
  })

  it.each(AGENT_ONLY)('keeps %s away from the desktop', (capability) => {
    expect(capabilitiesForRole('desktop')).not.toContain(capability)
  })
})

describe('allowSave', () => {
  it.each(['planner', 'orchestrator'] as const)('adds plan.save for the %s role', (role) => {
    expect(capabilitiesForRole(role)).not.toContain('plan.save')
    expect(capabilitiesForRole(role, { allowSave: false })).not.toContain('plan.save')
    expect(capabilitiesForRole(role, {})).not.toContain('plan.save')
    const withSave = capabilitiesForRole(role, { allowSave: true })
    expect(withSave.filter((capability) => capability === 'plan.save')).toHaveLength(1)
    expect(withSave).toHaveLength(capabilitiesForRole(role).length + 1)
  })

  it.each(['worker', 'reviewer'] as const)('never adds plan.save for the %s role', (role) => {
    expect(capabilitiesForRole(role, { allowSave: true })).not.toContain('plan.save')
    expect(capabilitiesForRole(role, { allowSave: true })).toEqual(capabilitiesForRole(role))
  })

  it('does not duplicate plan.save for the desktop, which already has it', () => {
    const withSave = capabilitiesForRole('desktop', { allowSave: true })
    expect(withSave.filter((capability) => capability === 'plan.save')).toHaveLength(1)
    expect(sorted(withSave)).toEqual(sorted(DESKTOP))
  })
})

describe('requireCapability', () => {
  it('passes silently when the session holds the capability', () => {
    const session = sessionWith('worker', ['read', 'attempt.submit'])
    expect(requireCapability(session, 'attempt.submit')).toBeUndefined()
    expect(requireCapability(session, 'read')).toBeUndefined()
  })

  it('throws unauthorized naming the role and capability', () => {
    const session = sessionWith('worker', ['read'])
    const error = thrownBy(() => requireCapability(session, 'plan.save'))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('unauthorized')
    expect((error as DomainError).message).toBe('This worker session is not permitted to perform "plan.save".')
    expect((error as DomainError).details).toEqual({ role: 'worker', capability: 'plan.save' })
  })

  it('checks the session capability set rather than the role name', () => {
    const custom = sessionWith('reviewer', ['plan.save'])
    expect(requireCapability(custom, 'plan.save')).toBeUndefined()
    expect(() => requireCapability(custom, 'attempt.review')).toThrow(/reviewer session/)
  })

  it('rejects everything for a session with no capabilities', () => {
    const empty = sessionWith('planner', [])
    expect(() => requireCapability(empty, 'read')).toThrow(DomainError)
  })
})
