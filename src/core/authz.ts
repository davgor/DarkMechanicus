import type { SessionRole } from '../shared/domain/views'
import { fail } from './errors'

export const CAPABILITIES = [
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
  'profile.write',
  'ticket.status',
  'ticket.retry_grant',
  'host.register',
  'run.queue',
  'run.start',
  'run.control',
  'run.takeover',
  'run.adopt',
  'run.authorize_auto',
  'attempt.claim',
  'attempt.heartbeat',
  'attempt.submit',
  'attempt.review',
  'attempt.fail',
  'attempt.reconcile',
  'attempt.carry_forward',
  'report.submit',
  'checkpoint.approve',
  'checkpoint.advance',
  'comment.write'
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Capabilities only a person at the desktop can exercise; no agent role ever receives them. */
export const HUMAN_ONLY_CAPABILITIES: readonly Capability[] = [
  'checkpoint.approve',
  'run.authorize_auto',
  'ticket.retry_grant',
  'run.queue'
]

const PLANNER: Capability[] = [
  'read',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'epic.create',
  'draft.edit',
  'comment.write',
  'profile.write'
]

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

const DESKTOP: Capability[] = CAPABILITIES.filter(
  (capability) =>
    capability !== 'attempt.claim' &&
    capability !== 'attempt.heartbeat' &&
    capability !== 'attempt.submit' &&
    capability !== 'attempt.fail' &&
    capability !== 'attempt.carry_forward' &&
    capability !== 'report.submit' &&
    capability !== 'run.start' &&
    capability !== 'host.register'
)

const ROLE_CAPABILITIES: Record<SessionRole, Capability[]> = {
  desktop: DESKTOP,
  planner: PLANNER,
  orchestrator: ORCHESTRATOR,
  worker: ['read', 'attempt.heartbeat', 'attempt.submit', 'attempt.fail', 'comment.write'],
  reviewer: ['read', 'attempt.review', 'comment.write']
}

interface RoleOptions {
  /** Explicit user authorization (launch flag) for an agent session to save plans. */
  allowSave?: boolean
}

export function capabilitiesForRole(role: SessionRole, options: RoleOptions = {}): Capability[] {
  const base = [...ROLE_CAPABILITIES[role]]
  const canAuthor = role === 'planner' || role === 'orchestrator'
  if (options.allowSave === true && canAuthor && !base.includes('plan.save')) {
    base.push('plan.save')
  }
  return base
}

export interface SessionContext {
  id: string
  role: SessionRole
  label: string
  capabilities: ReadonlySet<Capability>
}

export function requireCapability(session: SessionContext, capability: Capability): void {
  if (!session.capabilities.has(capability)) {
    fail(
      'unauthorized',
      `This ${session.role} session is not permitted to perform "${capability}".`,
      { role: session.role, capability }
    )
  }
}
