/** Renderer-safe codes for a failed git operation. Later tickets may add codes. */
const GIT_ERROR_CODES = [
  'git_not_found',
  'not_repository',
  'auth_required',
  'auth_failed',
  'rejected_non_fast_forward',
  'merge_conflicts',
  'local_changes_would_be_overwritten',
  'nothing_to_commit',
  'branch_exists',
  'branch_not_fully_merged',
  'remote_not_found',
  'network_unreachable',
  'index_locked',
  'operation_in_progress',
  'timeout',
  'cancelled',
  'output_too_large',
  'git_failed'
] as const

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number]
