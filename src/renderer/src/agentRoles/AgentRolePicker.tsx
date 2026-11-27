import { type KeyboardEvent, useRef, useState } from 'react'
import { useReducedMotion } from '../epic/useReducedMotion'
import { AgentRoleCard } from './AgentRoleCard'
import { AGENT_ROLES, type AgentRole } from './agentRoles'
import './agentRoles.css'

interface AgentRolePickerProps {
  /** Fires with the chosen role: a click, Enter or Space on an enabled card. Never for a disabled one. */
  onChoose(role: AgentRole): void
  /** Fires whenever the checked card changes (arrow keys, Home, End or choosing), for a form that submits the checked role. */
  onSelect?(role: AgentRole): void
  /** Roles that cannot start now, each with the reason its card shows (for example "Save the plan first"). */
  disabled?: Partial<Record<AgentRole, string>>
  /** The card checked at first; the first enabled role when not given. */
  initial?: AgentRole
  /** The radiogroup's accessible name. */
  label?: string
}

/** Arrow keys step through the enabled cards (wrapping); Home and End jump to the first and last. */
const STEPS: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1
}
const CHOOSE_KEYS: Record<string, true> = { Enter: true, ' ': true }

/**
 * The role picker an agent chat starts from: a radiogroup of the Magos and Lexmechanic cards. Arrow keys move the
 * checked card, Enter or Space (or a click) chooses it; a disabled card shows its reason and never chooses.
 */
export function AgentRolePicker({ onChoose, onSelect, disabled = {}, initial, label = 'Agent role' }: AgentRolePickerProps): JSX.Element {
  const reduced = useReducedMotion()
  const enabled = AGENT_ROLES.map((info) => info.role).filter((role) => disabled[role] === undefined)
  const [selected, setSelected] = useState<AgentRole | null>(() => initial ?? enabled[0] ?? null)
  const radios = useRef(new Map<AgentRole, HTMLDivElement>())

  const select = (role: AgentRole): void => {
    setSelected(role)
    onSelect?.(role)
    radios.current.get(role)?.focus()
  }
  const choose = (role: AgentRole): void => {
    if (disabled[role] !== undefined) return
    select(role)
    onChoose(role)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = STEPS[event.key]
    if (step !== undefined && enabled.length > 0) {
      event.preventDefault()
      select(enabled[step(selected === null ? -1 : enabled.indexOf(selected), enabled.length)] ?? enabled[0])
    } else if (CHOOSE_KEYS[event.key] && selected !== null) {
      event.preventDefault()
      choose(selected)
    }
  }

  return (
    <div className="arp" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {AGENT_ROLES.map((info, index) => (
        <AgentRoleCard
          key={info.role}
          info={info}
          checked={selected === info.role}
          focusable={selected === null ? index === 0 : selected === info.role}
          disabledReason={disabled[info.role]}
          motion={!reduced}
          radioRef={(element) => { if (element === null) radios.current.delete(info.role); else radios.current.set(info.role, element) }}
          onClick={() => choose(info.role)}
        />
      ))}
    </div>
  )
}
