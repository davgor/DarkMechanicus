import type { SessionRole } from '../shared/domain/views'
import { fail } from './errors'

export const CAPABILITIES = [
  'read',
  'chat.name',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'repo.backup',
  'repo.resolve_conflict',
  'repo.switch_storage',
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
  // Usage of one attempt: a worker's own claimed attempt, or any attempt of a run an orchestrator owns.
  'metrics.report',
  // Run-level overhead (orchestration, review, verification) in the run's own bucket.
  'metrics.report_run',
  // A person's satisfaction rating, rescue time or escaped defect record, entered in the desktop app; never an agent's.
  'feedback.record',
  // Corrective work a retro asks of another project (the Dark Mechanicus source), created there through the desktop.
  'correction.cross_repo',
  'checkpoint.approve',
  'checkpoint.advance',
  'comment.write',
  'attachment.write',
  'kanban.write',
  'kanban.play',
  'kanban.launch',
  'kanban.claim',
  'kanban.report',
  'kanban.review',
  'kanban.delete',
  'grant.issue',
  'grant.revoke',
  // An agent's own desktop-bound mailbox. Holding it is necessary, never sufficient: every mail operation also needs
  // the session's current grant to be bound to an open endpoint on this machine and folder (services/agentMail.ts).
  'mail.use',
  // Provisioning, binding, renaming and closing mailboxes, and the person's own inbox, seen cursor and wake credit.
  'mail.manage'
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
  'repo.switch_storage',
  // A full SQLite backup copies every private local mailbox (agent mail exists only in the database), so only the
  // person at the desktop takes one. No agent role, grant or MCP tool may: that would be an export-all-mail bypass.
  'repo.backup',
  // Desktop Play starts a chat; external orchestrators queue named cards with the separate launch capability.
  'kanban.play',
  'kanban.review',
  // Removing a card from the board is the person's call; agents create and edit cards but never delete them.
  'kanban.delete',
  // Human feedback is what a person said: a session that could record it could speak for them.
  'feedback.record',
  // Writing into another project's records is the person's act at the desktop: a repository-bound agent writes only in its own.
  'correction.cross_repo',
  // Mailboxes are the person's to create, bind and close: an agent that could would register or rebind itself, or
  // close a peer's. The person's inbox view and the one-shot wake credit it grants are theirs too.
  'mail.manage'
]

/** What a planner and an orchestrator both hold. */
const PLANNER_SHARED: Capability[] = [
  'read',
  'chat.name',
  'repo.init',
  'repo.flush',
  'repo.reconcile',
  'epic.create',
  'draft.edit',
  'comment.write',
  // Attaching an image from a local path (evidence or a reference), the same for both planning roles.
  'attachment.write',
  // Adding or editing a Kanban card; review remains human-only.
  'kanban.write',
  'profile.write',
  // Re-detecting a folder's repositories only records what is on disk, so both planning roles may do it.
  'project.repositories',
  // Direct messages between Skitarii chats; usable only through a desktop-bound grant.
  'mail.use'
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
  'kanban.launch',
  'kanban.claim',
  'kanban.report',
  'metrics.report',
  'metrics.report_run'
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
  'kanban.launch',
  'kanban.claim',
  'kanban.report',
  // Agent and host usage is reported by the sessions that did the work; human feedback is a separate desktop input.
  'metrics.report',
  'metrics.report_run',
  // A mailbox speaks for an agent's chat; the person reads and manages mail through `mail.manage` instead.
  'mail.use'
]

const DESKTOP: Capability[] = CAPABILITIES.filter((capability) => !AGENT_ONLY.includes(capability))

const ROLE_CAPABILITIES: Record<SessionRole, Capability[]> = {
  desktop: DESKTOP,
  reader: ['read'],
  planner: PLANNER,
  orchestrator: ORCHESTRATOR,
  worker: [
    'read',
    'chat.name',
    'attempt.heartbeat',
    'attempt.submit',
    'attempt.fail',
    'comment.write',
    'attachment.write',
    'kanban.report',
    'metrics.report',
    'mail.use'
  ],
  reviewer: ['read', 'chat.name', 'attempt.review', 'comment.write', 'attachment.write', 'metrics.report_run', 'mail.use']
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
