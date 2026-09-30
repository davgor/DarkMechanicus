import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { runCommand } from '../api/dm'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SearchResultView } from '../../../shared/domain/views'
import { plural } from '../app/plural'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'

const SEARCH_LIMIT = 25

const DOC_LABELS: Record<SearchResultView['docType'], string> = {
  epic: 'Epic',
  ticket: 'Ticket',
  attempt: 'Attempt',
  report: 'Report'
}

type SearchState =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | { phase: 'done'; query: string; results: SearchResultView[] }

interface ResultsProps {
  state: SearchState
  onOpenEpic(epicId: string): void
}

function Results({ state, onOpenEpic }: ResultsProps): JSX.Element | null {
  if (state.phase === 'idle') {
    return null
  }
  if (state.phase === 'searching') {
    return (
      <p className="muted" role="status">
        Searching…
      </p>
    )
  }
  const { query, results } = state
  const summary = results.length === 0 ? `No matches for “${query}”.` : `${plural(results.length, 'result')} for “${query}”`
  return (
    <>
      <p className="muted" role="status">
        {summary}
      </p>
      {results.length === 0 ? null : (
        <ul className="search-results">
          {results.map((result) => (
            <li key={`${result.docType}:${result.docId}`}>
              <button type="button" className="search-result" onClick={() => onOpenEpic(result.epicId)}>
                <span className="result-type mono">{DOC_LABELS[result.docType]}</span>{' '}
                <span className="result-title">{result.title}</span>{' '}
                <span className="result-epic muted">in {result.epicTitle}</span>{' '}
                <span className="result-snippet">{result.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

interface HistorySearchProps {
  folder: TrackedFolderView
  onOpenEpic(epicId: string): void
}

/** Full-text search over epics, tickets, attempt outcomes and sprint reports; results open their epic. */
export function HistorySearch({ folder, onOpenEpic }: HistorySearchProps): JSX.Element {
  const toasts = useToasts()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })
  const latest = useRef(0)
  const text = query.trim()

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (text === '') return
    latest.current += 1
    const mine = latest.current
    setState({ phase: 'searching' })
    try {
      const results = await runCommand(folder.path, 'searchHistory', { query: text, limit: SEARCH_LIMIT })
      if (latest.current === mine) setState({ phase: 'done', query: text, results })
    } catch (error) {
      if (latest.current === mine) setState({ phase: 'idle' })
      toasts.reportError(error)
    }
  }

  return (
    <section className="home-section" aria-label="Search history">
      <h2 className="section-title">Search history</h2>
      <form role="search" className="search-form" onSubmit={(event) => void submit(event)}>
        <input
          type="search"
          className="input"
          aria-label="Search plans and run history"
          placeholder="Search epics, tickets, attempts and reports"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" icon="search" disabled={text === ''}>
          Search
        </Button>
      </form>
      <Results state={state} onOpenEpic={onOpenEpic} />
    </section>
  )
}
