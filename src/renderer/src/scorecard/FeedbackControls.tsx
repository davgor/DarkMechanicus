/**
 * The person's own inputs beside a scorecard: a satisfaction/confidence rating (a sprint's, once, with an explicit
 * choice to share it with the sprint's tickets, or one ticket's own, which overrides it), rescue time and planned
 * review or playtesting time, each its own form. Everything is optional: leaving a form alone records nothing, and
 * nothing is filled in for the person. Each entry goes to `recordHumanFeedback` (desktop only, source `human`); a retry
 * of the same entry reuses its idempotency key, so a lost answer never records it twice. A rating chosen while another
 * one is recorded stays the person's choice, with the change shown (`EditBuffer`), never silently replaced.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { HUMAN_INTERVENTIONS, HUMAN_REVIEW_ACTIVITIES, type HumanIntervention, type HumanReviewActivity, WORKFLOW_CAUSES, type WorkflowCause } from '../../../shared/domain/space'
import type { RecordHumanFeedbackInput } from '../../../shared/domain/spaceSignals'
import { runCommand } from '../api/dm'
import { failureOf } from '../epic/runner'
import { ACTIVITY_LABELS, CAUSE_LABELS, INTERVENTION_LABELS, parseMinutes, RATING_LABELS, RATING_VALUES } from './feedbackForm'
import { editBuffer, type EditBuffer, rebaseEdit, settleEdit } from './scoreReads'

type Notice = { tone: 'info' | 'error'; text: string } | null

interface Recorder {
  busy: boolean
  notice: Notice
  /** Records one entry; resolves true once it is stored. */
  record(input: Omit<RecordHumanFeedbackInput, 'idempotencyKey'>, done: string): Promise<boolean>
  clear(): void
}

/** Records entries for one form: one at a time, the same key for a retry of the same entry, a new one for a new entry. */
function useRecorder(folder: string, onRecorded: () => void): Recorder {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const last = useRef<{ request: string; key: string } | null>(null)
  const record = async (input: Omit<RecordHumanFeedbackInput, 'idempotencyKey'>, done: string): Promise<boolean> => {
    const request = JSON.stringify(input)
    const key = last.current?.request === request ? last.current.key : crypto.randomUUID()
    last.current = { request, key }
    setBusy(true)
    try {
      await runCommand(folder, 'recordHumanFeedback', { ...input, idempotencyKey: key })
      last.current = null
      setNotice({ tone: 'info', text: done })
      onRecorded()
      return true
    } catch (error: unknown) {
      setNotice({ tone: 'error', text: `Not recorded: ${failureOf(error).message} Your entry is kept; try again.` })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, notice, record, clear: () => setNotice(null) }
}

function NoticeLine({ notice }: { notice: Notice }): JSX.Element | null {
  if (notice === null) {
    return null
  }
  return (
    <p className={`tp-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </p>
  )
}

/** The latest recorded rating of the scope the form records, as the read shows it; null when none was recorded. */
export interface SavedRating {
  value: number
  sharedWithTickets: boolean | null
}

const sameRating = (a: SavedRating | null, b: SavedRating | null): boolean => a?.value === b?.value && a?.sharedWithTickets === b?.sharedWithTickets

interface RatingFormProps {
  folderPath: string
  /** What is rated, as the form's legend says it ("this ticket", "Sprint 2"). */
  subject: string
  /** A sprint rating asks whether to share it with the sprint's tickets; a ticket rating is the ticket's own. */
  scope: 'sprint' | 'ticket'
  saved: SavedRating | null
  target: RecordHumanFeedbackInput['target']
  onRecorded(): void
}

function RatingChoices(props: { name: string; value: number | null; disabled: boolean; onChoose(value: number): void }): JSX.Element {
  return (
    <div className="sc-rating" role="radiogroup" aria-label="Rating, 1 to 5">
      {RATING_VALUES.map((value) => (
        <label key={value} className="sc-rating-choice">
          <input type="radio" name={props.name} value={value} checked={props.value === value} disabled={props.disabled} onChange={() => props.onChoose(value)} />
          <span>
            {value} · {RATING_LABELS[value]}
          </span>
        </label>
      ))}
    </div>
  )
}

interface RatingEdit {
  buffer: EditBuffer<SavedRating | null>
  /** The person's open choice, else the recorded rating. */
  choice: SavedRating | null
  choose(next: SavedRating): void
  settle(saved?: SavedRating | null): void
}

/** The person's chosen rating over the recorded one: a refresh moves the recorded one under it and flags a change. */
function useRatingEdit(saved: SavedRating | null): RatingEdit {
  const [buffer, setBuffer] = useState<EditBuffer<SavedRating | null>>(() => editBuffer(saved))
  // Primitive dependencies: the read builds a new `saved` object on every refresh, which is not a change by itself.
  const savedValue = saved?.value ?? null
  const savedShared = saved?.sharedWithTickets ?? null
  useEffect(() => {
    const incoming = savedValue === null ? null : { value: savedValue, sharedWithTickets: savedShared }
    setBuffer((current) => rebaseEdit(current, incoming, sameRating))
  }, [savedValue, savedShared])
  return {
    buffer,
    choice: buffer.edit === null ? buffer.base : buffer.edit.value,
    choose: (next) => setBuffer((current) => ({ ...current, edit: { value: next } })),
    settle: (value) => setBuffer((current) => settleEdit(current, value))
  }
}

/** The explicit choice a sprint rating carries: whether the sprint's tickets inherit it. */
function ShareChoice(props: { edit: RatingEdit; disabled: boolean; onChoose(next: SavedRating): void }): JSX.Element {
  const { choice } = props.edit
  return (
    <label className="tp-check-field">
      <input
        type="checkbox"
        checked={choice?.sharedWithTickets === true}
        disabled={props.disabled || choice === null}
        onChange={(event) => {
          if (choice !== null) {
            props.onChoose({ ...choice, sharedWithTickets: event.target.checked })
          }
        }}
      />
      <span>Share with this sprint&apos;s tickets: a ticket without its own rating inherits it (marked inherited)</span>
    </label>
  )
}

function MovedNotice({ buffer }: { buffer: EditBuffer<SavedRating | null> }): JSX.Element | null {
  if (!buffer.baseMoved) {
    return null
  }
  return (
    <p className="tp-message is-error" role="alert">
      Another rating was recorded meanwhile ({buffer.base === null ? 'none now' : `${buffer.base.value} of 5`}). Your choice is kept: record it to replace that one, or discard it.
    </p>
  )
}

/**
 * One satisfaction/confidence rating, 1 to 5. Optional: nothing is recorded until the person records a choice. A sprint
 * rating also states, explicitly, whether the sprint's tickets inherit it. A refresh that brings another recorded rating
 * keeps the person's open choice and says what changed underneath.
 */
export function RatingForm(props: RatingFormProps): JSX.Element {
  const name = useId()
  const recorder = useRecorder(props.folderPath, props.onRecorded)
  const edit = useRatingEdit(props.saved)
  const { choice } = edit
  const sprint = props.scope === 'sprint'
  const choose = (next: SavedRating): void => {
    recorder.clear()
    edit.choose(next)
  }
  const record = async (chosen: SavedRating): Promise<void> => {
    const feedback = sprint ? { kind: 'rating' as const, value: chosen.value, sharedWithTickets: chosen.sharedWithTickets === true } : { kind: 'rating' as const, value: chosen.value }
    if (await recorder.record({ target: props.target, feedback }, `Rating ${chosen.value} of 5 recorded.`)) {
      edit.settle(chosen)
    }
  }
  return (
    <fieldset className="tp-fieldset sc-form" aria-label={`Rate ${props.subject}`}>
      <legend className="sc-form-legend">Rate {props.subject} (optional)</legend>
      <RatingChoices name={name} value={choice?.value ?? null} disabled={recorder.busy} onChoose={(value) => choose({ value, sharedWithTickets: sprint ? (choice?.sharedWithTickets ?? false) : null })} />
      {sprint ? <ShareChoice edit={edit} disabled={recorder.busy} onChoose={choose} /> : null}
      <MovedNotice buffer={edit.buffer} />
      <div className="sc-form-actions">
        <button type="button" className="btn btn-primary" disabled={recorder.busy || edit.buffer.edit === null || choice === null} onClick={() => choice !== null && void record(choice)}>
          Record rating
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={recorder.busy || edit.buffer.edit === null}
          onClick={() => {
            recorder.clear()
            edit.settle()
          }}
        >
          Discard
        </button>
      </div>
      <NoticeLine notice={recorder.notice} />
    </fieldset>
  )
}

interface TimeFormProps {
  folderPath: string
  target: RecordHumanFeedbackInput['target']
  /** How many entries of this kind the read shows for the target: a rise while the person types is shown, never merged. */
  recorded: number
  onRecorded(): void
}

/**
 * Entries of this kind recorded underneath (another window, a sync) since the person started typing; 0 while the form is
 * untouched. The person's typed entry is never changed by them.
 */
function useRecordedMeanwhile(recorded: number, typing: boolean): number {
  const [seen, setSeen] = useState(recorded)
  useEffect(() => {
    if (!typing) {
      setSeen(recorded)
    }
  }, [typing, recorded])
  return typing ? Math.max(0, recorded - seen) : 0
}

function MeanwhileNotice({ count, kind }: { count: number; kind: string }): JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <p className="tp-message is-error" role="alert">
      {count === 1 ? `Another ${kind} entry was` : `${count} other ${kind} entries were`} recorded meanwhile (listed above). Your entry is kept below: record it as well, or clear it.
    </p>
  )
}

function MinutesField(props: { value: string; disabled: boolean; onChange(text: string): void }): JSX.Element {
  return (
    <label className="tp-field">
      <span>Actual minutes (optional)</span>
      <input
        className="tp-input"
        type="text"
        inputMode="decimal"
        value={props.value}
        placeholder="Leave blank if not known"
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  )
}

function RescueChoices(props: {
  intervention: HumanIntervention
  cause: WorkflowCause | ''
  disabled: boolean
  onIntervention(value: HumanIntervention): void
  onCause(value: WorkflowCause | ''): void
}): JSX.Element {
  return (
    <>
      <label className="tp-field">
        <span>How</span>
        <select className="tp-input" value={props.intervention} disabled={props.disabled} onChange={(event) => props.onIntervention(HUMAN_INTERVENTIONS.find((item) => item === event.target.value) ?? 'rescue')}>
          {HUMAN_INTERVENTIONS.map((item) => (
            <option key={item} value={item}>
              {INTERVENTION_LABELS[item]}
            </option>
          ))}
        </select>
      </label>
      <label className="tp-field">
        <span>Reason</span>
        <select className="tp-input" value={props.cause} disabled={props.disabled} onChange={(event) => props.onCause(WORKFLOW_CAUSES.find((item) => item === event.target.value) ?? '')}>
          <option value="">Choose a reason…</option>
          {WORKFLOW_CAUSES.map((item) => (
            <option key={item} value={item}>
              {CAUSE_LABELS[item]}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

/**
 * Rescue: a person stepped in. How (the intervention), why (the reason, which the form asks for) and, optionally, the
 * actual minutes. Recorded as rescue time, a diagnostic beside E that is never scored.
 */
export function RescueForm(props: TimeFormProps): JSX.Element {
  const recorder = useRecorder(props.folderPath, props.onRecorded)
  const [intervention, setIntervention] = useState<HumanIntervention>('rescue')
  const [cause, setCause] = useState<WorkflowCause | ''>('')
  const [minutes, setMinutes] = useState('')
  const parsed = parseMinutes(minutes)
  const meanwhile = useRecordedMeanwhile(props.recorded, cause !== '' || minutes !== '')
  const record = async (reason: WorkflowCause, given: number | undefined): Promise<void> => {
    const feedback = { kind: 'rescue' as const, intervention, cause: reason, ...(given === undefined ? {} : { minutes: given }) }
    if (await recorder.record({ target: props.target, feedback }, given === undefined ? 'Rescue recorded without minutes.' : `Rescue of ${given} min recorded.`)) {
      setCause('')
      setMinutes('')
    }
  }
  return (
    <fieldset className="tp-fieldset sc-form" aria-label="Record a rescue">
      <legend className="sc-form-legend">Rescue: a person stepped in (optional)</legend>
      <div className="tp-grid">
        <RescueChoices intervention={intervention} cause={cause} disabled={recorder.busy} onIntervention={setIntervention} onCause={setCause} />
        <MinutesField value={minutes} disabled={recorder.busy} onChange={setMinutes} />
      </div>
      {parsed.ok ? null : <p className="tp-message is-error">{parsed.message}</p>}
      <MeanwhileNotice count={meanwhile} kind="rescue" />
      <div className="sc-form-actions">
        <button type="button" className="btn" disabled={recorder.busy || cause === '' || !parsed.ok} onClick={() => cause !== '' && parsed.ok && void record(cause, parsed.minutes)}>
          Record rescue
        </button>
        {cause === '' ? <span className="sc-note">Choose a reason to record a rescue.</span> : null}
      </div>
      <NoticeLine notice={recorder.notice} />
    </fieldset>
  )
}

/**
 * Planned review or playtesting a person did: not a rescue and never an intervention. What it was for and, optionally,
 * the actual minutes.
 */
export function PlannedReviewForm(props: TimeFormProps): JSX.Element {
  const recorder = useRecorder(props.folderPath, props.onRecorded)
  const [activity, setActivity] = useState<HumanReviewActivity>('review')
  const [minutes, setMinutes] = useState('')
  const parsed = parseMinutes(minutes)
  const meanwhile = useRecordedMeanwhile(props.recorded, minutes !== '')
  const record = async (given: number | undefined): Promise<void> => {
    const feedback = { kind: 'planned_review' as const, activity, ...(given === undefined ? {} : { minutes: given }) }
    const label = ACTIVITY_LABELS[activity]
    const stored = await recorder.record({ target: props.target, feedback }, given === undefined ? `${label} recorded without minutes.` : `${label} of ${given} min recorded.`)
    if (stored) {
      setMinutes('')
    }
  }
  return (
    <fieldset className="tp-fieldset sc-form" aria-label="Record planned review or playtesting">
      <legend className="sc-form-legend">Planned review or playtesting (optional, never a rescue)</legend>
      <div className="tp-grid">
        <label className="tp-field">
          <span>Reason</span>
          <select className="tp-input" value={activity} disabled={recorder.busy} onChange={(event) => setActivity(HUMAN_REVIEW_ACTIVITIES.find((item) => item === event.target.value) ?? 'review')}>
            {HUMAN_REVIEW_ACTIVITIES.map((item) => (
              <option key={item} value={item}>
                {ACTIVITY_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <MinutesField value={minutes} disabled={recorder.busy} onChange={setMinutes} />
      </div>
      {parsed.ok ? null : <p className="tp-message is-error">{parsed.message}</p>}
      <MeanwhileNotice count={meanwhile} kind="planned review" />
      <div className="sc-form-actions">
        <button type="button" className="btn" disabled={recorder.busy || !parsed.ok} onClick={() => parsed.ok && void record(parsed.minutes)}>
          Record {ACTIVITY_LABELS[activity].toLowerCase()}
        </button>
      </div>
      <NoticeLine notice={recorder.notice} />
    </fieldset>
  )
}
