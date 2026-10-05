import { Fragment, memo, useState } from 'react'
import type { ChatItem } from '../../../shared/agents/chat'
import { Icon } from '../components/Icon'
import { StatePill } from '../components/StatePill'
import { callStatus, callSummary, inputFields, resultText } from './chatViewModel'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>

/** What a call was given and what it returned, as plain text: nothing the agent wrote is rendered as markup here. */
function CallDetails({ call }: { call: ToolCallItem }): JSX.Element {
  return (
    <div className="chat-tool-body">
      <dl className="chat-tool-fields">
        {inputFields(call.input).map((field) => (
          <Fragment key={field.key}>
            <dt>{field.key}</dt>
            <dd>
              <pre>{field.text}</pre>
            </dd>
          </Fragment>
        ))}
      </dl>
      <p className="chat-tool-label">Result</p>
      <pre className="chat-tool-result">{resultText(call)}</pre>
    </div>
  )
}

/** A tool call as one compact row (name, summary, status) that opens to its input and result. */
export const ToolCallRow = memo(function ToolCallRow({ call }: { call: ToolCallItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const status = callStatus(call.status)
  return (
    <li className="chat-tool" aria-label={`Tool call: ${call.name}`}>
      <button type="button" className="chat-tool-head" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="chat-tool-name">{call.name}</span>
        <span className="chat-tool-summary">{callSummary(call.input)}</span>
        <StatePill state={status.state} label={status.label} />
      </button>
      {open ? <CallDetails call={call} /> : null}
    </li>
  )
})
