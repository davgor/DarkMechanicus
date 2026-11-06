import type { SessionRole } from '../shared/domain/views'
import { fail } from './errors'

export const CAPABILITIES = [
  'read',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'repo.backup',
  'repo.resolve_conflict',
  'epic.create',
  'epic.status',
  'epic.branch',
  'epic.delete',
  'epic.transfer',
  'transfer.queue',
  'draft.edit',
  'plan.save',
  'profile.write',
  'project.definition_of_done',
  'project.repositories',
  'ticket.status',
  'ticket.retry_grant',
  'ticket.delete',
  'host.register',
  'run.queue',
  'run.start',
  'run.control',
  'run.takeover',
  'run.adopt',
  'run.redraft',
  'run.authorize_auto',
  'run.pause_signed_out',
  'run.resume_signed_out',
  'run.row_check',
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
  'comment.write',
  'kanban.write',
  'kanban.play',
  'kanban.claim',
  'kanban.report',
  'kanban.review',
  'kanban.delete',
  'grant.issue',
  'grant.revoke'
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Capabilities only a person at the desktop can exercise; no agent role ever receives them. */
export const HUMAN_ONLY_CAPABILITIES: readonly Capability[] = [
  'checkpoint.approve',
  // Granting an agent a role is the person's act: a session that could grant could promote itself.
  'grant.issue',
  'grant.revoke',
  'run.authorize_auto',
  'run.pause_signed_out',
  'run.resume_signed_out',
  'ticket.retry_grant',
  'run.queue',
  'epic.delete',
  'ticket.delete',
  // Sending a plan out to Linear is the person's decision; an agent only carries out a queued transfer.
  'transfer.queue',
  // Settling an epic records conflict drops one side's changes: which survive is the person's call.
  'repo.resolve_conflict',
  // Starting a Kanban card, and approving or kicking back its result: an agent never grades or launches its own work.
  'kanban.play',
  'kanban.review',
  // Removing a card from the board is the person's call; agents create and edit cards but never delete them.
  'kanban.delete'
]

/** What a planner and an orchestrator both hold. */
const PLANNER_SHARED: Capability[] = [
  'read',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'epic.create',
  'draft.edit',
  'comment.write',
  // Adding or editing a Kanban card; only a person may start, approve or kick one back.
  'kanban.write',
  'profile.write',
  // Re-detecting a folder's repositories only records what is on disk, so both planning roles may do it.
  'project.repositories'
]

/**
 * What a planner holds that an orchestrator does not. The Definition of Done is the standard the orchestrator's
 * reviews hold work to, so the session that accepts work cannot also redefine what done means: a planner or the
 * person at the desktop does. An orchestrator still reads it (getProject, and the acceptance node's packet).
 */
const PLANNER_ONLY: Capability[] = ['project.definition_of_done']

const PLANNER: Capability[] = [...PLANNER_SHARED, ...PLANNER_ONLY]

const ORCHESTRATOR: Capability[] = [
  ...PLANNER_SHARED,
  'repo.backup',
  'epic.status',
  'epic.branch',
  'epic.transfer',
  'ticket.status',
  'host.register',
  'run.start',
  'run.control',
  'run.takeover',
  'run.adopt',
  'run.redraft',
  'run.row_check',
  'attempt.claim',
  'attempt.heartbeat',
  'attempt.submit',
  'attempt.review',
  'attempt.fail',
  'attempt.reconcile',
  'attempt.carry_forward',
  'report.submit',
  'checkpoint.advance',
  'kanban.claim',
  'kanban.report'
]

/** What the desktop never holds: claiming and reporting on work belong to the agents that execute it. */
const AGENT_ONLY: readonly Capability[] = [
  'attempt.claim',
  'attempt.heartbeat',
  'attempt.submit',
  'attempt.fail',
  'attempt.carry_forward',
  'report.submit',
  'run.start',
  'run.row_check',
  'host.register',
  'kanban.claim',
  'kanban.report'
]

const DESKTOP: Capability[] = CAPABILITIES.filter((capability) => !AGENT_ONLY.includes(capability))

const ROLE_CAPABILITIES: Record<SessionRole, Capability[]> = {
  desktop: DESKTOP,
  reader: ['read'],
  planner: PLANNER,
  orchestrator: ORCHESTRATOR,
  worker: ['read', 'attempt.heartbeat', 'attempt.submit', 'attempt.fail', 'comment.write', 'kanban.report'],
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

/** Throws `unauthorized` unless the session holds the capability; `message` replaces the default sentence when the caller can say more. */
export function requireCapability(session: SessionContext, capability: Capability, message?: string): void {
  if (!session.capabilities.has(capability)) {
    fail(
      'unauthorized',
      message ?? `This ${session.role} session is not permitted to perform "${capability}".`,
      { role: session.role, capability }
    )
  }
}
