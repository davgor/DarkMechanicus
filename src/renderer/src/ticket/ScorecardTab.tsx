import { useEffect, useRef, useState } from 'react'
import type { AttemptView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { PlannedReviewForm, RatingForm, RescueForm } from '../scorecard/FeedbackControls'
import { GradingPolicyDetails } from '../scorecard/GradingPolicy'
import { ComponentBreakdown, type EvidenceOpener, Freshness, GradeHeadline, ScoreReadNotice } from '../scorecard/ScorecardParts'
import type { TicketCardView } from '../scorecard/scoreReads'
import { useScoreRead } from '../scorecard/useScoreRead'
import { AttemptsSection, CorrectionsSection, FeedbackSection, ReportSection, UsageAndTime } from './scorecardSections'
import { scorecardRuns } from './ticketView'

export interface ScorecardTabProps {
  folderPath: string
  epicId: string
  ticketId: string
  attempts: AttemptView[]
  /** The run the person chose; null follows the run of the ticket's newest work attempt. */
  runId: string | null
  onChooseRun(runId: string): void
  scheduler: Scheduler
  /** Changes whenever the workspace reloads: the scorecard is read again in place. */
  reloadKey: unknown
  opener: EvidenceOpener
}

/** How many times `value` has changed since mount: a read version that moves only when the workspace reloads. */
function useChangeCount(value: unknown): number {
  const seen = useRef({ value, count: 0 })
  if (!Object.is(seen.current.value, value)) {
    seen.current = { value, count: seen.current.count + 1 }
  }
  return seen.current.count
}

/** Each run's display number (`Run #N`, as the app names runs), read once per set of runs; absent until it arrives. */
function useRunNumbers(folder: string, runIds: string[]): ReadonlyMap<string, number> {
  const [numbers, setNumbers] = useState<ReadonlyMap<string, number>>(new Map())
  const key = runIds.join(',')
  useEffect(() => {
    let active = true
    const ids = key === '' ? [] : key.split(',')
    void Promise.all(ids.map((runId) => runCommand(folder, 'getRun', { runId }).catch(() => null))).then((runs) => {
      if (active) setNumbers(new Map(runs.flatMap((run) => (run === null ? [] : [[run.id, run.number] as const]))))
    })
    return () => {
      active = false
    }
  }, [folder, key])
  return numbers
}

function runLabel(numbers: ReadonlyMap<string, number>, runId: string): string {
  const number = numbers.get(runId)
  return number === undefined ? `Run ${runId}` : `Run #${number}`
}

function RunPicker(props: { runIds: string[]; runId: string; numbers: ReadonlyMap<string, number>; onChoose(runId: string): void }): JSX.Element {
  if (props.runIds.length < 2) {
    return (
      <p className="sc-note">
        <span title={props.runId}>{runLabel(props.numbers, props.runId)}</span>
      </p>
    )
  }
  return (
    <label className="sc-run">
      <span>Run</span>
      <select value={props.runId} title={props.runId} onChange={(event) => props.onChoose(event.target.value)}>
        {props.runIds.map((id, index) => (
          <option key={id} value={id} title={id}>
            {runLabel(props.numbers, id)}
            {index === 0 ? ' (latest)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

interface CardProps {
  card: TicketCardView
  readAt: number
  runLabel: string
  opener: EvidenceOpener
  onRefresh(): void
  /** Where the person's own inputs go: this folder, the ticket and the run shown. */
  inputs: { folderPath: string; epicId: string; ticketId: string; runId: string }
}

/** The person's optional inputs about this ticket: its own rating (which overrides the sprint's), rescue and planned review. */
function TicketInputs({ card, inputs, onRefresh }: Pick<CardProps, 'card' | 'inputs' | 'onRefresh'>): JSX.Element {
  const { input: { ticketRating: own }, rescue, plannedReview } = card.grade.sources.signals.S
  const { folderPath, epicId, ticketId, runId } = inputs
  return (
    <>
      <p className="sc-note">All optional: leave these alone and nothing is recorded. Only what you enter here is a person&apos;s answer.</p>
      <RatingForm
        folderPath={folderPath}
        subject="this ticket"
        scope="ticket"
        saved={own === null ? null : { value: own.value, sharedWithTickets: null }}
        target={{ epicId, ticketId }}
        onRecorded={onRefresh}
      />
      <RescueForm folderPath={folderPath} target={{ epicId, ticketId, runId }} recorded={rescue.length} onRecorded={onRefresh} />
      <PlannedReviewForm folderPath={folderPath} target={{ epicId, ticketId, runId }} recorded={plannedReview.length} onRecorded={onRefresh} />
    </>
  )
}

function Card({ card, readAt, runLabel: label, opener, onRefresh, inputs }: CardProps): JSX.Element {
  return (
    <>
      <GradeHeadline grade={card.grade.grade} />
      <ComponentBreakdown grade={card.grade.grade} opener={opener} />
      <GradingPolicyDetails folderPath={inputs.folderPath} />
      <UsageAndTime grade={card.grade} runLabel={label} timing={card.timing} onRetry={onRefresh} />
      <AttemptsSection grade={card.grade} timing={card.timing} usage={card.usage} readAt={readAt} opener={opener} onRetry={onRefresh} />
      <CorrectionsSection grade={card.grade} opener={opener} />
      <FeedbackSection grade={card.grade}>
        <TicketInputs card={card} inputs={inputs} onRefresh={onRefresh} />
      </FeedbackSection>
      <ReportSection report={card.report} onRetry={onRefresh} />
      {card.grade.anomalies.length === 0 ? null : (
        <ul className="sc-deductions" aria-label="Read anomalies">
          {card.grade.anomalies.map((anomaly) => (
            <li key={anomaly.detail}>{anomaly.detail}</li>
          ))}
        </ul>
      )}
    </>
  )
}

function RunScorecard(props: ScorecardTabProps & { runId: string; runLabel: string }): JSX.Element {
  const [asked, setAsked] = useState(0)
  const reloads = useChangeCount(props.reloadKey)
  const state = useScoreRead({
    folder: props.folderPath,
    identity: { kind: 'ticketCard', runId: props.runId, ticketId: props.ticketId },
    version: `${reloads}:${asked}`,
    scheduler: props.scheduler
  })
  const refresh = (): void => setAsked((count) => count + 1)
  if (state.status !== 'ready') {
    return <ScoreReadNotice state={state} what="the scorecard" onRetry={refresh} />
  }
  return (
    <>
      <Freshness loadedAt={state.loadedAt} cutoff={state.data.grade.cutoff} refreshError={state.refreshError} onRefresh={refresh} />
      <Card
        card={state.data}
        readAt={state.loadedAt}
        runLabel={props.runLabel}
        opener={props.opener}
        onRefresh={refresh}
        inputs={{ folderPath: props.folderPath, epicId: props.epicId, ticketId: props.ticketId, runId: props.runId }}
      />
    </>
  )
}

/**
 * A ticket's scorecard in one run: the grade and its state, the seven components with their contributions, usage and
 * time, attempts, corrections, feedback and the report's original versus reassessed grade. Every number is the core's.
 */
export function ScorecardTab(props: ScorecardTabProps): JSX.Element {
  const { runIds, latest } = scorecardRuns(props.attempts)
  const numbers = useRunNumbers(props.folderPath, runIds)
  const runId = props.runId !== null && runIds.includes(props.runId) ? props.runId : latest
  if (runId === null) {
    return <p className="ew-muted">No run has worked on this ticket yet, so it has no scorecard: nothing is graded before a run dispatches it.</p>
  }
  return (
    <div className="sc-tab">
      <RunPicker runIds={runIds} runId={runId} numbers={numbers} onChoose={props.onChooseRun} />
      <RunScorecard {...props} runId={runId} runLabel={runLabel(numbers, runId)} />
    </div>
  )
}
