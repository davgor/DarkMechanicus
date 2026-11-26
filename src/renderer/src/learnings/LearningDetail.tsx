import type { ReactNode } from 'react'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import type { LearningHistoryEntryView, LearningView } from '../../../shared/domain/learnings'
import type { RunView } from '../../../shared/domain/views'
import { evidenceLink, type SourceLink, sourceLinks, type SourceTarget } from './learningSources'
import { LearningActions } from './LearningActions'
import type { LearningDetailData } from './useLearnings'

interface DetailProps {
  folder: string
  data: LearningDetailData
  onOpenLearning(learningId: string): void
  onOpenSource(target: SourceTarget): void
  onChanged(openId: string | null): void
  onReload(): void
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function listOrAny(items: readonly string[], any: string): ReactNode {
  return items.length === 0 ? <span className="muted">{any}</span> : <span className="mono">{items.join(', ')}</span>
}

/** A provenance value: a link when a view shows its target, otherwise the label; the stored id always shows. */
function LinkValue({ link, onOpen }: { link: Omit<SourceLink, 'name'>; onOpen(target: SourceTarget): void }): JSX.Element {
  const { target } = link
  return (
    <span className="learnings-link">
      {target === null ? <span>{link.label}</span> : <button type="button" className="sc-link" onClick={() => onOpen(target)}>{link.label}</button>}
      {link.label === link.id ? null : <span className="mono muted">{link.id}</span>}
    </span>
  )
}

function LearningLink({ id, onOpen }: { id: string | null; onOpen(learningId: string): void }): JSX.Element {
  if (id === null) return <span className="muted">None</span>
  return <button type="button" className="sc-link mono" onClick={() => onOpen(id)}>{id}</button>
}

interface ProvenanceProps {
  learning: LearningView
  run: RunView | null
  card: KanbanCardView | null
  onOpenSource(target: SourceTarget): void
}

/** The run, sprint, card and attempt the learning was published from, and each evidence item it cites. */
function Provenance({ learning, run, card, onOpenSource }: ProvenanceProps): JSX.Element {
  return (
    <section aria-label="Source">
      <h3 className="learnings-subtitle">Source</h3>
      <dl className="kv">
        {sourceLinks(learning.source, run, card).map((link) => (
          <Row key={link.name} label={link.name}>
            <LinkValue link={link} onOpen={onOpenSource} />
          </Row>
        ))}
      </dl>
      <h3 className="learnings-subtitle">Evidence</h3>
      <ul className="learnings-evidence" aria-label="Evidence">
        {learning.evidence.map((item) => (
          <li key={`${item.kind}:${item.sourceId}`}>
            <span className="mono muted">{item.kind}</span>{' '}
            <LinkValue link={{ ...evidenceLink(item.sourceId, run), id: item.sourceId }} onOpen={onOpenSource} />
          </li>
        ))}
      </ul>
    </section>
  )
}

const HISTORY_WORDS: Record<LearningHistoryEntryView['kind'], string> = {
  published: 'Published',
  retired: 'Retired',
  replaced: 'Replaced by',
  created_by_replacement: 'Replaces'
}

function History({ history, onOpenLearning }: { history: readonly LearningHistoryEntryView[]; onOpenLearning(learningId: string): void }): JSX.Element {
  return (
    <section aria-label="History">
      <h3 className="learnings-subtitle">History</h3>
      <ol className="learnings-history">
        {history.map((entry) => (
          <li key={entry.seq}>
            <span>
              <strong>{HISTORY_WORDS[entry.kind]}</strong>
              {entry.relatedId === null ? null : <> <LearningLink id={entry.relatedId} onOpen={onOpenLearning} /></>}
              {' · '}revision {entry.revision} · {entry.actor.label} ({entry.actor.role}) · <time dateTime={entry.at}>{entry.at}</time>
            </span>
            <span className="muted">{entry.reason}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Lifecycle, revision and both replacement links. */
function Lifecycle({ learning, onOpenLearning }: { learning: LearningView; onOpenLearning(learningId: string): void }): JSX.Element {
  return (
    <dl className="kv" aria-label="Lifecycle">
      <Row label="State">{learning.state === 'active' ? 'Active' : 'Retired'}</Row>
      <Row label="Revision">{learning.revision}</Row>
      <Row label="Replaces"><LearningLink id={learning.replaces} onOpen={onOpenLearning} /></Row>
      <Row label="Replaced by"><LearningLink id={learning.replacedBy} onOpen={onOpenLearning} /></Row>
      {learning.retiredAt === null ? null : <Row label="Retired"><time dateTime={learning.retiredAt}>{learning.retiredAt}</time></Row>}
      {learning.retiredReason === null ? null : <Row label="Reason">{learning.retiredReason}</Row>}
      <Row label="Published"><time dateTime={learning.createdAt}>{learning.createdAt}</time></Row>
    </dl>
  )
}

const TARGET_WORDS = { pending: 'Pending', integrating: 'Integrating', integrated: 'Integrated', conflicted: 'Conflicted' } as const

/** The source card's published integration: the guardrail commit applied to each repository's target branch. */
function Integration({ learning }: { learning: LearningView }): JSX.Element {
  const { integration } = learning
  return (
    <section aria-label="Integration">
      <h3 className="learnings-subtitle">Integration</h3>
      {integration === undefined ? (
        <p className="muted">No integration of the source card is recorded on this clone.</p>
      ) : (
        <>
          <p className="mono muted">{integration.operationId}</p>
          <dl className="kv">
            {integration.targets.map((target) => (
              <Row key={target.repository ?? ''} label={target.repository ?? 'Repository root'}>
                <span>
                  {TARGET_WORDS[target.state]} on <span className="mono">{target.branch}</span>
                  {target.newHead === null ? null : <> at <span className="mono">{target.newHead.slice(0, 12)}</span></>}
                  <span className="muted">{` (base ${target.baseCommit.slice(0, 7)})`}</span>
                </span>
              </Row>
            ))}
          </dl>
        </>
      )}
    </section>
  )
}

/** One learning: what it says, where it applies, where it came from, its lifecycle and its append-only history. */
export function LearningDetail({ folder, data, onOpenLearning, onOpenSource, onChanged, onReload }: DetailProps): JSX.Element {
  const { learning, history } = data.detail
  const { applicability } = learning
  return (
    <article className="card learnings-detail" aria-label={`Learning ${learning.title}`}>
      <h2 className="card-title">{learning.title}</h2>
      <p className="mono muted">{learning.id}</p>
      <h3 className="learnings-subtitle">Rule</h3>
      <p className="learnings-text">{learning.rule}</p>
      <h3 className="learnings-subtitle">Check</h3>
      <p className="learnings-text">{learning.check}</p>
      <dl className="kv" aria-label="Applies to">
        <Row label="Roles">{listOrAny(applicability.roles, 'None')}</Row>
        <Row label="Events">{listOrAny(applicability.events, 'Any event')}</Row>
        <Row label="Paths">{listOrAny(applicability.paths, 'Any path')}</Row>
      </dl>
      <Lifecycle learning={learning} onOpenLearning={onOpenLearning} />
      <LearningActions key={`${learning.id}:${learning.revision}`} folder={folder} learning={learning} onChanged={onChanged} onReload={onReload} />
      <Provenance learning={learning} run={data.run} card={data.card} onOpenSource={onOpenSource} />
      <Integration learning={learning} />
      <History history={history} onOpenLearning={onOpenLearning} />
    </article>
  )
}
