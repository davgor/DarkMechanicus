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

/** What a planner holds that an orchestrator does not: the session that accepts work never redefines "done". */
const PLANNER_ONLY: Capability[] = ['project.definition_of_done']

const PLANNER_SHARED: Capability[] = [
  'read',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'epic.create',
  'draft.edit',
  'comment.write',
  'profile.write'
]

const PLANNER: Capability[] = [...PLANNER_SHARED, ...PLANNER_ONLY]

const ORCHESTRATOR: Capability[] = [
  ...PLANNER_SHARED,
  'repo.backup',
  'epic.status',
  'epic.branch',
  'ticket.status',
  'host.register',
  'run.start',
  'run.control',
  'run.takeover',
  'run.adopt',
  'run.row_check',
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
  'epic.delete',
  'draft.edit',
  'plan.save',
  'profile.write',
  'project.definition_of_done',
  'ticket.status',
  'ticket.retry_grant',
  'ticket.delete',
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
  'run.row_check',
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
    expect(CAPABILITIES).toHaveLength(35)
    expect(new Set(CAPABILITIES).size).toBe(35)
    expect(sorted(CAPABILITIES)).toEqual(sorted([...DESKTOP, ...AGENT_ONLY]))
  })

  it('marks approval, auto-continue, retry grants, run queueing and deletion as human-only', () => {
    expect(sorted(HUMAN_ONLY_CAPABILITIES)).toEqual(
      sorted(['checkpoint.approve', 'run.authorize_auto', 'ticket.retry_grant', 'run.queue', 'epic.delete', 'ticket.delete'])
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

  it('lets the orchestrator do everything the planner can, except what is reserved to the planner', () => {
    const orchestrator = capabilitiesForRole('orchestrator')
    expect(capabilitiesForRole('planner').filter((capability) => !orchestrator.includes(capability))).toEqual(PLANNER_ONLY)
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

describe('named profile authoring', () => {
  it('lets the desktop, planner, and orchestrator save profiles, but not workers or reviewers', () => {
    const holders = ALL_ROLES.filter((role) => capabilitiesForRole(role).includes('profile.write'))
    expect(holders).toEqual(['desktop', 'planner', 'orchestrator'])
    expect(HUMAN_ONLY_CAPABILITIES).not.toContain('profile.write')
  })
})

describe('the project Definition of Done', () => {
  it('may be set by the desktop and the planner, and by no other role', () => {
    const holders = ALL_ROLES.filter((role) => capabilitiesForRole(role).includes('project.definition_of_done'))
    expect(holders).toEqual(['desktop', 'planner'])
  })

  it('stays out of the orchestrator and the workers it dispatches, with or without allowSave', () => {
    for (const role of ['orchestrator', 'worker', 'reviewer'] as const) {
      expect(capabilitiesForRole(role, { allowSave: true })).not.toContain('project.definition_of_done')
    }
  })

  it('is not a human-only capability: an agent planner may set it', () => {
    expect(HUMAN_ONLY_CAPABILITIES).not.toContain('project.definition_of_done')
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
