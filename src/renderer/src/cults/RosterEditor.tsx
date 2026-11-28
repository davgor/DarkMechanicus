import { ARCHETYPE_INFO, WORKER_TYPE_INFO, type RosterSlot } from '../../../shared/cults/archetypes'
import { Button } from '../components/Button'
import { blankSlot, moveSlot, rosterEditing, type FoundCultDraft } from './foundCultForm'

interface RosterEditorProps {
  draft: FoundCultDraft
  change(patch: Partial<FoundCultDraft>): void
  /** Why the roster is refused, shown once Save was pressed. */
  issues: readonly string[]
}

interface SlotRowProps {
  slot: RosterSlot
  index: number
  count: number
  editing: { text: boolean; shape: boolean }
  onChange(slot: RosterSlot): void
  onMove(step: -1 | 1): void
  onRemove(): void
}

/** A fixed slot reads as text; an editable one as its label and mission fields. Its worker type heads either. */
function SlotText({ slot, editing, onChange }: Pick<SlotRowProps, 'slot' | 'editing' | 'onChange'>): JSX.Element {
  const type = WORKER_TYPE_INFO[slot.workerType]
  const badge = <span className="badge cult-slot-type" title={type.description}>{type.displayName}</span>
  if (!editing.text)
    return (
      <span className="cult-slot-text">
        <span className="cult-slot-head">
          {badge}
          {slot.label === type.displayName ? null : <span className="cult-slot-label">{slot.label}</span>}
        </span>
        <span className="field-hint">{slot.mission}</span>
      </span>
    )
  return (
    <span className="cult-slot-text">
      <span className="cult-slot-head">{badge}</span>
      <input className="input" aria-label={`Label of slot ${slot.id}`} value={slot.label} maxLength={80} onChange={(event) => onChange({ ...slot, label: event.target.value })} />
      <textarea className="input" rows={2} aria-label={`Mission of ${slot.label || slot.id}`} value={slot.mission} maxLength={4000} onChange={(event) => onChange({ ...slot, mission: event.target.value })} />
    </span>
  )
}

function SlotRow({ slot, index, count, editing, onChange, onMove, onRemove }: SlotRowProps): JSX.Element {
  const name = slot.label || `slot ${index + 1}`
  return (
    <li className="cult-slot">
      <SlotText slot={slot} editing={editing} onChange={onChange} />
      {editing.shape ? (
        <span className="cult-slot-actions">
          <Button variant="ghost" size="sm" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</Button>
          <Button variant="ghost" size="sm" aria-label={`Move ${name} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</Button>
          <Button variant="ghost" size="sm" icon="close" aria-label={`Remove ${name}`} onClick={onRemove} />
        </span>
      ) : null}
    </li>
  )
}

function rosterNote(draft: FoundCultDraft): string {
  const kind = ARCHETYPE_INFO[draft.archetype].presetKind
  if (kind === 'none') return 'No preset roster: the Magos chooses who to summon.'
  if (kind === 'fixed') return 'Six fixed specialists, all required; the roster cannot be changed.'
  if (kind === 'supplied') return 'Your own council: add, order and describe each required slot.'
  return 'Default roster; edit each slot’s label and mission.'
}

/** The roster the cult starts with, shown before founding: fixed for a Plan Forge, editable defaults, or a Custom council. */
export function RosterEditor({ draft, change, issues }: RosterEditorProps): JSX.Element {
  const editing = rosterEditing(draft.archetype)
  const slots = draft.slots
  const update = (index: number, slot: RosterSlot): void => change({ slots: slots.map((s, i) => (i === index ? slot : s)) })
  return (
    <section className="cult-roster" aria-label="Roster">
      <span className="field-label">Roster</span>
      <p className="field-hint">{rosterNote(draft)}</p>
      {slots.length === 0 ? null : (
        <ol className="cult-slots">
          {slots.map((slot, index) => (
            <SlotRow key={slot.id} slot={slot} index={index} count={slots.length} editing={editing}
              onChange={(next) => update(index, next)}
              onMove={(step) => change({ slots: moveSlot(slots, index, step) })}
              onRemove={() => change({ slots: slots.filter((_, i) => i !== index) })} />
          ))}
        </ol>
      )}
      {editing.shape ? <Button size="sm" icon="plus" onClick={() => change({ slots: [...slots, blankSlot(slots)] })}>Add slot</Button> : null}
      {issues.map((issue) => <p key={issue} role="alert" className="form-error">{issue}</p>)}
    </section>
  )
}
