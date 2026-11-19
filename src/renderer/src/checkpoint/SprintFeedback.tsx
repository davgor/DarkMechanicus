/**
 * The sprint's one optional satisfaction/confidence rating, beside its report's Scorecard. It reads the sprint's signals
 * as they stand now (`getSpaceSignals`), says whether the sprint has a rating and whether its tickets inherit it, lists
 * every rating with where it was recorded, and lets the person record one, choosing explicitly whether to share it with
 * the sprint's tickets. A ticket's own rating, on its Scorecard tab, overrides the shared one; nothing is asked per
 * ticket. A rating recorded after the report froze its scorecard never changes that snapshot: it shows in a reassessment.
 */
import type { ReportScoreSource } from './ReportScorecard'
import { useState } from 'react'
import { RatingForm } from '../scorecard/FeedbackControls'
import { sprintSatisfactionText } from '../scorecard/feedbackForm'
import { ScoreReadNotice, Section } from '../scorecard/ScorecardParts'
import { localTime, provenanceText } from '../scorecard/scorecardFormat'
import { useScoreRead } from '../scorecard/useScoreRead'

interface SprintFeedbackProps {
  source: ReportScoreSource
  epicId: string
  runId: string
  sprintId: string
  /** How the sprint is named ("Sprint 2"). */
  sprintLabel: string
  /** The scorecard shown above is a frozen snapshot (or a legacy report), which a new rating never changes. */
  frozen: boolean
  /** Called once a rating is stored, so a live scorecard is read again. */
  onRecorded(): void
}

export function SprintFeedback(props: SprintFeedbackProps): JSX.Element {
  const [asked, setAsked] = useState(0)
  const state = useScoreRead({
    folder: props.source.folderPath,
    identity: { kind: 'sprintSignals', runId: props.runId, sprintId: props.sprintId },
    version: `${props.source.version}:${asked}`,
    scheduler: props.source.scheduler
  })
  const refresh = (): void => setAsked((count) => count + 1)
  const recorded = (): void => {
    refresh()
    props.onRecorded()
  }
  return (
    <Section title="SPRINT FEEDBACK" label="Sprint feedback">
      {state.status !== 'ready' ? (
        <ScoreReadNotice state={state} what="the sprint's feedback" onRetry={refresh} />
      ) : (
        <>
          <p className="sc-note">{sprintSatisfactionText(state.data.S)}</p>
          <ul className="sc-feedback">
            {state.data.S.ratings.map((entry) => (
              <li key={entry.observationId}>
                <span>
                  {entry.value ?? '—'} of 5 · {entry.sharedWithTickets === true ? 'shared with the tickets' : 'not shared'} · by {entry.person} at {localTime(entry.recordedAt)}
                </span>
                <span className="sc-note">Recorded by: {provenanceText(entry.recordedBy)}</span>
              </li>
            ))}
          </ul>
          {props.frozen ? (
            <p className="sc-note">The scorecard above was frozen with the report: a rating recorded now never changes it. It shows in a later reassessment.</p>
          ) : null}
          <p className="sc-note">Optional and asked once per sprint. A ticket&apos;s own rating, on its Scorecard tab, overrides a shared sprint rating for that ticket.</p>
          <RatingForm
            folderPath={props.source.folderPath}
            subject={props.sprintLabel}
            scope="sprint"
            saved={state.data.S.input.sprintRating === null ? null : { value: state.data.S.input.sprintRating.value, sharedWithTickets: state.data.S.input.sprintRating.sharedWithTickets }}
            target={{ epicId: props.epicId, sprintId: props.sprintId, runId: props.runId }}
            onRecorded={recorded}
          />
        </>
      )}
    </Section>
  )
}
