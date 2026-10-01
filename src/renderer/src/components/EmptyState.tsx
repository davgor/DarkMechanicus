import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'

interface EmptyStateProps {
  title: string
  /** Use 1 when the empty state is the whole page's content. Defaults to a level-2 heading. */
  headingLevel?: 1 | 2
  icon?: IconName
  children?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, headingLevel, icon, children, action }: EmptyStateProps): JSX.Element {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <section className="empty-state">
      {icon ? <Icon name={icon} size={28} /> : null}
      <Heading className="empty-state-title">{title}</Heading>
      {children ? <p className="empty-state-text">{children}</p> : null}
      {action}
    </section>
  )
}
