import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { KANBAN_LANE_LABELS } from '../../../shared/domain/kanban'
import type { KanbanBoardView, KanbanCardSummaryView, KanbanCardView, KanbanLane } from '../../../shared/domain/kanban'
import { errorMessage, runCommand } from '../api/dm'
import { plural } from '../app/plural'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { formatShortDate } from '../sidebar/epicStatusLine'
import type { OrchestrationHost } from '../epic/orchestration'
import { bindRunner } from '../epic/runner'
import { CardFormDialog, PRIORITY_LABELS } from './CardFormDialog'
import type { CardContent } from './CardFormDialog'
import { KanbanCardPanel } from './KanbanCardPanel'
import { useKanbanBoard } from './useKanbanBoard'
import type { KanbanBoardModel } from './useKanbanBoard'
import './kanban.css'

const OPEN_LANES = ['backlog', 'in_progress', 'ready_for_review'] as const satisfies readonly KanbanLane[]

interface KanbanBoardProps {
  folder: TrackedFolderView
  /** The folder's event token: the board is read again whenever it moves. */
  refreshToken: number
  /** The connected agents, the folder's chats and the shell's navigation, for the open card's Play and chat link. */
  host: OrchestrationHost
  /** A card was clicked and its panel opened. */
  onOpenCard?(cardId: string): void
  /** Refreshes the owning folder after a card mutation, including its sidebar open count. */
  onChanged?(): void
}

/** The attempt badge: what the agent carrying the card is doing, or null when there is nothing to say. */
function attemptBadge(card: KanbanCardSummaryView): { label: string; tone: string } | null {
  switch (card.openAttempt?.state) {
    case 'claimed':
    case 'running':
      return { label: 'Agent working', tone: 'running' }
    case 'lease_expired':
      return { label: 'Agent stopped', tone: 'paused' }
    case 'failed':
      return { label: 'Failed', tone: 'failed' }
    default:
      return card.openAttempt === null && card.playPending ? { label: 'Waiting for agent', tone: 'queued' } : null
  }
}

interface CardProps {
  card: KanbanCardSummaryView
  selected: boolean
  onSelect(): void
  /** Present only while the card can still be edited: in Backlog and never attempted. */
  onEdit?(): void
}

/** A slim card: key, title, priority, attempt badge and kick-backs. */
function KanbanCard({ card, selected, onSelect, onEdit }: CardProps): JSX.Element {
  const badge = attemptBadge(card)
  return (
    <li className={classNames('kanban-card', selected && 'is-selected')}>
      <button type="button" className="kanban-card-main" aria-pressed={selected} onClick={onSelect}>
        <span className="kanban-card-head">
          <span className="kanban-key mono">{card.key}</span>
          <span className={`kanban-priority is-${card.priority}`}>{PRIORITY_LABELS[card.priority]}</span>
        </span>
        <span className="kanban-card-title">{card.title}</span>
        {badge === null && card.kickBackCount === 0 ? null : (
          <span className="kanban-card-foot">
            {badge === null ? null : <span className={`kanban-badge tone-${badge.tone}`}>{badge.label}</span>}
            {card.kickBackCount === 0 ? null : (
              <span className="kanban-kickbacks">{plural(card.kickBackCount, 'kick-back')}</span>
            )}
          </span>
        )}
      </button>
      {onEdit === undefined ? null : (
        <Button size="sm" variant="ghost" className="kanban-edit" aria-label={`Edit ${card.key}`} onClick={onEdit}>
          Edit
        </Button>
      )}
    </li>
  )
}

interface LaneProps {
  lane: KanbanLane
  count: number
  children: ReactNode
}

function Lane({ lane, count, children }: LaneProps): JSX.Element {
  const label = KANBAN_LANE_LABELS[lane]
  return (
    <section className={`kanban-lane lane-${lane}`} aria-label={`${label}, ${plural(count, 'card')}`}>
      <header className="kanban-lane-head">
        <span className="kanban-lane-label">{label}</span>
        <span className="count-badge">{count}</span>
      </header>
      {children}
    </section>
  )
}

interface DoneProps {
  cards: KanbanCardSummaryView[]
  hasMore: boolean
  loadingMore: boolean
  selectedId: string | null
  onSelect(cardId: string): void
  onShowMore(): void
}

/** Done, collapsed by default: compact rows (key, title, outcome, date), one page at a time. */
function DoneRows({ cards, hasMore, loadingMore, selectedId, onSelect, onShowMore }: DoneProps): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="kanban-done-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        {open ? 'Hide Done' : 'Show Done'}
      </button>
      {open ? (
        <ul className="kanban-done-list">
          {cards.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                className={classNames('kanban-done-row', card.id === selectedId && 'is-selected')}
                aria-pressed={card.id === selectedId}
                onClick={() => onSelect(card.id)}
              >
                <span className="kanban-key mono">{card.key}</span>
                <span className="kanban-done-title">{card.title}</span>
                <span className="kanban-done-outcome">{card.summary?.outcome ?? ''}</span>
                <span className="kanban-done-date">{formatShortDate(card.summary?.completedAt ?? card.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && hasMore ? (
        <Button size="sm" busy={loadingMore} onClick={onShowMore}>
          Show more
        </Button>
      ) : null}
    </>
  )
}

/** The form open over the board: a new card, or an edit of a Backlog card. */
type FormState = { kind: 'new' } | { kind: 'edit'; card: KanbanCardView } | null

interface BoardForms {
  form: FormState
  /** Why an edit could not start. */
  problem: string | null
  openNew(): void
  startEdit(cardId: string): Promise<void>
  save(content: CardContent): Promise<void>
  close(): void
}

/** New card and Edit: the open form, and the commands it sends. The board is read again after a save. */
function useBoardForms(path: string, reload: () => void): BoardForms {
  const [form, setForm] = useState<FormState>(null)
  const [problem, setProblem] = useState<string | null>(null)
  return {
    form,
    problem,
    openNew: () => setForm({ kind: 'new' }),
    startEdit: async (cardId) => {
      setProblem(null)
      try {
        setForm({ kind: 'edit', card: await runCommand(path, 'getKanbanCard', { cardId }) })
      } catch (error) {
        setProblem(errorMessage(error))
      }
    },
    save: async (content) => {
      if (form?.kind === 'edit') {
        await runCommand(path, 'updateKanbanCard', { cardId: form.card.id, expectedRevision: form.card.revision, ...content })
      } else {
        await runCommand(path, 'createKanbanCard', content)
      }
      reload()
    },
    close: () => setForm(null)
  }
}

/** The open New card or Edit form, with the runner its image uploads go through. */
function BoardCardForm({ folder, forms, form }: { folder: TrackedFolderView; forms: BoardForms; form: NonNullable<FormState> }): JSX.Element {
  const runner = useMemo(() => bindRunner(folder.path), [folder.path])
  return (
    <CardFormDialog
      card={form.kind === 'edit' ? form.card : undefined}
      runner={runner}
      folderKey={folder.attachmentKey}
      onSubmit={forms.save}
      onClose={forms.close}
    />
  )
}

interface LanesProps {
  model: KanbanBoardModel
  board: KanbanBoardView
  selectedId: string | null
  onSelect(cardId: string): void
  onEdit(cardId: string): void
}

/** A card can still be edited while it is in Backlog and was never played or attempted. */
const editable = (card: KanbanCardSummaryView): boolean =>
  card.lane === 'backlog' && card.openAttempt === null && card.kickBackCount === 0 && !card.playPending

function BoardLanes({ model, board, selectedId, onSelect, onEdit }: LanesProps): JSX.Element {
  return (
    <div className="kanban-lanes">
      {OPEN_LANES.map((lane) => (
        <Lane key={lane} lane={lane} count={board.lanes[lane].length}>
          <ul className="kanban-cards">
            {board.lanes[lane].map((card) => (
              <KanbanCard
                key={card.id}
                card={card}
                selected={card.id === selectedId}
                onSelect={() => onSelect(card.id)}
                onEdit={editable(card) ? () => onEdit(card.id) : undefined}
              />
            ))}
          </ul>
        </Lane>
      ))}
      <Lane lane="done" count={board.doneTotal}>
        <DoneRows
          cards={board.lanes.done}
          hasMore={board.doneNextCursor !== null}
          loadingMore={model.loadingMore}
          selectedId={selectedId}
          onSelect={onSelect}
          onShowMore={model.showMore}
        />
      </Lane>
    </div>
  )
}

/**
 * A folder's Kanban board: Backlog, In progress, Ready for review and Done, each with its count.
 * Cards move only through their own transitions, never by hand. A click selects a card and opens its
 * panel beside the lanes (and tells `onOpenCard`); New card and Edit open the card form.
 */
export function KanbanBoard({ folder, refreshToken, host, onOpenCard, onChanged }: KanbanBoardProps): JSX.Element {
  const model = useKanbanBoard(folder.path, refreshToken)
  const changed = onChanged ?? model.reload
  const forms = useBoardForms(folder.path, changed)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const problem = forms.problem ?? (model.error === null ? null : `Could not refresh the board: ${model.error}`)
  const select = (cardId: string): void => {
    setSelectedId(cardId)
    onOpenCard?.(cardId)
  }
  return (
    <div className="kanban-board">
      <header className="kanban-board-head">
        <h1 className="kanban-title">Kanban</h1>
        <span className="kanban-folder mono">{folder.displayPath}</span>
        <Button variant="primary" icon="plus" onClick={forms.openNew}>
          New card
        </Button>
      </header>
      {problem === null ? null : (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      {model.board === null ? (
        <p className="kanban-note">Loading the board…</p>
      ) : (
        <div className="kanban-body">
          <BoardLanes model={model} board={model.board} selectedId={selectedId} onSelect={select} onEdit={(id) => void forms.startEdit(id)} />
          {selectedId === null ? null : (
            <KanbanCardPanel
              key={selectedId}
              folderPath={folder.path}
              folderKey={folder.attachmentKey}
              cardId={selectedId}
              refreshToken={refreshToken}
              host={host}
              onChanged={changed}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}
      {forms.form === null ? null : <BoardCardForm folder={folder} forms={forms} form={forms.form} />}
    </div>
  )
}
