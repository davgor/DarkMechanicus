/**
 * The roster strip under the room (one chip per live member, the Magos first) and the inspector card a chip opens.
 * Every fact the decorative chamber hints at is here as text: name, working or idle, model, tier with its reason,
 * worker type with its origin and report state, and the latest activity. Chips are buttons, so Tab reaches each and
 * Enter opens the inspector; Escape closes it.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Dialog } from '../components/Dialog'
import { activityText, type RosterMember } from './cultPageModel'

const hueStyle = (hue: number | null): CSSProperties | undefined => (hue === null ? undefined : ({ '--member-hue': hue } as CSSProperties))

/** How a member's worker type reads: its name, and a Magos-created badge with whether it is required. */
function TypeBadges({ entry, run }: { entry: RosterMember; run: CultRunDetail }): JSX.Element | null {
  if (entry.workerType === null) return null
  const created = entry.member.typeOrigin === 'magos_created'
  const type = created ? run.workerTypes.find((candidate) => candidate.id === entry.member.runWorkerTypeId) : undefined
  return (
    <>
      <span>{entry.workerType}</span>
      {created ? <span className="badge cult-created">Magos-created</span> : null}
      {type === undefined ? null : <span className="badge">{type.requiredForConclusion ? 'required' : 'optional'}</span>}
    </>
  )
}

interface ChipProps {
  entry: RosterMember
  run: CultRunDetail
  selected: boolean
  onOpen(chatId: string): void
}

/** A chip's facts after the name: working or idle, role or worker type, model, tier and report state. */
function ChipFacts({ entry, run }: { entry: RosterMember; run: CultRunDetail }): JSX.Element {
  const { member } = entry
  const working = member.activity?.working === true
  const acolyte = member.role === 'acolyte'
  return (
    <>
      <span className={classNames('cult-activity', working && 'is-working')}>{working ? 'working' : 'idle'}</span>
      {acolyte ? <TypeBadges entry={entry} run={run} /> : <span>Magos</span>}
      {member.model === null ? null : <span className="mono">{member.model}</span>}
      {member.tier === null ? null : <span className="badge cult-tier">{member.tier}</span>}
      {acolyte ? <span>{member.reported ? 'reported' : 'no report yet'}</span> : null}
    </>
  )
}

function RosterChip({ entry, run, selected, onOpen }: ChipProps): JSX.Element {
  const reasonId = useId()
  const { member } = entry
  const reason = member.tierReason
  return (
    <li>
      <button type="button" className={classNames('cult-chip', selected && 'is-selected', member.role === 'magos' && 'is-magos')}
        style={hueStyle(entry.hue)} aria-pressed={selected} aria-describedby={reason === null ? undefined : reasonId}
        data-member-id={member.chatId} onClick={() => onOpen(member.chatId)}>
        <span className="cult-chip-swatch" aria-hidden="true" />
        <span className="cult-chip-name">{member.displayName}</span>
        <ChipFacts entry={entry} run={run} />
      </button>
      {reason === null ? null : <span id={reasonId} className="sr-only">{`Tier reason: ${reason}`}</span>}
    </li>
  )
}

interface RosterProps {
  run: CultRunDetail
  roster: readonly RosterMember[]
  selectedMemberId: string | null
  onSelectMember(chatId: string): void
}

/** Every live member: the strip scrolls, so none is ever hidden behind another, however full the room. */
export function RosterStrip({ run, roster, selectedMemberId, onSelectMember }: RosterProps): JSX.Element {
  return (
    <ul className="cult-roster-strip" aria-label="Roster">
      {roster.map((entry) => <RosterChip key={entry.member.chatId} entry={entry} run={run} selected={entry.member.chatId === selectedMemberId} onOpen={onSelectMember} />)}
    </ul>
  )
}

interface InspectorProps {
  run: CultRunDetail
  entry: RosterMember
  onClose(): void
  onWatch(chatId: string): void
}

/** A member's report state as the inspector says it; the Magos does not report. */
function reportText(member: RosterMember['member']): string {
  if (member.role === 'magos') return '—'
  return member.reported ? 'Reported' : 'Not reported yet'
}

/** The facts of one member as a definition list; the reason and activity are plain text. */
function MemberFacts({ entry, run }: { entry: RosterMember; run: CultRunDetail }): JSX.Element {
  const { member } = entry
  const type = run.workerTypes.find((candidate) => candidate.id === member.runWorkerTypeId)
  const created: [string, string][] = type === undefined ? [] : [['Origin', `Magos-created, ${type.requiredForConclusion ? 'required' : 'optional'}`], ['Rationale', type.rationale]]
  const rows: [string, string][] = [
    ['Role', member.role === 'magos' ? 'Magos' : 'Acolyte'],
    ['Worker type', entry.workerType ?? '—'],
    ...created,
    ['Model', member.model ?? 'default'],
    ['Tier', member.tier ?? '—'],
    ['Reason', member.tierReason ?? '—'],
    ['State', member.activity?.working === true ? 'Working' : 'Idle'],
    ['Report', reportText(member)],
    ['Latest activity', activityText(member.activity)]
  ]
  return (
    <dl className="cult-inspector-facts">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

/** The inspector card over the room: the member's facts, Watch terminal and (for an acolyte) Dismiss with a confirm. */
export function MemberInspector({ run, entry, onClose, onWatch }: InspectorProps): JSX.Element {
  const card = useRef<HTMLElement>(null)
  const [dismissing, setDismissing] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { member } = entry
  const acolyte = member.role === 'acolyte'
  useEffect(() => card.current?.focus(), [member.chatId])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !dismissing) {
      event.stopPropagation()
      onClose()
    }
  }
  const dismiss = async (): Promise<void> => {
    setDismissing(false)
    const result = await window.dm.cults.dismissAcolyte(run.run.id, member.chatId)
    if (result.ok) onClose()
    else setRefusal(result.error.message)
  }
  return (
    <section ref={card} className="cult-inspector" role="region" aria-label={`Inspector: ${member.displayName}`} tabIndex={-1}
      style={hueStyle(entry.hue)} onKeyDown={onKeyDown}>
      <header className="cult-inspector-head">
        <h2>{member.displayName}</h2>
        <Button size="sm" variant="ghost" icon="close" aria-label="Close inspector" onClick={onClose} />
      </header>
      <MemberFacts entry={entry} run={run} />
      <div className="button-row">
        <Button size="sm" variant="primary" onClick={() => onWatch(member.chatId)}>{acolyte ? 'Watch terminal' : 'Open terminal'}</Button>
        {acolyte && run.run.state === 'running' ? <Button size="sm" variant="danger" onClick={() => setDismissing(true)}>Dismiss</Button> : null}
      </div>
      {refusal === null ? null : <p className="cult-refusal" role="alert">{refusal}</p>}
      {dismissing ? (
        <Dialog title={`Dismiss ${member.displayName}?`} description="The acolyte is asked to finish, report and leave the run." onClose={() => setDismissing(false)}
          actions={<>
            <Button onClick={() => setDismissing(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void dismiss()}>Dismiss</Button>
          </>} />
      ) : null}
    </section>
  )
}
