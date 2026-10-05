import { useId } from 'react'
import type { ChatRecord, ModelOption } from '../../../shared/agents/chat'
import { canSavePlans } from '../../../shared/agents/chat'
import { StatePill } from '../components/StatePill'
import { agentName } from './agentText'
import { modelText, ROLE_LABELS } from './chatList'
import type { ModelsState } from './useAgentModels'

interface ModelPickerProps {
  model: string | null
  models: readonly ModelOption[]
  disabled: boolean
  onPick(model: string): void
}

/** The agent's models. A model the chat runs on that is not offered (or none chosen yet) is shown, but cannot be picked again. */
function ModelPicker({ model, models, disabled, onPick }: ModelPickerProps): JSX.Element {
  const id = useId()
  const offered = models.some((option) => option.id === model)
  return (
    <>
      <label className="chat-fact-label" htmlFor={id}>
        Model
      </label>
      <select id={id} className="connect-select" value={model ?? ''} disabled={disabled} onChange={(event) => onPick(event.target.value)}>
        {offered ? null : (
          <option value={model ?? ''} disabled>
            {modelText({ model })}
          </option>
        )}
        {models.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  )
}

interface ChatHeaderProps {
  chat: ChatRecord
  /** The model the chat runs on from the next turn. */
  model: string | null
  models: ModelsState
  running: boolean
  switching: boolean
  onSwitchModel(model: string): void
}

const saveText = (chat: ChatRecord): string => (chat.allowSave && canSavePlans(chat.role) ? 'Allowed to save plans' : 'Does not save plans')

/**
 * What the chat is: title, agent, model, role. The agent is text only, since a chat keeps its agent
 * for life; the model can be switched, from the next turn on, whenever the agent lists its models.
 */
export function ChatHeader({ chat, model, models, running, switching, onSwitchModel }: ChatHeaderProps): JSX.Element {
  return (
    <header className="chat-header">
      <span className="eyebrow">CHAT</span>
      <div className="chat-title-row">
        <h1 className="display chat-title">{chat.title}</h1>
        {running ? <StatePill state="running" label="Answering" /> : null}
      </div>
      <ul className="chat-facts" aria-label="Chat details">
        <li>{agentName(chat.agent)}</li>
        <li className="chat-model">
          {models.status === 'ready' && models.models.length > 0 ? (
            <ModelPicker model={model} models={models.models} disabled={switching} onPick={onSwitchModel} />
          ) : (
            <>
              <span className="chat-fact-label">Model</span>
              <span className="mono">{modelText({ model })}</span>
            </>
          )}
        </li>
        <li>
          <span className="chat-chip">{ROLE_LABELS[chat.role]}</span>
        </li>
        <li>{saveText(chat)}</li>
      </ul>
    </header>
  )
}
