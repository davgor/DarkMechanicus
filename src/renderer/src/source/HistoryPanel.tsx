import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitFile, CommitSummary } from '../../../shared/git/history'
import { callGit } from '../api/git'
import { useResource, type Resource } from '../app/useResource'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { formatAgo } from '../epic/time'
import { badgeOf, splitPath } from './changeBadge'
import { DiffView } from './DiffView'

interface HistoryPanelProps {
  folderPath: string
  /** The Changes | History switcher, shown at the top of the left column. */
  switcher: React.ReactNode
}

/** How close to the end of the list (in pixels) a scroll starts loading the next page. */
/** Commits asked for per page. */
const HISTORY_PAGE_SIZE = 100
const LOAD_MORE_DISTANCE = 240
const THIRTY_DAYS_MS = 30 * 86_400_000

function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch(() => undefined)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Git did not answer.'
}

function relativeDate(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) {
    return ''
  }
  return Date.now() - at > THIRTY_DAYS_MS ? new Date(at).toLocaleDateString() : formatAgo(iso, Date.now())
}

interface Page {
  commits: CommitSummary[]
  hasMore: boolean
  loading: boolean
  error: string | null
}

const FIRST: Page = { commits: [], hasMore: false, loading: true, error: null }

/** The commits, loaded a page at a time. `loadMore` ignores calls while a page is loading or nothing is left. */
function useCommits(folderPath: string): Page & { loadMore(): void } {
  const [page, setPage] = useState<Page>(FIRST)
  const busy = useRef(false)
  const state = useRef(page)
  state.current = page
  const load = useCallback(
    (skip: number) => {
      busy.current = true
      setPage((previous) => ({ ...previous, loading: true, error: null }))
      callGit(window.git.getHistory(folderPath, { skip, limit: HISTORY_PAGE_SIZE })).then(
        (result) => {
          busy.current = false
          setPage((previous) => ({ commits: skip === 0 ? result.commits : [...previous.commits, ...result.commits], hasMore: result.hasMore, loading: false, error: null }))
        },
        (error: unknown) => {
          busy.current = false
          setPage((previous) => ({ ...previous, loading: false, error: errorText(error) }))
        }
      )
    },
    [folderPath]
  )
  useEffect(() => {
    load(0)
  }, [load])
  const loadMore = useCallback(() => {
    if (!busy.current && state.current.hasMore && state.current.error === null) {
      load(state.current.commits.length)
    }
  }, [load])
  return { ...page, loadMore }
}

function CommitRow({ commit, selected, onSelect }: { commit: CommitSummary; selected: boolean; onSelect(): void }): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <li
      className="history-row"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button type="button" className="history-commit" aria-pressed={selected} onClick={onSelect}>
        <span className="history-summary">{commit.summary}</span>
        <span className="history-meta muted">
          {commit.authorName} · {relativeDate(commit.authoredAt)}
        </span>
      </button>
      {commit.unpushed ? (
        <span className="history-unpushed" role="img" aria-label="Not pushed" title="Not pushed">
          <Icon name="arrow-up" size={14} />
        </span>
      ) : null}
      <Menu
        label={`Actions for ${commit.summary}`}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[{ id: 'copy-sha', label: 'Copy SHA', onSelect: () => copyText(commit.oid) }]}
      />
    </li>
  )
}

function CommitList(props: { page: Page & { loadMore(): void }; selected: string | null; onSelect(oid: string): void }): JSX.Element {
  const { page } = props
  if (page.error !== null && page.commits.length === 0) {
    return <p role="alert" className="source-clean">{page.error}</p>
  }
  if (!page.loading && page.commits.length === 0) {
    return <p className="muted source-clean">No commits yet</p>
  }
  return (
    <div
      className="history-scroll"
      data-testid="commit-scroll"
      onScroll={(event) => {
        const el = event.currentTarget
        if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_DISTANCE) {
          page.loadMore()
        }
      }}
    >
      <ul className="source-files" aria-label="Commits">
        {page.commits.map((commit) => (
          <CommitRow key={commit.oid} commit={commit} selected={props.selected === commit.oid} onSelect={() => props.onSelect(commit.oid)} />
        ))}
      </ul>
      {page.loading ? <p className="muted source-clean">Loading…</p> : null}
      {page.error === null ? null : <p role="alert" className="source-clean">{page.error}</p>}
    </div>
  )
}

function FileButton({ file, selected, onSelect }: { file: CommitFile; selected: boolean; onSelect(): void }): JSX.Element {
  const { dir, name } = splitPath(file.path)
  const badge = badgeOf(file.kind)
  return (
    <li>
      <button type="button" className="source-file" aria-pressed={selected} onClick={onSelect}>
        <span className="source-file-text">
          <span className="source-file-path" title={file.path}>
            <span className="source-dir">{dir}</span>
            <span className="source-name">{name}</span>
          </span>
          {file.oldPath === null ? null : <span className="source-old muted">{file.oldPath}</span>}
        </span>
        <span className={`source-badge source-badge-${file.kind}`} title={badge.label} aria-label={badge.label}>
          {badge.letter}
        </span>
      </button>
    </li>
  )
}

function CommitFileDiff({ folderPath, oid, file }: { folderPath: string; oid: string; file: CommitFile }): JSX.Element {
  const [forced, setForced] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const diff = useResource({
    key: `${folderPath}\u0000${oid}\u0000${file.path}\u0000${String(forced)}`,
    version: 0,
    load: () => callGit(window.git.getCommitDiff(folderPath, { oid, path: file.path, oldPath: file.oldPath, force: forced })),
    onError: (error) => setMessage(errorText(error))
  })
  return (
    <DiffView
      diff={diff.status === 'ready' ? diff.value : null}
      loading={diff.status === 'loading'}
      error={diff.status === 'error' ? (message ?? 'Git did not answer.') : null}
      onShowLarge={() => setForced(true)}
    />
  )
}

function ChangedFiles(props: { files: Resource<CommitFile[]>; message: string | null; selected: CommitFile | null; onSelect(path: string): void }): JSX.Element {
  const { files } = props
  if (files.status === 'loading') {
    return <p className="muted">Reading the files…</p>
  }
  if (files.status === 'error') {
    return <p role="alert">{props.message ?? 'Git did not answer.'}</p>
  }
  if (files.value.length === 0) {
    return <p className="muted">This commit changes no files.</p>
  }
  return (
    <ul className="source-files history-files" aria-label="Changed files">
      {files.value.map((candidate) => (
        <FileButton key={candidate.path} file={candidate} selected={props.selected === candidate} onSelect={() => props.onSelect(candidate.path)} />
      ))}
    </ul>
  )
}

function CommitDetail({ folderPath, commit }: { folderPath: string; commit: CommitSummary }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const files = useResource({
    key: `${folderPath}\u0000${commit.oid}`,
    version: 0,
    load: () => callGit(window.git.getCommitFiles(folderPath, commit.oid)),
    onError: (error) => setMessage(errorText(error))
  })
  const file = (files.status === 'ready' ? files.value : []).find((candidate) => candidate.path === selected) ?? null
  return (
    <section className="history-detail" aria-label="Commit">
      <h2 className="history-title">{commit.summary}</h2>
      {commit.body === '' ? null : <p className="history-body">{commit.body}</p>}
      <p className="muted history-byline">
        {commit.authorName} &lt;{commit.authorEmail}&gt; · {new Date(commit.authoredAt).toLocaleString()}
      </p>
      <p className="history-sha">
        <code className="mono">{commit.oid}</code>
        <Button size="sm" icon="copy" onClick={() => copyText(commit.oid)}>
          Copy
        </Button>
      </p>
      <ChangedFiles files={files} message={message} selected={file} onSelect={setSelected} />
      {file === null ? null : <CommitFileDiff key={file.path} folderPath={folderPath} oid={commit.oid} file={file} />}
    </section>
  )
}

/** The History tab: the left column (switcher and commit list) and the selected commit with its files and diffs. */
export function HistoryPanel({ folderPath, switcher }: HistoryPanelProps): JSX.Element {
  const page = useCommits(folderPath)
  const [selected, setSelected] = useState<string | null>(null)
  const commit = page.commits.find((candidate) => candidate.oid === selected) ?? null
  return (
    <>
      <div className="source-left">
        {switcher}
        <CommitList page={page} selected={selected} onSelect={setSelected} />
      </div>
      <div className="source-diff" aria-label="Commit details">
        {commit === null ? (
          <p className="muted source-placeholder">{!page.loading && page.commits.length === 0 ? 'No commits yet' : 'Select a commit to see what it changed'}</p>
        ) : (
          <CommitDetail key={commit.oid} folderPath={folderPath} commit={commit} />
        )}
      </div>
    </>
  )
}
