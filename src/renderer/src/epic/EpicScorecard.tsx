import './epicScorecard.css'
import { useEffect, useRef, useState } from 'react'
import type { Scheduler } from '../app/scheduler'
import { ComponentBreakdown, type EvidenceOpener, Freshness, GradeHeadline, ScoreReadNotice } from '../scorecard/ScorecardParts'
import type { EpicAssessment, EpicCardView, ScoreIdentity, ScoreReadState } from '../scorecard/scoreReads'
import { localTime } from '../scorecard/scorecardFormat'
import { useScoreRead } from '../scorecard/useScoreRead'
import { StatePill } from './StatePill'
import { type CardContext, ComparisonsSection, FailureSection, OutcomeSection, ResourcesSection, SprintsSection } from './EpicScorecardSections'
import { epicTicketNames, gradedEpic, runLabel } from './epicScorecardView'
import type { WorkspaceHandle } from './useWorkspace'
import { planFor } from './workspaceState'

/** A completed epic's assessment is frozen: it is read when shown, on focus and on Refresh, never polled. */
const FROZEN: Scheduler = { after: () => () => undefined, every: () => () => undefined }

/** Opens what a citation names in the workspace: an attempt of the run shown, or a ticket of the plan shown. */
function workspaceOpener(ws: WorkspaceHandle): EvidenceOpener {
  const attempts = ws.data.run?.attempts ?? []
  const plan = planFor(ws.data, ws.state.view)
  const ticketOf = (attemptId: string): string | null => attempts.find((attempt) => attempt.id === attemptId)?.ticketId ?? null
  const held = (ticketId: string): boolean => plan?.bundle.tickets.some((ticket) => ticket.id === ticketId) ?? false
  return {
    target: (ref) => {
      if (ref.kind === 'attempt') return ticketOf(ref.id) === null ? null : 'Activity'
      return ref.kind === 'ticket' && held(ref.id) ? 'ticket' : null
    },
    open: (ref) => {
      const ticketId = ref.kind === 'attempt' ? ticketOf(ref.id) : ref.kind === 'ticket' && held(ref.id) ? ref.id : null
      if (ticketId === null) return
      ws.dispatch(ref.kind === 'attempt' ? { type: 'open_activity', ticketId, attemptId: ref.id } : { type: 'select_ticket', ticketId })
    }
  }
}

function cutoffOf(assessment: EpicAssessment): string | null {
  switch (assessment.state) {
    case 'live':
      return assessment.view.cutoff
    case 'frozen':
      return assessment.snapshot.cutoff
    case 'legacy':
      return assessment.report.submittedAt
    case 'not_frozen':
      return null
  }
}

/** What the assessment is and why it can or cannot change, above the grade. */
function AssessmentNote({ card }: { card: EpicCardView }): JSX.Element {
  const { assessment } = card
  switch (assessment.state) {
    case 'live':
      return (
        <p className="sc-note">
          Live: the epic graded now from every run&apos;s records ({assessment.view.runIds.map((runId) => runLabel(card, runId)).join(', ') || 'no run yet'}). It
          changes as work lands; nothing about the epic is frozen until its final sprint&apos;s report.
        </p>
      )
    case 'frozen':
      return (
        <p className="sc-note">
          Immutable: frozen with the final sprint&apos;s report (revision {assessment.report.reportRevision}, {runLabel(card, assessment.report.runId)}) submitted{' '}
          {localTime(assessment.report.submittedAt)}. This completed epic is read-only and this grade never changes; later records only appear in the
          comparison below.
        </p>
      )
    case 'legacy':
      return (
        <p className="sc-note">
          Ungraded (legacy): {assessment.reason} The epic is completed and read-only; no live grade stands in for the missing one.
        </p>
      )
    case 'not_frozen':
      return <p className="sc-note">Not graded: {assessment.reason} The epic is completed and read-only; no live grade stands in for it.</p>
  }
}

function modeLabel(assessment: EpicAssessment): { label: string; tone: 'running' | 'accepted' | 'neutral' } {
  if (assessment.state === 'live') return { label: 'Live assessment', tone: 'running' }
  return assessment.state === 'frozen' ? { label: 'Immutable assessment', tone: 'accepted' } : { label: 'Ungraded', tone: 'neutral' }
}

function CardBody({ card, ctx }: { card: EpicCardView; ctx: CardContext }): JSX.Element {
  const graded = gradedEpic(card.assessment)
  const mode = modeLabel(card.assessment)
  return (
    <>
      <div className="es-mode">
        <StatePill tone={mode.tone} label={mode.label} />
      </div>
      <AssessmentNote card={card} />
      {graded === null ? null : <GradeHeadline grade={graded.grade} />}
      {graded === null ? null : <OutcomeSection ctx={ctx} graded={graded} />}
      <SprintsSection ctx={ctx} />
      <ResourcesSection ctx={ctx} graded={graded} />
      {graded === null ? null : <FailureSection ctx={ctx} graded={graded} />}
      <ComparisonsSection ctx={ctx} graded={graded} />
      {graded === null ? null : <ComponentBreakdown grade={graded.grade} opener={ctx.opener} />}
    </>
  )
}

/** What the sections read beside the card: ticket names, which tickets open here, citations, and Try again. */
function cardContext(ws: WorkspaceHandle, card: EpicCardView, onRetry: () => void): CardContext {
  const plan = planFor(ws.data, ws.state.view)
  const held = new Set(plan?.bundle.tickets.map((ticket) => ticket.id) ?? [])
  return {
    card,
    names: epicTicketNames(card, plan?.bundle ?? null),
    ticketAction: (ticketId) => (held.has(ticketId) ? () => ws.dispatch({ type: 'select_ticket', ticketId }) : null),
    opener: workspaceOpener(ws),
    onRetry
  }
}

/** The body below the heading: an epic never saved has nothing to read; else the read's state, then the card. */
function ScorecardBody({ ws, state, completed, onRefresh }: { ws: WorkspaceHandle; state: ScoreReadState<EpicCardView>; completed: boolean; onRefresh(): void }): JSX.Element | null {
  if (ws.data.epic.currentRevisionId === null) {
    return <p className="ew-muted">No saved plan yet: nothing is graded until a plan is saved and a run dispatches its tickets.</p>
  }
  if (state.status !== 'ready') {
    return <ScoreReadNotice state={state} what="the epic scorecard" onRetry={onRefresh} />
  }
  const cutoff = cutoffOf(state.data.assessment) ?? new Date(state.loadedAt).toISOString()
  return (
    <>
      <Freshness loadedAt={state.loadedAt} cutoff={cutoff} refreshError={state.refreshError} onRefresh={onRefresh} polled={!completed} />
      <CardBody card={state.data} ctx={cardContext(ws, state.data, onRefresh)} />
    </>
  )
}

type EpicCardIdentity = Extract<ScoreIdentity, { kind: 'epicCard' }>

/**
 * The epic's Scorecard, shown in the stage instead of the plan: an open epic's live grade, or a completed epic's
 * immutable one, with the original scope and outcomes, a per-sprint drill-down, total resources, failure causes and
 * the comparisons compatible enough to show. Read-only: it offers no edit, approve or retry control. An epic never
 * saved reads nothing and says so.
 */
export function EpicScorecard({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const completed = ws.data.epic.status === 'completed'
  const saved = ws.data.epic.currentRevisionId !== null
  const [asked, setAsked] = useState(0)
  const state = useScoreRead<EpicCardIdentity>({
    folder: ws.folder.path,
    identity: saved ? { kind: 'epicCard', epicId: ws.epicId, completed } : null,
    version: `${ws.state.loadedAt ?? 0}:${asked}`,
    scheduler: completed ? FROZEN : ws.scheduler
  })
  const title = useRef<HTMLHeadingElement>(null)
  // Opened from the header: focus moves to the Scorecard's heading, so keyboard and screen reader users land in it.
  useEffect(() => title.current?.focus(), [])
  return (
    <section className="es" aria-labelledby="es-title">
      <div className="es-head">
        <h2 id="es-title" className="es-title" tabIndex={-1} ref={title}>
          Epic scorecard
        </h2>
      </div>
      <ScorecardBody ws={ws} state={state} completed={completed} onRefresh={() => setAsked((count) => count + 1)} />
    </section>
  )
}
