import { useId } from 'react'
import { classNames } from '../components/classNames'
import type { AgentRoleInfo } from './agentRoles'
import { LexmechanicArt } from './LexmechanicArt'
import { MagosArt } from './MagosArt'

interface AgentRoleCardProps {
  info: AgentRoleInfo
  checked: boolean
  /** In the tab order: the checked card, or the first one while none is. */
  focusable: boolean
  /** Why this role cannot start now; the card shows it and never chooses. */
  disabledReason?: string
  /** The hover lift; off when the person prefers reduced motion. */
  motion: boolean
  radioRef(element: HTMLDivElement | null): void
  onClick(): void
}

/**
 * One role as a glass card: its illustration, then a radio named for the role with the role line, facts and any
 * disabled reason as its description. The art sits outside the radio so its own label stays in the accessibility tree.
 */
export function AgentRoleCard(props: AgentRoleCardProps): JSX.Element {
  const { info, checked, focusable, disabledReason, motion, radioRef, onClick } = props
  const id = useId()
  const disabled = disabledReason !== undefined
  const described = [`${id}-role`, `${id}-facts`, disabled && `${id}-reason`].filter(Boolean).join(' ')
  return (
    <div
      className={classNames('arc glass', checked && 'arc-checked', disabled && 'arc-disabled', motion && 'arc-motion')}
      data-role={info.role}
      onClick={onClick}
    >
      <div className="arc-art">{info.role === 'orchestrator' ? <MagosArt /> : <LexmechanicArt />}</div>
      <div
        ref={radioRef}
        role="radio"
        className="arc-radio"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-labelledby={`${id}-name`}
        aria-describedby={described}
        tabIndex={focusable ? 0 : -1}
      >
        <span className="arc-name" id={`${id}-name`}>{info.name}</span>
        <span className="arc-role" id={`${id}-role`}>{info.roleLine}</span>
      </div>
      <ul className="arc-facts" id={`${id}-facts`}>
        {info.facts.map((fact) => <li key={fact}>{fact}</li>)}
      </ul>
      {disabled ? <p className="arc-reason" id={`${id}-reason`}>{disabledReason}</p> : null}
    </div>
  )
}
