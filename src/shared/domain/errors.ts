/**
 * Structured error codes returned by every command path (MCP tools and desktop IPC alike).
 * Messages are human-readable; `code` is the stable contract.
 */
export const DOMAIN_ERROR_CODES = [
  'desktop_unavailable',
  'timeout',
  'cancelled',
  'invalid_request',
  'busy',
  /** Another surface owns this chat's live process or its cleanup. */
  'busy_elsewhere',
  /** The selected agent kind has no protocol for the requested surface. */
  'unsupported',
  /** No connected agent is signed in to start the chat with. */
  'no_agent',
  'response_too_large',
  'operation_unavailable',
  'internal_error',
  'not_found',
  'invalid_input',
  'conflict',
  'stale_draft',
  /** The held agent question or approval has already been answered or replaced. */
  'stale_prompt',
  'invalid_graph',
  'invalid_plan',
  'unmet_prerequisite',
  'unauthorized',
  'unauthorized_transition',
  'expired_claim',
  'stale_claim',
  'already_claimed',
  'capacity_exceeded',
  'retry_limit_reached',
  /** `retry_ticket` found the plan's orchestrator retry budget for the ticket used up: only the person's grant adds attempts. */
  'retry_escalation_required',
  'unsupported_capability',
  'completed_epic',
  'active_run_exists',
  'run_not_active',
  'run_not_owned',
  'approval_required',
  'gate_blocked',
  'needs_reconciliation',
  'branch_changed',
  'not_initialized',
  'already_initialized',
  'incompatible_schema',
  'project_mismatch',
  'idempotency_mismatch',
  'import_rejected',
  'unsafe_path',
  'save_pending',
  /** The entity is not in a state that allows the change, such as editing a Kanban card that has left Backlog. */
  'invalid_state',
  /** A Kanban card was claimed without a pending Play: only a person starts a card, by pressing Play. */
  'play_required',
  /** A report on a Kanban card attempt that another computer claimed; only that computer reports on it. */
  'card_not_owned',
  /** A recipient mailbox is at its pending or retained message quota; pending mail is never evicted to make room. */
  'mailbox_full',
  /** A sender holds the maximum number of unexpired send receipts; no unexpired receipt is ever dropped to make room. */
  'receipt_quota_full',
  /** A reply names a message that is not (or no longer) in the replier's own inbox. */
  'reply_unavailable',
  // Cult commands (`src/shared/cults/cultControl.ts`): refusals the Magos or an acolyte can act on.
  'cap_reached',
  'model_unavailable',
  'tier_reason_required',
  'run_paused',
  'run_ending',
  'name_taken',
  'folder_not_tracked',
  'no_acolytes',
  'slot_unknown',
  'slot_occupied',
  'reports_missing',
  'target_stale',
  'plan_invalid',
  'internal'
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export interface DomainErrorShape {
  code: DomainErrorCode
  message: string
  details?: Record<string, unknown>
}
