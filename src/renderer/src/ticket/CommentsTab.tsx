import { type FormEvent, useEffect, useState } from 'react'
import type { CommentView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import { AttachmentGallery } from '../attachments/AttachmentGallery'
import { type FormImage, ImageAttachField } from '../attachments/ImageAttachField'
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
  /** The folder's attachment key: the host of each image address. */
  folderKey: string
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

function CommentList(props: { loaded: Loaded; now: number; folderKey: string }): JSX.Element {
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
            <span className="tp-comment-author">{item.author}</span>{' '}
            {item.role === null ? null : <span className="ew-chip">{item.role}</span>}{' '}
            <time className="ew-muted" dateTime={item.at} title={item.at}>
              {item.when}
            </time>
          </p>
          <Markdown source={item.body} className="tp-comment-body" />
          {item.attachments === undefined ? null : <AttachmentGallery folderKey={props.folderKey} attachments={item.attachments} />}
        </li>
      ))}
    </ol>
  )
}

async function sendComment(props: CommentsTabProps, body: string, images: FormImage[]): Promise<void> {
  const attachments = images.map((image) => image.id)
  await props.runner('addComment', {
    epicId: props.epicId,
    ticketId: props.ticketId,
    body,
    ...(attachments.length === 0 ? {} : { attachments })
  })
}

function CommentDraft(props: { draft: string; onChange(draft: string): void }): JSX.Element {
  return (
    <label className="tp-field">
      <span>New comment</span>
      <textarea
        value={props.draft}
        rows={3}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder="Markdown: a blocker, a decision, a review note…"
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}

function CommentForm(props: CommentsTabProps & { onAdded(): void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<FormImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [fieldKey, setFieldKey] = useState(0)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmitComment(draft, busy || uploading)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sendComment(props, draft, images)
      setDraft('')
      setImages([])
      // A fresh field (its key flips on each send) drops the old field's own pending list, which would otherwise
      // come back on the next upload.
      setFieldKey((key) => (key === 0 ? 1 : 0))
      props.onAdded()
    } catch (failure: unknown) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="tp-comment-form" onSubmit={(event) => void submit(event)}>
      <ImageAttachField
        key={fieldKey}
        runner={props.runner}
        folderKey={props.folderKey}
        images={images}
        onChange={setImages}
        onBusyChange={setUploading}
      >
        <CommentDraft draft={draft} onChange={setDraft} />
      </ImageAttachField>
      {error === null ? null : <p role="alert" className="tp-error">{error}</p>}
      <div className="tp-row-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmitComment(draft, busy || uploading)}>
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
      <CommentList loaded={loaded} now={props.now} folderKey={props.folderKey} />
      {props.canComment ? (
        <CommentForm {...props} onAdded={() => setRefresh((count) => count + 1)} />
      ) : (
        <p className="ew-muted">Comments on a completed epic are read-only.</p>
      )}
    </>
  )
}
