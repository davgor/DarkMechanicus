import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'

interface EmptyStateProps {
  title: string
  /** Use 1 when the empty state is the whole page's content. Defaults to a level-2 heading. */
  headingLevel?: 1 | 2
  icon?: IconName
  /** Larger artwork shown above the title. Replaces `icon` when both are given. */
  illustration?: ReactNode
  children?: ReactNode
  action?: ReactNode
}

export function EmptyState({
  title,
  headingLevel,
  icon,
  illustration,
  children,
  action
}: EmptyStateProps): JSX.Element {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <section className="empty-state">
      {illustration ? (
        <div className="empty-state-illustration">{illustration}</div>
      ) : icon ? (
        <Icon name={icon} size={28} />
      ) : null}
      <Heading className="empty-state-title">{title}</Heading>
      {children ? <p className="empty-state-text">{children}</p> : null}
      {action}
    </section>
  )
}
