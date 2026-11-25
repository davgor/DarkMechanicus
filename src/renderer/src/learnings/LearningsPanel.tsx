import './learnings.css'
import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { LearningView } from '../../../shared/domain/learnings'
import { useToasts } from '../app/toasts'
import type { Resource } from '../app/useResource'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { LearningDetail } from './LearningDetail'
import type { SourceTarget } from './learningSources'
import { type LearningDetailData, type LearningFilter, useLearningDetail, useLearningList } from './useLearnings'

const FILTERS: { value: LearningFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'retired', label: 'Retired' },
  { value: 'all', label: 'All' }
]

interface LearningsPanelProps {
  folder: TrackedFolderView
  /** The learning open in the detail pane (persisted with the route), or null. */
  learningId: string | null
  /** Changes whenever the folder's events may have changed its learnings. */
  refreshToken: number
  onOpenLearning(learningId: string | null): void
  onOpenSource(target: SourceTarget): void
  onBack(): void
}

function ListBody({ list, filter, selected, onOpen }: { list: Resource<LearningView[]>; filter: LearningFilter; selected: string | null; onOpen(id: string): void }): JSX.Element {
  if (list.status === 'loading') return <p className="muted" role="status">Loading learnings…</p>
  if (list.status === 'error') return <p className="inline-warning" role="alert">The learnings could not be read.</p>
  if (list.value.length === 0) {
    return <EmptyState icon="search" title={filter === 'active' ? 'No active learnings' : 'No learnings'}>Approved learning cards publish learnings here.</EmptyState>
  }
  return (
    <ul className="learnings-list" aria-label="Learnings list">
      {list.value.map((learning) => (
        <li key={learning.id}>
          <button type="button" className="learnings-item" aria-current={learning.id === selected || undefined} onClick={() => onOpen(learning.id)}>
            <span className="learnings-item-title">{learning.title}</span>
            <span className="muted">{learning.state === 'active' ? 'Active' : 'Retired'} · revision {learning.revision} · {learning.applicability.roles.join(', ')}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function DetailBody(props: { detail: Resource<LearningDetailData> | null } & Omit<Parameters<typeof LearningDetail>[0], 'data'>): JSX.Element {
  const { detail } = props
  if (detail === null) return <p className="muted">Choose a learning to see its rule, source and history.</p>
  if (detail.status === 'loading') return <p className="muted" role="status">Loading learning…</p>
  if (detail.status === 'error') return <p className="inline-warning" role="alert">This learning could not be read.</p>
  return <LearningDetail {...props} data={detail.value} />
}

/**
 * Knowledge → Learnings: the folder's published learnings, active by default, with a state filter, a search and the
 * open learning's detail. Lists and detail reload on the folder's events and after a retirement or replacement.
 */
export function LearningsPanel({ folder, learningId, refreshToken, onOpenLearning, onOpenSource, onBack }: LearningsPanelProps): JSX.Element {
  const toasts = useToasts()
  const [filter, setFilter] = useState<LearningFilter>('active')
  const [query, setQuery] = useState('')
  const { list, reload: reloadList } = useLearningList({ folder: folder.path, filter, query: query.trim(), refreshToken, onError: toasts.reportError })
  const { detail, reload: reloadDetail } = useLearningDetail({ folder: folder.path, learningId, refreshToken, onError: toasts.reportError })
  const changed = (openId: string | null): void => {
    reloadList()
    if (openId === null) reloadDetail()
    else onOpenLearning(openId)
  }
  return (
    <div className="learnings" aria-label="Learnings">
      <div className="learnings-head">
        <Button size="sm" variant="ghost" onClick={onBack}>Knowledge</Button>
        <h1 className="learnings-title">Learnings</h1>
        <span className="learnings-folder">{folder.displayPath}</span>
      </div>
      <div className="learnings-filters">
        <div role="radiogroup" aria-label="State" className="learnings-states">
          {FILTERS.map((option) => (
            <label key={option.value} className="learnings-check">
              <input type="radio" name="learning-state" checked={filter === option.value} onChange={() => setFilter(option.value)} />
              {option.label}
            </label>
          ))}
        </div>
        <input className="input" type="search" aria-label="Search learnings" placeholder="Search learnings" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="learnings-body">
        <section className="learnings-column" aria-label="Learning list">
          <ListBody list={list} filter={filter} selected={learningId} onOpen={onOpenLearning} />
        </section>
        <section className="learnings-column" aria-label="Learning detail">
          <DetailBody detail={detail} folder={folder.path} onOpenLearning={onOpenLearning} onOpenSource={onOpenSource} onChanged={changed} onReload={reloadDetail} />
        </section>
      </div>
    </div>
  )
}
