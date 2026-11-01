/**
 * Renderer-safe codes for a failed GitHub sign-in or API call, beside the git codes it shares
 * (`auth_required`, `auth_failed`, `cancelled`, `network_unreachable`).
 */
export type GithubErrorCode =
  | 'gh_not_installed'
  | 'gh_not_signed_in'
  | 'gh_missing_scope'
  | 'secure_storage_unavailable'
  | 'github_failed'
