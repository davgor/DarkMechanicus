import { memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatCallsign } from '../../../shared/agents/callsign'
import { Icon } from '../components/Icon'
import { StatePill } from '../components/StatePill'
import { Hourglass } from './Hourglass'
import { RevealThreadContext } from './revealThread'
import { threadStateView, type ThreadNode, type TreeRow } from './threadModel'

interface ThreadBlockProps {
  node: ThreadNode
  /** Renders one row of the thread with the transcript's own row component, so its items look like the rest of the chat. */
  renderRow(row: TreeRow): ReactNode
}

/**
 * The work of a subagent, as a block under the tool call that spawned it: its name and state (an hourglass
 * while it ran), and, once opened, its own items. The name is the callsign on the thread (main's stamp, or the
 * Servitor `transcriptTree` names a legacy thread by); only a lost thread with no stamped request keeps its label.
 */
export const ThreadBlock = memo(function ThreadBlock({ node, renderRow }: ThreadBlockProps): JSX.Element {
  const { item } = node
  const [open, setOpen] = useState(false)
  const reveal = useContext(RevealThreadContext)
  const element = useRef<HTMLLIElement>(null)
  const onPath = reveal.path.has(item.id)
  useEffect(() => {
    if (!onPath || reveal.handled.get(item.id) === reveal.nonce) return
    reveal.handled.set(item.id, reveal.nonce)
    setOpen(true)
    if (reveal.target === item.id) element.current?.scrollIntoView?.({ block: 'nearest' })
  }, [onPath, reveal.handled, reveal.target, reveal.nonce, item.id])
  const state = threadStateView(item.state)
  const name = item.callsign === undefined ? item.label : formatCallsign(item.callsign)
  return (
    <li ref={element} className="chat-thread" data-state={item.state} data-thread-id={item.id} aria-label={`Thread: ${name}`}>
      <div className="chat-thread-head">
        <button type="button" className="chat-thread-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          {item.state === 'running' ? <Hourglass /> : null}
          <span className="chat-thread-label">{name}</span>
          <StatePill state={state.pill} label={state.label} />
        </button>
      </div>
      {open ? <ol className="chat-thread-rows">{node.rows.map(renderRow)}</ol> : null}
    </li>
  )
})
