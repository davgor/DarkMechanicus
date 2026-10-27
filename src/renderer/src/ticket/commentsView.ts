/** Pure view model for the ticket panel's Comments tab. */
import type { CommentView, SessionRole } from '../../../shared/domain/views'
import { formatAgo } from '../epic/time'

/** The command layer's limit on one comment's Markdown (characters). */
export const MAX_COMMENT_LENGTH = 20_000

const ROLE_LABELS: Record<SessionRole, string> = {
  desktop: 'Desktop',
  planner: 'Planner',
  orchestrator: 'Orchestrator',
  worker: 'Worker',
  reviewer: 'Reviewer'
}

interface CommentItem {
  id: string
  author: string
  /** The role's name, or null when the author label already says it ("Desktop" by the desktop). */
  role: string | null
  /** Relative time ("5m ago"). */
  when: string
  /** Creation time (ISO), for the machine-readable timestamp. */
  at: string
  /** Untrusted Markdown for the safe renderer. */
  body: string
}

function roleChip(role: SessionRole, label: string): string | null {
  const name = ROLE_LABELS[role]
  return label.trim().toLowerCase() === name.toLowerCase() ? null : name
}

export function commentItems(comments: CommentView[], now: number): CommentItem[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.author.label,
    role: roleChip(comment.author.role, comment.author.label),
    when: formatAgo(comment.createdAt, now),
    at: comment.createdAt,
    body: comment.body
  }))
}

/** "Add comment" needs text that is not only whitespace, within the limit, and nothing in flight. */
export function canSubmitComment(draft: string, busy: boolean): boolean {
  return !busy && draft.trim() !== '' && draft.length <= MAX_COMMENT_LENGTH
}
