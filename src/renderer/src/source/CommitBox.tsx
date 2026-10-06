import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { FileChange } from '../../../shared/git/status'
import { callGit, GitCommandError } from '../api/git'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { Field } from '../components/Field'

/** A summary longer than this is still allowed, but git tools show it cut off. */
const SUMMARY_WARN_LENGTH = 72

export interface CommittedInfo {
  oid: string
  summary: string
  description: string
  /** HEAD before the commit, so the commit can be told apart from an unrefreshed state. */
  headBefore: string | null
}

interface CommitBoxProps {
  folderPath: string
  branchName: string | null
  headOid: string | null
  included: readonly FileChange[]
  summary: string
  description: string
  onChange(next: { summary: string; description: string }): void
  onCommitted(info: CommittedInfo): void
}

interface Failure {
  message: string
  detail: string | undefined
}

function failureOf(error: unknown): Failure {
  if (error instanceof GitCommandError) {
    return { message: error.message, detail: error.detail }
  }
  return { message: error instanceof Error ? error.message : 'Git did not answer.', detail: undefined }
}

function CommitError({ failure }: { failure: Failure | null }): JSX.Element | null {
  if (failure === null) {
    return null
  }
  return (
    <div role="alert" className="commit-error">
      <p>{failure.message}</p>
      {failure.detail === undefined ? null : (
        <details>
          <summary>Details</summary>
          <pre className="mono">{failure.detail}</pre>
        </details>
      )}
    </div>
  )
}

/** The summary and description fields with the Commit button. Ctrl+Enter or Cmd+Enter commits. */
export function CommitBox(props: CommitBoxProps): JSX.Element {
  const { folderPath, summary, description, included } = props
  const toasts = useToasts()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const canCommit = summary.trim() !== '' && included.length > 0 && !busy

  const commit = (): void => {
    if (!canCommit) {
      return
    }
    setBusy(true)
    setFailure(null)
    const request = { summary: summary.trim(), description, files: included.map((file) => ({ path: file.path, oldPath: file.oldPath })) }
    callGit(window.git.commit(folderPath, request)).then(
      ({ oid }) => {
        setBusy(false)
        props.onChange({ summary: '', description: '' })
        props.onCommitted({ oid, summary: request.summary, description, headBefore: props.headOid })
        toasts.push('success', `Committed ${oid.slice(0, 7)}`)
      },
      (error: unknown) => {
        setBusy(false)
        setFailure(failureOf(error))
      }
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      commit()
    }
  }

  return (
    <div className="commit-box" onKeyDown={onKeyDown}>
      <Field label="Summary" value={summary} onChange={(value) => props.onChange({ summary: value, description })} />
      {summary.length > SUMMARY_WARN_LENGTH ? (
        <p className="commit-warning">Summaries over {SUMMARY_WARN_LENGTH} characters get cut off in most tools.</p>
      ) : null}
      <Field label="Description" rows={3} value={description} onChange={(value) => props.onChange({ summary, description: value })} />
      <Button variant="primary" busy={busy} disabled={!canCommit} onClick={commit}>
        {`Commit to ${props.branchName ?? 'detached HEAD'}`}
      </Button>
      <CommitError failure={failure} />
    </div>
  )
}
