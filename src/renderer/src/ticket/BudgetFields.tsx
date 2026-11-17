/**
 * The draft editor's planned budget: tokens and active time, each in its unit, and where the numbers came from. It is
 * set through `setTicketBudget`, a draft edit checked against the draft revision the person edited, so a draft that
 * moved meanwhile is a `conflict`: the person's entry is kept, the draft is read again, and the change underneath is
 * shown before they set it again. Saving the plan freezes the budget as a new version; the versions list shows which one
 * the run froze at the ticket's dispatch (the one its grade uses) and which are prospective, so an edit never reads as
 * changing a grade already given. Optional: both amounts blank means no budget.
 */
import { useEffect, useState } from 'react'
import { BUDGET_BASES, type TicketBudget } from '../../../shared/domain/bundle'
import type { TicketPlannedBaselinesView } from '../../../shared/domain/metrics'
import type { SetTicketBudgetResultView } from '../../../shared/domain/scoreReads'
import { failureOf, type Runner } from '../epic/runner'
import type { Result } from '../epic/workspaceActions'
import { durationText } from '../scorecard/scorecardFormat'
import { editBuffer, type EditBuffer, rebaseEdit, settleEdit } from '../scorecard/scoreReads'
import { BASIS_LABELS, basisOf, type BudgetText, budgetSummary, budgetText, minutesToMs, parseBudget, sameText, versionText } from './budgetForm'

export interface BudgetFieldsProps {
  runner: Runner
  epicId: string
  ticketId: string
  /** The epic's run, whose dispatches pin budgets; null before any run. */
  runId: string | null
  /** The run has ended: a version it froze stays its, and a later run freezes its own at dispatch. */
  runEnded: boolean
  /** The ticket's budget in the draft as last read. */
  draftBudget: TicketBudget | undefined
  /** Changes whenever the draft is read again, so the saved versions are read again too. */
  draftRevision: number | null
  busy: boolean
  setBudget(budget: TicketBudget | null): Promise<Result<SetTicketBudgetResultView>>
}

type Versions = { status: 'loading' } | { status: 'ready'; ticket: TicketPlannedBaselinesView | null } | { status: 'unsaved' } | { status: 'error'; message: string }
type Notice = { tone: 'info' | 'error'; text: string } | null

const CONFLICT = 'The draft changed while you were editing, so nothing was set. Your entry is kept below; check it against the draft’s budget and set it again.'

/** The ticket's saved budget versions relative to the run (`getPlannedBaselines`), read again whenever the draft moves. */
function useVersions(props: BudgetFieldsProps): [Versions, (ticket: TicketPlannedBaselinesView | null) => void] {
  const [versions, setVersions] = useState<Versions>({ status: 'loading' })
  const { runner, epicId, ticketId, runId, draftRevision } = props
  useEffect(() => {
    let live = true
    runner('getPlannedBaselines', runId === null ? { epicId } : { epicId, runId }).then(
      (view) => {
        if (live) {
          setVersions({ status: 'ready', ticket: view.tickets.find((entry) => entry.ticketId === ticketId) ?? null })
        }
      },
      (error: unknown) => {
        const failure = failureOf(error)
        // A never-saved epic has no versions yet: its first save makes the first one.
        if (live) {
          setVersions(failure.code === 'not_found' ? { status: 'unsaved' } : { status: 'error', message: failure.message })
        }
      }
    )
    return () => {
      live = false
    }
  }, [runner, epicId, ticketId, runId, draftRevision])
  return [versions, (ticket) => setVersions({ status: 'ready', ticket })]
}

function dispatchNote(dispatched: boolean, runEnded: boolean): string {
  if (runEnded) {
    return dispatched
      ? 'Dispatched in this finished run: its budget was frozen at that dispatch. A change you save now is a new, prospective version for a later run.'
      : 'Not dispatched in this finished run: a later run freezes the version in effect at its dispatch.'
  }
  return dispatched
    ? 'Already dispatched in this run: its budget was frozen at dispatch. A change you save now is a new, prospective version.'
    : 'Not dispatched in this run yet: the version in effect at its dispatch is frozen then.'
}

function VersionList({ versions, runEnded }: { versions: Versions; runEnded: boolean }): JSX.Element {
  if (versions.status === 'loading') {
    return <p className="sc-note">Reading the saved budget versions…</p>
  }
  if (versions.status === 'error') {
    return <p className="tp-message is-error">Could not read the saved budget versions: {versions.message}</p>
  }
  if (versions.status === 'unsaved' || versions.ticket === null) {
    return <p className="sc-note">No saved version yet: the budget becomes this ticket&apos;s first version when the plan is saved.</p>
  }
  const ticket = versions.ticket
  const rows = ticket.budgets.flatMap((budget) => budget.versions.map((version) => ({ key: `${budget.metric}:${version.version}`, text: versionText(version, budget) })))
  return (
    <>
      <p className="sc-note">{dispatchNote(ticket.dispatchedAt !== null, runEnded)}</p>
      {rows.length === 0 ? <p className="sc-note">No budget version saved.</p> : null}
      <ul className="sc-feedback" aria-label="Saved budget versions">
        {rows.map((row) => (
          <li key={row.key}>{row.text}</li>
        ))}
      </ul>
    </>
  )
}

function BudgetInputs(props: { text: BudgetText; disabled: boolean; onChange(text: BudgetText): void }): JSX.Element {
  const { text, onChange } = props
  // The same strict rule the budget is set by: refused text (`1e2`, `-`) shows no duration.
  const activeMs = minutesToMs(text.minutes)
  return (
    <div className="tp-grid">
      <label className="tp-field">
        <span>Tokens (whole tokens, all attempts and overhead)</span>
        <input className="tp-input" type="text" inputMode="numeric" value={text.tokens} placeholder="No token budget" disabled={props.disabled} onChange={(event) => onChange({ ...text, tokens: event.target.value })} />
      </label>
      <label className="tp-field">
        <span>Active time (minutes of active execution)</span>
        <input className="tp-input" type="text" inputMode="decimal" value={text.minutes} placeholder="No time budget" disabled={props.disabled} onChange={(event) => onChange({ ...text, minutes: event.target.value })} />
        {typeof activeMs === 'number' ? <span className="sc-note">= {durationText(activeMs)}</span> : null}
      </label>
      <label className="tp-field">
        <span>Where the numbers come from</span>
        <select className="tp-input" value={text.basis} disabled={props.disabled} onChange={(event) => onChange({ ...text, basis: basisOf(event.target.value) })}>
          <option value="">Not stated</option>
          {BUDGET_BASES.map((basis) => (
            <option key={basis} value={basis}>
              {BASIS_LABELS[basis]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

interface BudgetEdit {
  buffer: EditBuffer<BudgetText>
  text: BudgetText
  /** The person changed something that is not set yet. */
  pending: boolean
  edit(next: BudgetText): void
  /** The edit was set (with what was set) or discarded. */
  settle(saved?: BudgetText): void
}

/** The person's typed budget over the draft's: a reload moves the draft's under it and flags a change, never overwrites it. */
function useBudgetEdit(draftBudget: TicketBudget | undefined): BudgetEdit {
  const [buffer, setBuffer] = useState<EditBuffer<BudgetText>>(() => editBuffer(budgetText(draftBudget)))
  const { tokens, activeMs, basis } = draftBudget ?? {}
  // Primitive dependencies: a reload builds a new budget object even when nothing changed.
  useEffect(() => {
    const incoming = budgetText(tokens === undefined && activeMs === undefined ? null : { tokens, activeMs, basis })
    setBuffer((current) => rebaseEdit(current, incoming, sameText))
  }, [tokens, activeMs, basis])
  return {
    buffer,
    text: buffer.edit === null ? buffer.base : buffer.edit.value,
    pending: buffer.edit !== null && !sameText(buffer.edit.value, buffer.base),
    edit: (next) => setBuffer((current) => ({ ...current, edit: { value: next } })),
    settle: (saved) => setBuffer((current) => settleEdit(current, saved))
  }
}

function BudgetActions(props: { busy: boolean; edit: BudgetEdit; hasBudget: boolean; onSet(): void; onDiscard(): void; onClear(): void }): JSX.Element {
  const ready = props.edit.pending && parseBudget(props.edit.text).ok
  return (
    <div className="sc-form-actions">
      <button type="button" className="btn" disabled={props.busy || !ready} onClick={props.onSet}>
        Set budget in draft
      </button>
      <button type="button" className="btn btn-ghost" disabled={props.busy || props.edit.buffer.edit === null} onClick={props.onDiscard}>
        Discard
      </button>
      <button type="button" className="btn btn-ghost" disabled={props.busy || !props.hasBudget} onClick={props.onClear}>
        Clear budget
      </button>
    </div>
  )
}

function NoticeLine({ notice }: { notice: Notice }): JSX.Element | null {
  return notice === null ? null : (
    <p className={`tp-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </p>
  )
}

function MovedBudget({ budget }: { budget: TicketBudget | undefined }): JSX.Element {
  return (
    <p className="tp-message is-error" role="alert">
      The draft&apos;s budget changed meanwhile (now {budgetSummary(budget)}). Your entry is kept: set it to replace that, or discard it.
    </p>
  )
}

/** What setting the budget came to: where it applies, or (on a conflict) that the entry is kept to set again. */
function outcomeNotice(result: Result<SetTicketBudgetResultView>, budget: TicketBudget | null): Notice {
  if (!result.ok) {
    return { tone: 'error', text: result.failure.code === 'conflict' ? CONFLICT : result.failure.message }
  }
  const what = budget === null ? 'Budget cleared in the draft.' : `Set in the draft: ${budgetSummary(budget)}.`
  const when =
    result.value.appliesTo === 'later_dispatches'
      ? 'This ticket was already dispatched: its frozen budget stays, and once saved this applies only to later dispatches.'
      : 'It is frozen when the plan is saved, and applies from the ticket’s next dispatch.'
  return { tone: 'info', text: `${what} ${when}` }
}

/** The planned budget fieldset of the draft ticket editor. */
export function BudgetFields(props: BudgetFieldsProps): JSX.Element {
  const [versions, setVersions] = useVersions(props)
  const edit = useBudgetEdit(props.draftBudget)
  const [notice, setNotice] = useState<Notice>(null)
  const parsed = parseBudget(edit.text)
  const set = async (budget: TicketBudget | null): Promise<void> => {
    const result = await props.setBudget(budget)
    setNotice(outcomeNotice(result, budget))
    if (result.ok) {
      edit.settle(budgetText(budget))
      setVersions(result.value.ticket)
    }
  }
  return (
    <fieldset className="tp-fieldset" aria-label="Planned budget">
      <legend className="ew-eyebrow">BUDGET (OPTIONAL)</legend>
      <p className="sc-note">In the draft now: {budgetSummary(props.draftBudget)}. Leave both amounts blank for no budget; a budget only sets the baseline T and K compare against.</p>
      <BudgetInputs
        text={edit.text}
        disabled={props.busy}
        onChange={(next) => {
          setNotice(null)
          edit.edit(next)
        }}
      />
      {parsed.ok ? null : <p className="tp-message is-error">{parsed.message}</p>}
      {edit.buffer.baseMoved ? <MovedBudget budget={props.draftBudget} /> : null}
      <BudgetActions
        busy={props.busy}
        edit={edit}
        hasBudget={props.draftBudget !== undefined}
        onSet={() => parsed.ok && void set(parsed.budget)}
        onDiscard={() => {
          setNotice(null)
          edit.settle()
        }}
        onClear={() => void set(null)}
      />
      <NoticeLine notice={notice} />
      <VersionList versions={versions} runEnded={props.runEnded} />
    </fieldset>
  )
}
