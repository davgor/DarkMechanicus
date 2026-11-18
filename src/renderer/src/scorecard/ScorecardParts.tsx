/**
 * Presentation shared by every scorecard view (ticket, sprint, run, epic, report): the read's loading and error states,
 * its freshness, the grade's headline and its seven-component breakdown with each component's contribution and
 * evidence, and the labelled sections and fact lists the views are laid out in. Everything shown is the core's read
 * model; nothing here grades.
 */
import './scorecard.css'
import type { ReactNode } from 'react'
import { SPACE_COMPONENT_LABELS, type EvidenceRef, type SpaceComponentResult, type SpaceGrade } from '../../../shared/domain/space'
import { StatePill } from '../epic/StatePill'
import type { ScoreReadError, ScoreReadState } from './scoreReads'
import {
  baselineText,
  displayedPoints,
  evidenceText,
  gradeState,
  localTime,
  MISSING_REASON_LABELS,
  percentText,
  scoreText,
  shortHash,
  STATUS_REASON_LABELS,
  weightText
} from './scorecardFormat'

export interface FactRow {
  label: string
  value: ReactNode
}

/** Labelled facts, one per row. */
export function Facts({ label, rows }: { label: string; rows: FactRow[] }): JSX.Element {
  return (
    <dl className="sc-facts" aria-label={label}>
      {rows.map((row) => (
        <div key={row.label} className="sc-fact">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A titled scorecard section, named for assistive technology by `label`. */
export function Section(props: { title: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="tp-section" aria-label={props.label}>
      <h3 className="ew-eyebrow">{props.title}</h3>
      {props.children}
    </section>
  )
}

/** Opens the record a citation names, where the view can show it. */
export interface EvidenceOpener {
  /** The label of the place `ref` opens (`Attempts`, `Evidence`), or null when it has no view here. */
  target(ref: EvidenceRef): string | null
  open(ref: EvidenceRef): void
}

const ACTION_HINTS: Readonly<Record<ScoreReadError['action'], string>> = {
  retry: 'It may work if you try again.',
  reload: 'The records changed underneath; reload to read them again.',
  not_permitted: 'This session may not read it.',
  not_found: 'It does not exist in this folder.',
  fix_input: 'The request was refused.'
}

export function ScoreError({ error, onRetry }: { error: ScoreReadError; onRetry(): void }): JSX.Element {
  const retryable = error.action === 'retry' || error.action === 'reload'
  return (
    <div role="alert" className="sc-error">
      <p>
        {error.message} {ACTION_HINTS[error.action]}
      </p>
      {retryable ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

/** What a read shows before its data: nothing selected, loading, or the error that kept it from loading. */
export function ScoreReadNotice<T>({ state, what, onRetry }: { state: ScoreReadState<T>; what: string; onRetry(): void }): JSX.Element | null {
  switch (state.status) {
    case 'idle':
      return <p className="ew-muted">Nothing selected.</p>
    case 'loading':
      return (
        <p role="status" className="ew-muted sc-loading">
          Loading {what}…
        </p>
      )
    case 'error':
      return <ScoreError error={state.error} onRetry={onRetry} />
    case 'ready':
      return null
  }
}

/**
 * When the data was read, the records' cutoff, how it stays current, and a failed refresh beside the data it kept. A
 * view that is not polled (`polled: false`, a frozen assessment) says it is read again only on Refresh or a reload.
 */
export function Freshness(props: { loadedAt: number; cutoff: string; refreshError: ScoreReadError | null; onRefresh(): void; polled?: boolean }): JSX.Element {
  return (
    <div className="sc-freshness" aria-label="Data freshness">
      <span>
        Read {localTime(props.loadedAt)} · records up to <time dateTime={props.cutoff}>{localTime(props.cutoff)}</time> ·{' '}
        {props.polled === false ? 'frozen: not polled, read again on Refresh or when the workspace reloads' : 'refreshes on its own'}
      </span>
      <button type="button" className="btn btn-ghost" onClick={props.onRefresh}>
        Refresh
      </button>
      {props.refreshError === null ? null : (
        <p role="alert" className="sc-stale">
          The last refresh failed ({props.refreshError.message}); showing the data read {localTime(props.loadedAt)}.
        </p>
      )}
    </div>
  )
}

function Explanation({ grade }: { grade: SpaceGrade }): JSX.Element {
  const lines = [grade.explanation.composite, grade.explanation.cap, grade.explanation.letter].filter((line): line is string => line !== null)
  return (
    <ul className="sc-explanation" aria-label="How the grade follows">
      {[...lines, ...grade.explanation.status].map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}

/** The grade's state, letter and score, coverage, policy and cutoff, and how the result follows from the components. */
export function GradeHeadline({ grade }: { grade: SpaceGrade }): JSX.Element {
  const state = gradeState(grade)
  const policy = grade.policy
  return (
    <section className="sc-headline" aria-label="Grade">
      <div className="sc-headline-row">
        <span className="sc-letter" aria-label={grade.letter === null ? 'No letter' : `Letter ${grade.letter}`}>
          {grade.letter ?? '—'}
        </span>
        <div className="sc-headline-facts">
          <StatePill tone={state.tone} label={state.label} />
          <span className="sc-score">{grade.displayScore === null ? 'No score' : `Score ${grade.displayScore}`}</span>
          <span>
            Coverage {percentText(grade.coverage)} of base weight · {grade.scoredComponents} of {grade.components.length} components scored
          </span>
          <span className="ew-mono sc-policy" title={policy.hash}>
            Policy {policy.policyId} v{policy.version} · {shortHash(policy.hash)}
          </span>
        </div>
      </div>
      {grade.statusReasons.length === 0 ? null : (
        <p className="sc-reasons">
          Status {grade.status}: {grade.statusReasons.map((reason) => STATUS_REASON_LABELS[reason]).join('; ')}
        </p>
      )}
      <Explanation grade={grade} />
    </section>
  )
}

export function EvidenceList({ refs, opener }: { refs: EvidenceRef[]; opener: EvidenceOpener }): JSX.Element | null {
  if (refs.length === 0) {
    return null
  }
  return (
    <ul className="sc-evidence" aria-label="Evidence">
      {refs.map((ref) => {
        const target = opener.target(ref)
        const key = `${ref.kind}:${ref.id}:${ref.detail ?? ''}`
        return (
          <li key={key}>
            {target === null ? (
              <span className="ew-mono" title="Not viewable here">
                {evidenceText(ref)}
              </span>
            ) : (
              <button type="button" className="sc-link ew-mono" onClick={() => opener.open(ref)} title={`Open in ${target}`}>
                {evidenceText(ref)} → {target}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ComponentScore({ result, points }: { result: SpaceComponentResult; points: string | null }): JSX.Element {
  if (result.score === null || points === null) {
    const reason = result.missingReason === null ? result.state : MISSING_REASON_LABELS[result.missingReason]
    return <span className="sc-missing">No score: {reason}. Carries no weight (never read as 0).</span>
  }
  return (
    <span>
      <strong>{scoreText(result.score)}</strong> × weight {weightText(result.effectiveWeight)} = <strong>{points}</strong> points
      {result.state === 'estimated' ? ' (estimated)' : ''}
    </span>
  )
}

function ComponentRow({ result, points, opener }: { result: SpaceComponentResult; points: string | null; opener: EvidenceOpener }): JSX.Element {
  const unit = result.component === 'K' ? 'tokens' : 'milliseconds'
  const baseline = result.explanation.baseline
  return (
    <li className={result.score === null ? 'sc-component is-missing' : 'sc-component'} aria-label={SPACE_COMPONENT_LABELS[result.component]}>
      <div className="sc-component-head">
        <span className="sc-component-key ew-mono">{result.component}</span>
        <span className="sc-component-name">{SPACE_COMPONENT_LABELS[result.component]}</span>
        <span className="ew-chip">{result.required ? 'required' : 'optional'}</span>
        {result.inherited ? <span className="ew-chip">inherited</span> : null}
      </div>
      <ComponentScore result={result} points={points} />
      <p className="sc-rule">
        <span className="ew-mono">{result.rule}</span> · {result.explanation.normalization}
      </p>
      {baseline === null ? null : <p className="sc-rule">Baseline {baseline.baselineId}: {baselineText(baseline, unit)}</p>}
      <EvidenceList refs={result.evidence} opener={opener} />
    </li>
  )
}

/**
 * The seven components in display order: score, effective weight and points, rule, baseline and evidence. The points
 * shown add up to the composite before any cap, as displayed (see `displayedPoints`).
 */
export function ComponentBreakdown({ grade, opener }: { grade: SpaceGrade; opener: EvidenceOpener }): JSX.Element {
  const points = displayedPoints(grade)
  return (
    <section className="tp-section" aria-label="Component breakdown">
      <h3 className="ew-eyebrow">SEVEN COMPONENTS</h3>
      {grade.uncappedScore === null ? null : (
        <p className="sc-note">
          Each component&apos;s points are rounded to one decimal so they add up to {scoreText(grade.uncappedScore)}, the weighted mean of the scored
          components{grade.caps.length === 0 ? '' : ' before the cap'}; components with the same score and weight may therefore differ by 0.1.
        </p>
      )}
      <ul className="sc-components">
        {grade.components.map((result) => (
          <ComponentRow key={result.component} result={result} points={points.get(result.component) ?? null} opener={opener} />
        ))}
      </ul>
    </section>
  )
}
