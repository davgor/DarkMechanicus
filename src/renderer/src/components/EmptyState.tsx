import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'

interface EmptyStateProps {
  title: string
  icon?: IconName
  children?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, icon, children, action }: EmptyStateProps): JSX.Element {
  return (
    <section className="empty-state">
      {icon ? <Icon name={icon} size={28} /> : null}
      <h2 className="empty-state-title">{title}</h2>
      {children ? <p className="empty-state-text">{children}</p> : null}
      {action}
    </section>
  )
}
