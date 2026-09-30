import { type FormEvent, useEffect, useState } from 'react'
import type { CommentView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { Markdown } from '../markdown/Markdown'
import { canSubmitComment, commentItems, MAX_COMMENT_LENGTH } from './commentsView'

interface CommentsTabProps {
  runner: Runner
  epicId: string
  ticketId: string
  now: number
  /** Changes whenever the workspace reloads (for example on a comment.added event). */
  reloadKey: unknown
  /** False for a completed epic: comments stay readable, but no new ones are offered. */
  canComment: boolean
}

interface Loaded {
  comments: CommentView[] | null
  error: string | null
}

function useComments(props: CommentsTabProps, refresh: number): Loaded {
  const { runner, epicId, ticketId, reloadKey } = props
  const [loaded, setLoaded] = useState<Loaded>({ comments: null, error: null })
  useEffect(() => {
    let active = true
    runner('listComments', { epicId, ticketId }).then(
      (comments) => {
        if (active) {
          setLoaded({ comments, error: null })
        }
      },
      (error: unknown) => {
        if (active) {
          setLoaded({ comments: null, error: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, epicId, ticketId, reloadKey, refresh])
  return loaded
}

function CommentList(props: { loaded: Loaded; now: number }): JSX.Element {
  const { comments, error } = props.loaded
  if (error !== null) {
    return <p role="alert" className="tp-error">{error}</p>
  }
  if (comments === null) {
    return <p className="ew-muted">Loading comments…</p>
  }
  if (comments.length === 0) {
    return <p className="ew-muted">No comments yet.</p>
  }
  return (
    <ol className="tp-comments" aria-label="Comments">
      {commentItems(comments, props.now).map((item) => (
        <li key={item.id} className="tp-comment" aria-label={`Comment by ${item.author}`}>
          <p className="tp-comment-head">
            <span className="tp-comment-author">{item.author}</span> <span className="ew-chip">{item.role}</span>{' '}
            <time className="ew-muted" dateTime={item.at} title={item.at}>
              {item.when}
            </time>
          </p>
          <Markdown source={item.body} className="tp-comment-body" />
        </li>
      ))}
    </ol>
  )
}

function CommentForm(props: CommentsTabProps & { onAdded(): void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmitComment(draft, busy)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.runner('addComment', { epicId: props.epicId, ticketId: props.ticketId, body: draft })
      setDraft('')
      props.onAdded()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="tp-comment-form" onSubmit={(event) => void submit(event)}>
      <label className="tp-field">
        <span>New comment</span>
        <textarea
          value={draft}
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder="Markdown: a blocker, a decision, a review note…"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {error === null ? null : <p role="alert" className="tp-error">{error}</p>}
      <div className="tp-row-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmitComment(draft, busy)}>
          Add comment
        </button>
      </div>
    </form>
  )
}

/** The ticket's comments (oldest first, Markdown through the safe renderer) and, for open epics, a form to add one. */
export function CommentsTab(props: CommentsTabProps): JSX.Element {
  const [refresh, setRefresh] = useState(0)
  const loaded = useComments(props, refresh)
  return (
    <>
      <CommentList loaded={loaded} now={props.now} />
      {props.canComment ? (
        <CommentForm {...props} onAdded={() => setRefresh((count) => count + 1)} />
      ) : (
        <p className="ew-muted">Comments on a completed epic are read-only.</p>
      )}
    </>
  )
}
