import { useEffect, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { KANBAN_LANE_LABELS, KANBAN_OPEN_ATTEMPT_STATES } from '../../../shared/domain/kanban'
import type { KanbanAttemptView, KanbanCardView, KanbanDoneSummary } from '../../../shared/domain/kanban'
import type { AttemptView } from '../../../shared/domain/views'
import { errorMessage, runCommand } from '../api/dm'
import { unwrapChat } from '../agents/chatCalls'
import { Button } from '../components/Button'
import type { OrchestrationHost } from '../epic/orchestration'
import { Markdown } from '../markdown/Markdown'
import { formatShortDate } from '../sidebar/epicStatusLine'
import { CriteriaItems } from '../ticket/AcceptanceSections'
import { AttemptList } from '../ticket/AttemptList'
import { EvidenceSections } from '../ticket/panelTabs'
import { criteriaChecklist, evidenceView } from '../ticket/ticketView'
import { DeleteCardControl } from './DeleteCardControl'
import { StartCardDialog } from './StartCardDialog'
import '../epic/tones.css'
import '../ticket/ticket.css'

interface KanbanCardPanelProps {
  folderPath: string
  cardId: string
  /** The folder's event token: the open card is read again whenever it moves. */
  refreshToken: number
  host: OrchestrationHost
  /** The card changed here (Play, Approve, Kick back): the board is read again. */
  onChanged(): void
  onClose(): void
}

/** Who decided a card attempt; card attempts do not record the person, so the Done summary names them when it can. */
const REVIEWER = 'the reviewer'

/**
 * A card attempt in the shape the ticket attempt list reads. Card attempts have no run, fencing or worker
 * record: the machine stands for the host, the last progress note for the rationale, and a kick-back is a
 * rejected decision whose comment the kick-back history shows.
 */
function asAttemptView(attempt: KanbanAttemptView, summary: KanbanDoneSummary | null): AttemptView {
  const decision =
    attempt.state === 'accepted'
      ? { outcome: 'accepted' as const, notes: '', reasons: [], decidedBy: summary?.approvedBy ?? REVIEWER }
      : attempt.state === 'rejected'
        ? { outcome: 'rejected' as const, notes: '', reasons: [], decidedBy: REVIEWER }
        : null
  return {
    id: attempt.id,
    runId: '',
    ticketId: attempt.cardId,
    number: attempt.number,
    kind: 'work',
    state: attempt.state,
    fencingToken: 0,
    worker: { sessionId: null, label: 'Agent', modelId: null, hostId: attempt.machineId, catalogRevision: null, rationale: attempt.progressNote },
    revisionId: '',
    ticketContentHash: '',
    leaseExpiresAt: attempt.leaseExpiresAt,
    heartbeatAt: attempt.heartbeatAt,
    outputs: attempt.outputs,
    evidence: attempt.evidence,
    failure: null,
    decision,
    createdAt: attempt.createdAt,
    updatedAt: attempt.decidedAt ?? attempt.submittedAt ?? attempt.createdAt,
    submittedAt: attempt.submittedAt,
    decidedAt: attempt.decidedAt,
    reconciledAt: null,
    superseded: false
  }
}

/** Play is offered in Backlog, and In progress while no attempt occupies the card (none yet, or it stopped or failed). */
function canPlay(card: KanbanCardView): boolean {
  if (card.lane === 'backlog') return true
  if (card.lane !== 'in_progress') return false
  return card.openAttempt === null || !KANBAN_OPEN_ATTEMPT_STATES.includes(card.openAttempt.state)
}

/** The open card, read with `getKanbanCard` when it is opened and again when the folder's events move. */
function useCard(folderPath: string, cardId: string, refreshToken: number): { card: KanbanCardView | null; error: string | null; setCard(card: KanbanCardView): void } {
  const [state, setState] = useState<{ cardId: string; card: KanbanCardView | null; error: string | null }>({ cardId, card: null, error: null })
  useEffect(() => {
    let live = true
    runCommand(folderPath, 'getKanbanCard', { cardId }).then(
      (card) => {
        if (live) setState({ cardId, card, error: null })
      },
      (error: unknown) => {
        if (live) setState((previous) => ({ cardId, card: previous.cardId === cardId ? previous.card : null, error: errorMessage(error) }))
      }
    )
    return () => {
      live = false
    }
  }, [folderPath, cardId, refreshToken])
  const current = state.cardId === cardId ? state : { card: null, error: null }
  return { card: current.card, error: current.error, setCard: (card) => setState({ cardId: card.id, card, error: null }) }
}

function DoneSummary({ summary }: { summary: KanbanDoneSummary }): JSX.Element {
  return (
    <section className="tp-section kanban-summary" aria-label="Summary">
      <h3 className="ew-eyebrow">DONE</h3>
      <p>{summary.outcome}</p>
      {summary.commits.length === 0 ? null : (
        <p className="tp-attempt-line">
          Commits: <span className="ew-mono">{summary.commits.map((commit) => commit.slice(0, 7)).join(' · ')}</span>
        </p>
      )}
      <p className="ew-muted">{`Approved by ${summary.approvedBy} on ${formatShortDate(summary.completedAt)}`}</p>
    </section>
  )
}

function KickBackHistory({ attempts }: { attempts: KanbanAttemptView[] }): JSX.Element | null {
  const kicked = attempts.filter((attempt) => attempt.reviewComment !== null)
  if (kicked.length === 0) return null
  return (
    <section className="tp-section" aria-label="Kick-backs">
      <h3 className="ew-eyebrow">KICK-BACKS</h3>
      <ol className="tp-history">
        {kicked.map((attempt) => (
          <li key={attempt.id}>
            <span className="tp-history-title">{`Attempt #${attempt.number}`}</span>
            <Markdown source={attempt.reviewComment ?? ''} />
          </li>
        ))}
      </ol>
    </section>
  )
}

function CardDetails({ card }: { card: KanbanCardView }): JSX.Element {
  const attempts = card.attempts.map((attempt) => asAttemptView(attempt, card.summary))
  const checklist = criteriaChecklist(card, attempts)
  const evidence = evidenceView(card, attempts)
  return (
    <>
      {card.body.trim() === '' ? <p className="ew-muted">No description.</p> : <Markdown source={card.body} />}
      <section className="tp-section" aria-label="Acceptance criteria">
        <h3 className="ew-eyebrow">{checklist.heading}</h3>
        <CriteriaItems items={checklist.items} />
      </section>
      {card.expectedArtifacts.length === 0 ? null : (
        <section className="tp-section" aria-label="Expected artifacts">
          <h3 className="ew-eyebrow">EXPECTED ARTIFACTS</h3>
          <ul className="tp-files">
            {card.expectedArtifacts.map((artifact) => (
              <li key={artifact} className="ew-mono">
                {artifact}
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence === null ? null : <EvidenceSections evidence={evidence} />}
      <KickBackHistory attempts={card.attempts} />
      <section className="tp-section" aria-label="Attempts">
        <h3 className="ew-eyebrow">ATTEMPTS</h3>
        <AttemptList attempts={attempts} now={Date.now()} />
      </section>
    </>
  )
}

interface ReviewProps {
  folderPath: string
  card: KanbanCardView
  /** The review went through: the card as it left it, and what kept a kick-back from reaching the agent. */
  onReviewed(card: KanbanCardView, problem: string | null): void
}

/** The kick-back form: the comment is required, so Send stays disabled until one is typed. */
function KickBackForm(props: { busy: boolean; onSend(comment: string): void; onCancel(): void }): JSX.Element {
  const [comment, setComment] = useState('')
  const text = comment.trim()
  return (
    <div className="tp-reject">
      <label className="tp-field">
        <span>Kick-back comment</span>
        <textarea value={comment} rows={3} onChange={(event) => setComment(event.target.value)} />
      </label>
      <div className="tp-row-actions">
        <Button variant="primary" disabled={text === '' || props.busy} busy={props.busy} onClick={() => {
            if (text !== '') props.onSend(text)
          }}>
          Send kick back
        </Button>
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Approve, or Kick back with a required comment that goes to the card's agent. */
function ReviewControls({ folderPath, card, onReviewed }: ReviewProps): JSX.Element {
  const [kicking, setKicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (action: () => Promise<{ card: KanbanCardView; problem: string | null }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      onReviewed(result.card, result.problem)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="tp-section tp-review" aria-label="Review">
      {kicking ? (
        <KickBackForm
          busy={busy}
          onSend={(comment) => void perform(() => unwrapChat(window.dm.chats.kickBackKanbanCard({ folder: folderPath, cardId: card.id, comment })))}
          onCancel={() => setKicking(false)}
        />
      ) : (
        <div className="tp-row-actions">
          <Button variant="primary" busy={busy} disabled={busy} onClick={() => void perform(async () => ({ card: await runCommand(folderPath, 'approveKanbanCard', { cardId: card.id }), problem: null }))}>
            Approve
          </Button>
          <Button disabled={busy} onClick={() => setKicking(true)}>
            Kick back
          </Button>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="tp-error">
          {error}
        </p>
      )}
    </section>
  )
}

interface CardBodyProps {
  folderPath: string
  card: KanbanCardView
  host: OrchestrationHost
  onPlay(): void
  onReviewed(card: KanbanCardView, problem: string | null): void
  onDeleted(): void
}

/** The loaded card: title, Play and the chat link, review controls, the Done summary, then the details. */
function CardBody({ folderPath, card, host, onPlay, onReviewed, onDeleted }: CardBodyProps): JSX.Element {
  // The card's newest chat: the one the last Play started, which a kick-back is pasted into.
  const chat = host.chats
    .filter((item) => item.cardId === card.id)
    .reduce<ChatRecord | null>((newest, item) => (newest === null || item.createdAt > newest.createdAt ? item : newest), null)
  return (
    <>
      <h2 className="kanban-panel-title">{card.title}</h2>
      <div className="tp-row-actions">
        {canPlay(card) ? (
          <Button variant="primary" onClick={onPlay}>
            Play
          </Button>
        ) : null}
        {chat === null ? null : <Button onClick={() => host.onOpenChat(chat.id)}>Open chat</Button>}
        <DeleteCardControl folderPath={folderPath} card={card} onDeleted={onDeleted} />
      </div>
      {card.lane === 'ready_for_review' ? <ReviewControls folderPath={folderPath} card={card} onReviewed={onReviewed} /> : null}
      {card.summary === null ? null : <DoneSummary summary={card.summary} />}
      <CardDetails card={card} />
    </>
  )
}

function PanelHead({ card, onClose }: { card: KanbanCardView | null; onClose(): void }): JSX.Element {
  return (
    <header className="kanban-panel-head">
      {card === null ? null : (
        <>
          <span className="kanban-key mono">{card.key}</span>
          <span className="kanban-panel-lane">{KANBAN_LANE_LABELS[card.lane]}</span>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </header>
  )
}

/**
 * The card opened from the board: its content, evidence, attempts and kick-backs, read only when it is
 * opened. Play starts an agent on it; a card in Ready for review is approved or kicked back here. A Done
 * card leads with its compact summary.
 */
export function KanbanCardPanel({ folderPath, cardId, refreshToken, host, onChanged, onClose }: KanbanCardPanelProps): JSX.Element {
  const { card, error, setCard } = useCard(folderPath, cardId, refreshToken)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const changed = (next: KanbanCardView, problem: string | null): void => {
    setCard(next)
    setNotice(problem)
    onChanged()
  }
  return (
    <aside className="kanban-panel" aria-label={card === null ? 'Card' : `${card.key} ${card.title}`}>
      <PanelHead card={card} onClose={onClose} />
      {error === null ? null : <p role="alert" className="tp-error">{`Could not read the card: ${error}`}</p>}
      {notice === null ? null : <p role="status" className="kanban-note">{notice}</p>}
      {card !== null ? (
        <CardBody
          folderPath={folderPath}
          card={card}
          host={host}
          onPlay={() => setPlaying(true)}
          onReviewed={changed}
          onDeleted={() => {
            onChanged()
            onClose()
          }}
        />
      ) : error === null ? (
        <p className="kanban-note">Loading the card…</p>
      ) : null}
      {playing && card !== null ? (
        <StartCardDialog
          folderPath={folderPath}
          card={card}
          host={host}
          onStarted={(result) => {
            setPlaying(false)
            changed(result.card, result.problem)
            const { chat, problem } = result
            if (chat === null) return
            // As Start run opens its chat: once the folder's chats list it, and only when its terminal started.
            void host.onChatsChanged().then(() => {
              if (problem === null) host.onOpenChat(chat.id)
            })
          }}
          onClose={() => setPlaying(false)}
        />
      ) : null}
    </aside>
  )
}
