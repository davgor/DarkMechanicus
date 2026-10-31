import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { RepositoryView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import { useToasts } from '../app/toasts'
import { repositoryCount, useRepositories } from '../app/useRepositories'
import { Button } from '../components/Button'

/** What a rescan changed, in words: the repositories it added and the ones now missing. */
function rescanMessage(before: readonly RepositoryView[], after: readonly RepositoryView[]): string {
  const known = new Set(before.map((repository) => repository.name))
  const wasMissing = new Set(before.filter((repository) => repository.missing).map((repository) => repository.name))
  const added = after.filter((repository) => !known.has(repository.name)).map((repository) => repository.name)
  const missing = after
    .filter((repository) => repository.missing && !wasMissing.has(repository.name))
    .map((repository) => repository.name)
  const parts = [
    added.length > 0 ? `Added ${added.join(', ')}.` : null,
    missing.length > 0 ? `Missing ${missing.join(', ')}.` : null
  ].filter((part) => part !== null)
  return parts.length > 0 ? `Rescanned. ${parts.join(' ')}` : 'Rescanned. No repositories were added or went missing.'
}

/** How many Definition of Done checks a repository has, in words. */
function checkCount(count: number): string {
  if (count === 0) {
    return 'No Definition of Done'
  }
  return `${count} Definition of Done ${count === 1 ? 'check' : 'checks'}`
}

function RepositoryRow({ folder, repository }: { folder: TrackedFolderView; repository: RepositoryView }): JSX.Element {
  return (
    <li className="branch-epic">
      <span className="branch-epic-title">{repository.name}</span>
      <span className="branch-epic-meta">
        <span className="mono">{`${folder.path}/${repository.name}`}</span>
        <span className="muted">{checkCount(repository.definitionOfDone?.length ?? 0)}</span>
        {repository.missing ? <span className="pill pill-failed">Missing</span> : null}
      </span>
    </li>
  )
}

interface CardProps {
  folder: TrackedFolderView
  repositories: RepositoryView[]
  onRescanned(repositories: RepositoryView[]): void
}

function Card({ folder, repositories, onRescanned }: CardProps): JSX.Element {
  const toasts = useToasts()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const rescan = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await runCommand(folder.path, 'rescanRepositories', undefined)
      setError(false)
      toasts.push('success', rescanMessage(repositories, next))
      onRescanned(next)
    } catch (caught) {
      setError(true)
      toasts.reportError(caught)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card" aria-label="Repositories">
      <h2 className="card-title">Repositories</h2>
      <p className="note">{repositoryCount(repositories.length)} in this folder. Each ticket targets one of them.</p>
      {error ? <p className="muted is-error">Could not rescan the repositories.</p> : null}
      <ul className="branch-epics">
        {repositories.map((repository) => (
          <RepositoryRow key={repository.name} folder={folder} repository={repository} />
        ))}
      </ul>
      <div className="button-row">
        <Button icon="refresh" busy={busy} onClick={() => void rescan()}>
          Rescan
        </Button>
      </div>
    </section>
  )
}

/** The repositories of a folder of repositories, with a rescan; nothing for a single repository. */
export function RepositoriesCard({ folder }: { folder: TrackedFolderView }): JSX.Element | null {
  const toasts = useToasts()
  const resource = useRepositories(folder.path, toasts.reportError)
  const [rescanned, setRescanned] = useState<RepositoryView[] | null>(null)
  if (resource.status === 'loading') {
    return null
  }
  if (resource.status === 'error') {
    return (
      <section className="card" aria-label="Repositories">
        <h2 className="card-title">Repositories</h2>
        <p className="muted is-error">Could not read the repositories.</p>
      </section>
    )
  }
  const repositories = rescanned ?? resource.value
  if (repositories === null) {
    return null
  }
  return <Card folder={folder} repositories={repositories} onRescanned={setRescanned} />
}
