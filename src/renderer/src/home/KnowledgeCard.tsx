import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type {
  KnowledgeDiagnosticView,
  KnowledgeLayerName,
  KnowledgeRepositoryGitView,
  KnowledgeStatusView,
  TrackedFolderView
} from '../../../shared/desktop/api'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'

const LAYER_LABELS: Record<KnowledgeLayerName, string> = {
  builtin: 'Built-in',
  overall: 'Overall',
  repo: 'This folder'
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function factCount(count: number): string {
  return `${count} ${count === 1 ? 'fact' : 'facts'}`
}

/** "2 ahead · 1 behind origin/main", "Up to date with origin/main", or "No upstream". */
function syncText(git: Extract<KnowledgeRepositoryGitView, { state: 'ok' }>): string {
  if (git.upstream === null) return 'No upstream'
  if (git.ahead === 0 && git.behind === 0) return `Up to date with ${git.upstream}`
  return `${git.ahead} ahead · ${git.behind} behind ${git.upstream}`
}

function GitRows({ git }: { git: KnowledgeRepositoryGitView }): JSX.Element {
  if (git.state === 'unavailable') {
    return (
      <Row label="Git">
        <span className="tone-error">{git.reason}</span>
      </Row>
    )
  }
  return (
    <>
      <Row label="Branch">{git.branch ?? 'detached HEAD'}</Row>
      <Row label="Sync">{syncText(git)}</Row>
      <Row label="Changes">
        {git.dirty ? <span className="tone-warn">Uncommitted changes</span> : <span className="tone-ok">Clean</span>}
      </Row>
    </>
  )
}

function Diagnostics({ diagnostics }: { diagnostics: readonly KnowledgeDiagnosticView[] }): JSX.Element | null {
  if (diagnostics.length === 0) return null
  return (
    <details className="board-group" aria-label="Knowledge diagnostics">
      <summary className="board-group-title">
        {diagnostics.length} {diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}
      </summary>
      <ul className="note">
        {diagnostics.map((diagnostic, index) => (
          <li key={`${index}:${diagnostic.path}`}>
            {LAYER_LABELS[diagnostic.layer]} <span className="mono">{diagnostic.path}</span>: {diagnostic.message}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Details({ status }: { status: KnowledgeStatusView }): JSX.Element {
  const { builtin, overall, repo } = status.layers
  return (
    <dl className="kv">
      <Row label="Overall repo">{overall.path === null ? 'Not set' : <span className="mono">{overall.path}</span>}</Row>
      {status.git === null ? null : <GitRows git={status.git} />}
      <Row label={LAYER_LABELS.builtin}>{factCount(builtin.count)}</Row>
      <Row label={LAYER_LABELS.overall}>{factCount(overall.count)}</Row>
      <Row label={LAYER_LABELS.repo}>{factCount(repo.count)}</Row>
    </dl>
  )
}

interface KnowledgeState {
  /** Null until the first status is read. */
  status: KnowledgeStatusView | null
  /** Why the last folder picked was refused, shown until a later choice or clear. */
  refusal: string | null
  busy: boolean
  choose(): void
  clear(): void
}

/** The folder's knowledge status, read on mount and again after each choose or clear. */
function useKnowledge(folderPath: string): KnowledgeState {
  const toasts = useToasts()
  const [status, setStatus] = useState<KnowledgeStatusView | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (live: () => boolean = () => true): Promise<void> => {
      try {
        const next = await window.dm.knowledgeStatus(folderPath)
        if (live()) setStatus(next)
      } catch (error) {
        if (live()) toasts.reportError(error)
      }
    },
    [folderPath, toasts]
  )

  useEffect(() => {
    let live = true
    setStatus(null)
    void load(() => live)
    return () => {
      live = false
    }
  }, [load])

  const run = (action: () => Promise<void>): void => {
    setBusy(true)
    action()
      .then(() => load())
      .catch((error: unknown) => toasts.reportError(error))
      .finally(() => setBusy(false))
  }

  return {
    status,
    refusal,
    busy,
    choose: () =>
      run(async () => {
        const result = await window.dm.chooseKnowledgeRepository()
        if (result.outcome === 'refused') setRefusal(result.reason)
        if (result.outcome === 'set') setRefusal(null)
      }),
    clear: () =>
      run(async () => {
        await window.dm.clearKnowledgeRepository()
        setRefusal(null)
      })
  }
}

/**
 * The knowledge agents read for this folder: the overall repository this machine points at (its path and Git state),
 * the facts each layer holds and any diagnostics. Only the person sets the overall repository, through the native picker.
 */
export function KnowledgeCard({ folder }: { folder: TrackedFolderView }): JSX.Element {
  const { status, refusal, busy, choose, clear } = useKnowledge(folder.path)
  const configured = status?.layers.overall.configured === true
  return (
    <section className="card" aria-label="Knowledge">
      <h2 className="card-title">Knowledge</h2>
      {status === null ? <p className="muted">Loading knowledge…</p> : <Details status={status} />}
      {refusal === null ? null : (
        <p className="inline-warning" role="alert">
          <Icon name="warning" />
          <span>{refusal}</span>
        </p>
      )}
      {status === null ? null : <Diagnostics diagnostics={status.diagnostics} />}
      <div className="button-row">
        <Button icon="folder" busy={busy} disabled={status === null} onClick={choose}>
          {configured ? 'Change…' : 'Choose…'}
        </Button>
        {configured ? (
          <Button busy={busy} onClick={clear}>
            Clear
          </Button>
        ) : null}
      </div>
      <p className="note">
        The overall repository holds knowledge shared by every folder on this computer. Only you can set it; pull and push
        it in Git.
      </p>
    </section>
  )
}
