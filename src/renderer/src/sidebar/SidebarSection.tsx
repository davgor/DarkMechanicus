import { useId, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'

interface Props {
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

/** The three sidebar sections share one label, disclosure and always-available add control. */
export function SidebarSection({ title, action, className, children }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  return <section className={className} aria-label={title}>
    <div className="sidebar-head">
      <button type="button" className="sidebar-section-toggle" aria-label={title} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(!expanded)}>
        <span className="eyebrow">{title.toUpperCase()}</span>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {action}
    </div>
    <div id={contentId} hidden={!expanded}>{children}</div>
  </section>
}
