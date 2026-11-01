import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { GithubRepository } from '../../../shared/github/api'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { Icon } from '../components/Icon'
import { useGithub } from '../github/GithubAccount'
import { SignInPrompt } from '../github/SignInPrompt'
import { groupByOwner, matchesFilter } from './cloneTarget'

type RepositoriesState =
  | { kind: 'loading'; repositories: GithubRepository[] }
  | { kind: 'ready'; repositories: GithubRepository[] }
  | { kind: 'auth' }
  | { kind: 'error'; message: string }

const LOADING: RepositoriesState = { kind: 'loading', repositories: [] }

/** The account's repositories while signed in, from main's cache unless refreshed; a newer request wins. */
function useAccountRepositories(login: string | null): [RepositoriesState, () => void] {
  const [state, setState] = useState<RepositoriesState>(LOADING)
  const latest = useRef(0)
  const load = useCallback((refresh: boolean) => {
    const request = (latest.current += 1)
    setState((previous) => ({ kind: 'loading', repositories: 'repositories' in previous ? previous.repositories : [] }))
    void window.github.listRepositories(refresh ? { refresh } : undefined).then((result) => {
      if (request !== latest.current) return
      if (result.ok) setState({ kind: 'ready', repositories: result.data })
      else if (result.error.code === 'auth_required' || result.error.code === 'auth_failed') setState({ kind: 'auth' })
      else setState({ kind: 'error', message: result.error.message })
    })
  }, [])
  useEffect(() => {
    if (login !== null) load(false)
    return () => {
      latest.current += 1
    }
  }, [login, load])
  return [state, () => load(true)]
}

interface RepositoryOptionProps {
  repository: GithubRepository
  selected: boolean
  onSelect(repository: GithubRepository): void
}

function RepositoryOption({ repository, selected, onSelect }: RepositoryOptionProps): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(repository)
    }
  }
  return (
    <div className="clone-repo" role="option" aria-selected={selected} tabIndex={0} onClick={() => onSelect(repository)} onKeyDown={onKeyDown}>
      <span className="clone-repo-name">{repository.name}</span>
      {repository.private ? (
        <span className="clone-repo-lock" role="img" aria-label="Private">
          <Icon name="lock" size={13} />
        </span>
      ) : null}
      {repository.fork ? (
        <>
          {' '}
          <span className="clone-repo-fork">fork</span>
        </>
      ) : null}
    </div>
  )
}

interface ListProps {
  repositories: GithubRepository[]
  filter: string
  selected: GithubRepository | null
  onSelect(repository: GithubRepository): void
}

function RepositoryList({ repositories, filter, selected, onSelect }: ListProps): JSX.Element {
  const shown = repositories.filter((repository) => matchesFilter(repository, filter))
  if (shown.length === 0) {
    return <p className="muted">{filter.trim() === '' ? 'This account has no repositories.' : 'No repositories match.'}</p>
  }
  return (
    <div className="clone-repos" role="listbox" aria-label="Repositories">
      {groupByOwner(shown).map((group) => (
        <div key={group.owner} role="group" aria-label={group.owner}>
          <p className="clone-owner" aria-hidden="true">
            {group.owner}
          </p>
          {group.repositories.map((repository) => (
            <RepositoryOption
              key={repository.fullName}
              repository={repository}
              selected={selected?.fullName === repository.fullName}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

interface GithubTabProps {
  selected: GithubRepository | null
  onSelect(repository: GithubRepository): void
}

/** The GitHub.com tab: the sign-in prompt while signed out, else the account's repositories with a filter and Refresh. */
export function GithubTab({ selected, onSelect }: GithubTabProps): JSX.Element {
  const { account, loaded } = useGithub()
  const [state, refresh] = useAccountRepositories(account?.login ?? null)
  const [filter, setFilter] = useState('')
  if (!loaded) return <p className="muted">Loading…</p>
  if (account === null || state.kind === 'auth') return <SignInPrompt purpose="see your repositories" />
  return (
    <div className="clone-github">
      <div className="clone-filter-row">
        <Field label="Filter repositories" value={filter} onChange={setFilter} />
        <Button size="sm" icon="refresh" busy={state.kind === 'loading'} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {state.kind === 'error' ? (
        <p className="clone-error" role="alert">
          {state.message}
        </p>
      ) : state.kind === 'loading' && state.repositories.length === 0 ? (
        <p className="muted">Loading repositories…</p>
      ) : (
        <RepositoryList repositories={state.repositories} filter={filter} selected={selected} onSelect={onSelect} />
      )}
    </div>
  )
}
