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
  role: string
  /** Relative time ("5m ago"). */
  when: string
  /** Creation time (ISO), for the machine-readable timestamp. */
  at: string
  /** Untrusted Markdown for the safe renderer. */
  body: string
}

export function commentItems(comments: CommentView[], now: number): CommentItem[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.author.label,
    role: ROLE_LABELS[comment.author.role],
    when: formatAgo(comment.createdAt, now),
    at: comment.createdAt,
    body: comment.body
  }))
}

/** "Add comment" needs text that is not only whitespace, within the limit, and nothing in flight. */
export function canSubmitComment(draft: string, busy: boolean): boolean {
  return !busy && draft.trim() !== '' && draft.length <= MAX_COMMENT_LENGTH
}
