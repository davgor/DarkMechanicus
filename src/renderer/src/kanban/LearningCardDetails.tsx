import { type ReactNode, useEffect, useId, useState } from 'react'
import type { KanbanAttemptView, KanbanCardView, KanbanLearningReviewView, LearningItemDisposition, LearningSubmissionEvidence } from '../../../shared/domain/kanban'
import type { LearningDraft, LearningEvidenceItem, StagedLearningDraftsView } from '../../../shared/domain/learnings'
import { errorMessage, runCommand } from '../api/dm'
import { learningCardStatus } from './learningCardStatus'

/** The drafts staged with the newest submission, read with `getStagedLearningDrafts`; what a reviewer approves. */
export type StagedDrafts =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; staged: StagedLearningDraftsView }

/** The newest attempt that submitted a learning block: the one the review shows and an approval names. */
function reviewedAttempt(card: KanbanCardView): (KanbanAttemptView & { learning: LearningSubmissionEvidence }) | null {
  for (const attempt of [...card.attempts].reverse()) {
    const learning = attempt.evidence?.learning
    if (learning !== undefined) return { ...attempt, learning }
  }
  return null
}

/** Reads the reviewed attempt's staged drafts whenever the card or the folder's events change. */
export function useStagedDrafts(folderPath: string, card: KanbanCardView, refreshToken: number): StagedDrafts {
  const attemptId = reviewedAttempt(card)?.id ?? null
  const [state, setState] = useState<{ attemptId: string | null; drafts: StagedDrafts }>({ attemptId: null, drafts: { status: 'none' } })
  useEffect(() => {
    if (attemptId === null) return undefined
    let live = true
    runCommand(folderPath, 'getStagedLearningDrafts', { attemptId }).then(
      (staged) => {
        if (live) setState({ attemptId, drafts: { status: 'ready', staged } })
      },
      (error: unknown) => {
        if (live) setState({ attemptId, drafts: { status: 'error', message: errorMessage(error) } })
      }
    )
    return () => {
      live = false
    }
  }, [folderPath, attemptId, refreshToken])
  if (attemptId === null) return { status: 'none' }
  return state.attemptId === attemptId ? state.drafts : { status: 'loading' }
}

const KIND_LABELS: Record<LearningEvidenceItem['kind'], string> = {
  rejected_attempt: 'Rejected attempt',
  failed_attempt: 'Failed attempt',
  reconciled_attempt: 'Reconciled attempt',
  failed_row_check: 'Failed row check',
  failed_acceptance_check: 'Failed acceptance check',
  retro_went_poorly: 'Retro: went poorly',
  retro_action: 'Retro action'
}

const DISPOSITION_LABELS: Record<LearningItemDisposition['disposition'], string> = {
  learning: 'Learning',
  duplicate: 'Duplicate',
  not_reusable: 'Not reusable'
}

const itemKey = (kind: string, sourceId: string): string => `${kind}\u0000${sourceId}`
const short = (commit: string): string => commit.slice(0, 7)

/** Where an item came from, as the evidence is grouped: its ticket, else the sprint report or the run. */
function sourceGroup(item: LearningEvidenceItem): string {
  if (item.provenance.ticketKey !== null) return `Ticket ${item.provenance.ticketKey}`
  return item.provenance.reportId === null ? 'Run' : 'Sprint report'
}

function groupItems(items: readonly LearningEvidenceItem[]): [string, LearningEvidenceItem[]][] {
  const groups = new Map<string, LearningEvidenceItem[]>()
  for (const item of items) groups.set(sourceGroup(item), [...(groups.get(sourceGroup(item)) ?? []), item])
  return [...groups]
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function StatusBanner({ card, review }: { card: KanbanCardView; review: KanbanLearningReviewView }): JSX.Element {
  const status = learningCardStatus(card, review)
  return (
    <section className={`tp-section lc-status tone-${status.tone}`} aria-label="Learning status" role="status">
      <h3 className="lc-status-title">{status.title}</h3>
      <p>{status.records}</p>
      <p>{status.repositories}</p>
      {status.failure === null ? null : <p className="lc-failure">{status.failure}</p>}
    </section>
  )
}

function Provenance({ review }: { review: KanbanLearningReviewView }): JSX.Element {
  const snapshot = review.snapshot
  return (
    <section className="tp-section" aria-label="Provenance">
      <h3 className="ew-eyebrow">PROVENANCE</h3>
      <dl className="kv lc-kv">
        <Row label="Run"><span className="ew-mono">{review.runId}</span></Row>
        <Row label="Sprint"><span className="ew-mono">{snapshot === null ? review.sprintId : `Sprint ${snapshot.sprintOrdinal} · ${review.sprintId}`}</span></Row>
        <Row label="Report"><span className="ew-mono">{snapshot?.report === null || snapshot === null ? review.reportId : `${review.reportId} r${snapshot.report.reportRevision}`}</span></Row>
        {review.checkpointId === null ? null : <Row label="Checkpoint"><span className="ew-mono">{review.checkpointId}</span></Row>}
        <Row label="Snapshot"><span className="ew-mono">{review.evidenceHash.slice(0, 19)}</span></Row>
      </dl>
    </section>
  )
}

interface EvidenceProps {
  review: KanbanLearningReviewView
  dispositions: ReadonlyMap<string, LearningItemDisposition>
  citedBy: ReadonlyMap<string, string[]>
  anchor(kind: string, sourceId: string): string
}

function EvidenceItem({ item, props }: { item: LearningEvidenceItem; props: EvidenceProps }): JSX.Element {
  const key = itemKey(item.kind, item.sourceId)
  const disposition = props.dispositions.get(key)
  const cited = props.citedBy.get(key) ?? []
  return (
    <li id={props.anchor(item.kind, item.sourceId)} tabIndex={-1} className="lc-item" aria-label={`${KIND_LABELS[item.kind]} ${item.sourceId}`}>
      <div className="lc-item-head">
        <span>{KIND_LABELS[item.kind]}</span>
        {item.provenance.attemptNumber === null ? null : <span className="ew-muted">{`attempt #${item.provenance.attemptNumber}`}</span>}
        {item.standing ? null : <span className="ew-muted">superseded</span>}
        <span className={`lc-disposition is-${disposition?.disposition ?? 'missing'}`}>
          {disposition === undefined ? 'Not classified' : DISPOSITION_LABELS[disposition.disposition]}
        </span>
      </div>
      <span className="ew-mono ew-muted lc-id">{item.sourceId}</span>
      {item.statements.map((statement) => (
        <blockquote key={`${statement.field}:${statement.text}`} className="lc-quote">
          <span className="ew-muted">{statement.field}</span> {statement.text}
        </blockquote>
      ))}
      {disposition === undefined ? null : <p className="lc-reason"><span className="ew-muted">Reason: </span>{disposition.reason}</p>}
      {cited.length === 0 ? null : <p className="lc-reason"><span className="ew-muted">Cited by: </span>{cited.join(', ')}</p>}
    </li>
  )
}

function Evidence(props: EvidenceProps): JSX.Element {
  const items = props.review.snapshot?.items ?? []
  return (
    <section className="tp-section" aria-label="Sprint evidence">
      <h3 className="ew-eyebrow">{`SPRINT EVIDENCE (${items.length})`}</h3>
      {props.review.snapshot === null ? <p className="ew-muted">This card was generated before evidence snapshots were stored.</p> : null}
      {props.review.snapshot !== null && items.length === 0 ? (
        <p className="ew-muted">The evidence snapshot is empty: this sprint recorded no rejected or failed work and no retro concerns.</p>
      ) : null}
      {groupItems(items).map(([group, groupItemsList]) => (
        <section key={group} className="lc-group" aria-label={group}>
          <h4 className="lc-group-title">{group}</h4>
          <ul className="lc-items">
            {groupItemsList.map((item) => <EvidenceItem key={itemKey(item.kind, item.sourceId)} item={item} props={props} />)}
          </ul>
        </section>
      ))}
    </section>
  )
}

const list = (items: readonly string[], none: string): string => (items.length === 0 ? none : items.join(', '))

function DraftCard({ draft, anchor }: { draft: LearningDraft; anchor(kind: string, sourceId: string): string }): JSX.Element {
  return (
    <li className="lc-draft" aria-label={`Proposed learning ${draft.title}`}>
      <h4 className="lc-draft-title">{draft.title}</h4>
      <p className="lc-text">{draft.rule}</p>
      <p className="lc-text"><span className="ew-muted">Check: </span>{draft.check}</p>
      <dl className="kv lc-kv">
        <Row label="Roles"><span className="ew-mono">{draft.applicability.roles.join(', ')}</span></Row>
        <Row label="Events"><span className="ew-mono">{list(draft.applicability.events, 'Any event')}</span></Row>
        <Row label="Paths"><span className="ew-mono">{list(draft.applicability.paths, 'Any path')}</span></Row>
        {draft.replaces === null ? null : <Row label="Replaces"><span className="ew-mono">{draft.replaces}</span></Row>}
      </dl>
      <p className="ew-muted lc-cites-label">Cites</p>
      <ul className="lc-cites">
        {draft.evidence.map((ref) => (
          <li key={itemKey(ref.kind, ref.sourceId)}>
            <button type="button" className="sc-link" onClick={() => document.getElementById(anchor(ref.kind, ref.sourceId))?.focus()}>
              {`${KIND_LABELS[ref.kind]} ${ref.sourceId}`}
            </button>
          </li>
        ))}
      </ul>
    </li>
  )
}

function Drafts({ drafts, anchor }: { drafts: StagedDrafts; anchor(kind: string, sourceId: string): string }): JSX.Element {
  const body = ((): ReactNode => {
    if (drafts.status === 'none') return <p className="ew-muted">No learnings were submitted yet.</p>
    if (drafts.status === 'loading') return <p className="ew-muted" role="status" aria-busy="true">Loading the proposed learnings…</p>
    if (drafts.status === 'error') return <p role="alert" className="tp-error">{`Could not read the proposed learnings: ${drafts.message}`}</p>
    if (drafts.staged.drafts.length === 0) return <p className="ew-muted">The submission proposes no learning: approving publishes no records.</p>
    return <ol className="lc-drafts">{drafts.staged.drafts.map((draft) => <DraftCard key={draft.title} draft={draft} anchor={anchor} />)}</ol>
  })()
  return (
    <section className="tp-section" aria-label="Proposed learnings">
      <h3 className="ew-eyebrow">PROPOSED LEARNINGS</h3>
      {body}
    </section>
  )
}

const TARGET_LABELS = { pending: 'Pending', integrating: 'Integrating', integrated: 'Integrated', conflicted: 'Conflicted' } as const

type Target = NonNullable<KanbanLearningReviewView['integration']>['targets'][number]
type Manifest = LearningSubmissionEvidence['manifests'][number]

function Verified({ manifest }: { manifest: Manifest | undefined }): JSX.Element {
  if (manifest === undefined) return <span className="ew-muted">—</span>
  if (manifest.passed) return <span>Passed</span>
  return <span>{`Failed: ${manifest.checks.filter((check) => check.status === 'failed').map((check) => check.detail).join('; ')}`}</span>
}

function TargetState({ target }: { target: Target | undefined }): JSX.Element {
  if (target === undefined) return <span className="ew-muted">Not started</span>
  const from = target.oldHead === null ? '' : `${short(target.oldHead)} → `
  return (
    <span>
      {TARGET_LABELS[target.state]}
      {target.newHead === null ? null : <span className="ew-mono">{` ${from}${short(target.newHead)}`}</span>}
      {` on ${target.branch}`}
    </span>
  )
}

function RepositoryRow({ branch, review, learning }: { branch: KanbanLearningReviewView['branches'][number]; review: KanbanLearningReviewView; learning: LearningSubmissionEvidence | null }): JSX.Element {
  const manifest = learning?.manifests.find((item) => item.repo === branch.repo)
  const name = branch.repo ?? 'Repository root'
  return (
    <li className="lc-repo" aria-label={name}>
      <span className="lc-repo-name">{name}</span>
      <dl className="kv lc-kv">
        <Row label="Base"><span className="ew-mono">{`${branch.base.branch} @ ${short(branch.base.commit)}`}</span></Row>
        <Row label="Branch"><span className="ew-mono">{branch.branch}</span></Row>
        <Row label="Commit">{manifest === undefined ? <span className="ew-muted">Not submitted</span> : <span className="ew-mono">{short(manifest.commit)}</span>}</Row>
        <Row label="Verified"><Verified manifest={manifest} /></Row>
        <Row label="Integration"><TargetState target={review.integration?.targets.find((item) => item.repository === branch.repo)} /></Row>
      </dl>
    </li>
  )
}

function Repositories({ review, learning }: { review: KanbanLearningReviewView; learning: LearningSubmissionEvidence | null }): JSX.Element {
  return (
    <section className="tp-section" aria-label="Repositories">
      <h3 className="ew-eyebrow">REPOSITORIES</h3>
      {review.branches.length === 0 ? <p className="ew-muted">No completed increment was recorded, so no repository is affected.</p> : (
        <ul className="lc-repos">
          {review.branches.map((branch) => <RepositoryRow key={branch.repo ?? ''} branch={branch} review={review} learning={learning} />)}
        </ul>
      )}
    </section>
  )
}

function Publication({ review }: { review: KanbanLearningReviewView }): JSX.Element {
  const publication = review.publication
  return (
    <section className="tp-section" aria-label="Publication">
      <h3 className="ew-eyebrow">PUBLICATION</h3>
      {publication === null ? <p className="ew-muted">Not published: no learning record from this card exists.</p> : (
        <>
          <p>{`Published ${publication.recordIds.length} learning record${publication.recordIds.length === 1 ? '' : 's'} on ${publication.publishedAt.slice(0, 10)}.`}</p>
          {publication.recordIds.length === 0 ? null : <p className="ew-mono ew-muted">{publication.recordIds.join(' · ')}</p>}
        </>
      )}
    </section>
  )
}

interface LearningCardDetailsProps {
  card: KanbanCardView
  review: KanbanLearningReviewView
  drafts: StagedDrafts
}

/** Each evidence item's disposition and citing drafts, and its position in the snapshot (its focus anchor). */
function indexReview(review: KanbanLearningReviewView, learning: LearningSubmissionEvidence | null, drafts: StagedDrafts) {
  const dispositions = new Map((learning?.dispositions ?? []).map((item) => [itemKey(item.kind, item.sourceId), item]))
  const citedBy = new Map<string, string[]>()
  for (const draft of drafts.status === 'ready' ? drafts.staged.drafts : []) {
    for (const ref of draft.evidence) citedBy.set(itemKey(ref.kind, ref.sourceId), [...(citedBy.get(itemKey(ref.kind, ref.sourceId)) ?? []), draft.title])
  }
  const order = new Map((review.snapshot?.items ?? []).map((item, index) => [itemKey(item.kind, item.sourceId), index]))
  return { dispositions, citedBy, order }
}

/**
 * The review surface of a sprint learning card: where it stands, where its evidence came from, every evidence item
 * with the submission's disposition and reason, the proposed learnings and what they cite, each repository's branch,
 * commit, verification and integration, and the publication.
 */
export function LearningCardDetails({ card, review, drafts }: LearningCardDetailsProps): JSX.Element {
  const prefix = useId()
  const learning = reviewedAttempt(card)?.learning ?? null
  const { dispositions, citedBy, order } = indexReview(review, learning, drafts)
  const anchor = (kind: string, sourceId: string): string => `${prefix}-evidence-${order.get(itemKey(kind, sourceId)) ?? 'missing'}`
  return (
    <div className="lc-details" aria-label="Learning review">
      <StatusBanner card={card} review={review} />
      <Provenance review={review} />
      <Drafts drafts={drafts} anchor={anchor} />
      <Evidence review={review} dispositions={dispositions} citedBy={citedBy} anchor={anchor} />
      <Repositories review={review} learning={learning} />
      <Publication review={review} />
    </div>
  )
}
