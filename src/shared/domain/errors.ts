/**
 * Structured error codes returned by every command path (MCP tools and desktop IPC alike).
 * Messages are human-readable; `code` is the stable contract.
 */
export const DOMAIN_ERROR_CODES = [
  'not_found',
  'invalid_input',
  'conflict',
  'stale_draft',
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
  'internal'
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export interface DomainErrorShape {
  code: DomainErrorCode
  message: string
  details?: Record<string, unknown>
}
