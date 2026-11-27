/**
 * A Plan Forge council's coverage, as text that does not depend on the decorative room: one item per definition slot
 * (the fixed six) and per active Magos-created type beside them, each with who holds it and whether it has reported,
 * then what the conclusion waits for. Every item is focusable, so the strip is read with the keyboard.
 */
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import { classNames } from '../components/classNames'

interface Coverage {
  id: string
  label: string
  created: boolean
  required: boolean
  holders: string[]
  reported: boolean
}

function coverageOf(run: CultRunDetail): Coverage[] {
  const name = (chatId: string): string => run.members.find((member) => member.chatId === chatId)?.displayName ?? chatId
  const slots = run.slots.map((slot): Coverage => ({
    id: slot.slotId, label: slot.label, created: false, required: slot.required,
    holders: slot.liveMemberChatIds.map(name), reported: slot.reportCount > 0
  }))
  const created = run.workerTypes.filter((type) => type.state === 'active').map((type): Coverage => ({
    id: type.id, label: type.displayName, created: true, required: type.requiredForConclusion,
    holders: type.assignedChatIds.map(name), reported: type.reportCount > 0
  }))
  return [...slots, ...created]
}

/** What the conclusion waits for, naming each missing perspective; the synthesis once every required one reported. */
export function councilStatus(run: CultRunDetail): string {
  const missing = [...run.missing.slots, ...run.missing.workerTypes]
  if (missing.length > 0) return `Collecting: waiting for ${missing.join(', ')}`
  if (run.synthesis === null) return 'Resolving: every required perspective reported; the Magos has not recorded a synthesis'
  const { draftRevision, accepted, rejected } = run.synthesis
  return `Synthesis recorded on draft revision ${draftRevision}: ${accepted} accepted, ${rejected} rejected`
}

export function CouncilCoverage({ run }: { run: CultRunDetail }): JSX.Element | null {
  const items = coverageOf(run)
  if (items.length === 0) return null
  return (
    <section className="cult-coverage" aria-label="Council coverage">
      <ul className="cult-coverage-list">
        {items.map((item) => (
          <li key={item.id} tabIndex={0} className={classNames('cult-coverage-item', item.reported && 'is-reported')}
            aria-label={`${item.label}: ${item.reported ? 'reported' : 'waiting'}, ${item.holders.length === 0 ? 'unassigned' : item.holders.join(', ')}`}>
            <span className="cult-coverage-label">{item.label}</span>
            {item.created ? <span className="badge cult-created">Magos-created</span> : null}
            <span className="badge">{item.required ? 'required' : 'optional'}</span>
            <span>{item.holders.length === 0 ? 'unassigned' : item.holders.join(', ')}</span>
            <span className="cult-coverage-state">{item.reported ? 'reported' : 'waiting'}</span>
          </li>
        ))}
      </ul>
      <p className="cult-council-status" role="status">{councilStatus(run)}</p>
    </section>
  )
}
