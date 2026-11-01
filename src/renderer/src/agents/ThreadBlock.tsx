import { memo, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { StatePill } from '../components/StatePill'
import { Hourglass } from './Hourglass'
import { threadStateView, type ThreadNode, type TreeRow } from './threadModel'

interface ThreadBlockProps {
  node: ThreadNode
  /** Renders one row of the thread with the transcript's own row component, so its items look like the rest of the chat. */
  renderRow(row: TreeRow): ReactNode
}

/**
 * The work of a subagent, as a block under the tool call that spawned it: its label and state (an hourglass
 * while it ran), and, once opened, its own items.
 */
export const ThreadBlock = memo(function ThreadBlock({ node, renderRow }: ThreadBlockProps): JSX.Element {
  const { item } = node
  const [open, setOpen] = useState(false)
  const state = threadStateView(item.state)
  return (
    <li className="chat-thread" data-state={item.state} aria-label={`Thread: ${item.label}`}>
      <div className="chat-thread-head">
        <button type="button" className="chat-thread-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          {item.state === 'running' ? <Hourglass /> : null}
          <span className="chat-thread-label">{item.label}</span>
          <StatePill state={state.pill} label={state.label} />
        </button>
      </div>
      {open ? <ol className="chat-thread-rows">{node.rows.map(renderRow)}</ol> : null}
    </li>
  )
})
