import type { CommandName } from '../../shared/domain/api'
import type { Capability } from '../authz'

/**
 * The capability each command requires, declared once for every entry point. The services enforce
 * it with `requireCapability` (a test proves they enforce exactly this table for every role), and
 * the MCP server lists a tool only to sessions whose role holds its command's capability.
 * A command added to `CommandApi` without an entry here is a compile error.
 *
 * `approveAndAdvance` also requires `checkpoint.advance`, which every holder of
 * `checkpoint.approve` (the desktop) has.
 */
export const COMMAND_CAPABILITIES: Readonly<Record<CommandName, Capability>> = {
  getCapabilities: 'read',
  getProject: 'read',
  initializeRepository: 'repo.init',
  getStorageStatus: 'read',
  flushPortableState: 'repo.flush',
  reconcileRepository: 'repo.reconcile',
  searchHistory: 'read',
  listBranchEpics: 'read',
  backupDatabase: 'repo.backup',
  listSessions: 'read',
  listEvents: 'read',
  listEpics: 'read',
  createEpic: 'epic.create',
  getEpic: 'read',
  setEpicStatus: 'epic.status',
  setEpicBranch: 'epic.branch',
  previewBoardImport: 'read',
  importBoard: 'epic.create',
  getPlan: 'read',
  openDraft: 'draft.edit',
  updatePlanDraft: 'draft.edit',
  validatePlan: 'read',
  savePlan: 'plan.save',
  discardPlanDraft: 'draft.edit',
  listRevisions: 'read',
  listTickets: 'read',
  getTicket: 'read',
  setTicketStatus: 'ticket.status',
  registerHost: 'host.register',
  matchCapabilities: 'read',
  queueRun: 'run.queue',
  startRun: 'run.start',
  getRun: 'read',
  getReadyTickets: 'read',
  claimTicket: 'attempt.claim',
  heartbeatAttempt: 'attempt.heartbeat',
  submitAttempt: 'attempt.submit',
  acceptAttempt: 'attempt.review',
  rejectAttempt: 'attempt.review',
  failAttempt: 'attempt.fail',
  reconcileAttempt: 'attempt.reconcile',
  carryForwardTicket: 'attempt.carry_forward',
  pauseRun: 'run.control',
  resumeRun: 'run.control',
  cancelRun: 'run.control',
  takeoverRun: 'run.takeover',
  adoptRevision: 'run.adopt',
  submitSprintReport: 'report.submit',
  getSprintReport: 'read',
  getCheckpoint: 'read',
  approveCheckpoint: 'checkpoint.approve',
  advanceSprint: 'checkpoint.advance',
  approveAndAdvance: 'checkpoint.approve',
  authorizeAutoContinue: 'run.authorize_auto',
  grantRetry: 'ticket.retry_grant',
  addComment: 'comment.write',
  listComments: 'read',
  listProfiles: 'read',
  getProfile: 'read',
  saveProfile: 'profile.write'
}
