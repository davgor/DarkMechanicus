import { useRef, useState } from 'react'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { LINEAR_SETUP_LINES } from '../../../shared/domain/linearSetup'
import { AgentChoice, ModelChoice } from '../agents/NewChatFields'
import type { AgentStatuses } from '../agents/useAgents'
import { useAgentModelChoice } from '../agents/useAgentModelChoice'
import type { AgentModelChoice } from '../agents/useAgentModelChoice'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import type { StartRunChoice } from './orchestration'
import type { TransferDialogMode } from './workspaceState'

interface TransferDialogProps {
  epicTitle: string
  /** `queue` authorizes a new transfer first; `resume` starts an agent on the transfer already authorized. */
  mode: TransferDialogMode
  /** The connected agents and their sign-in states. */
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** An action is in progress; both choices wait. */
  busy: boolean
  /** Authorizes the transfer (unless resuming), starts the chosen agent on it and opens its chat. */
  onTransferWithAgent(choice: StartRunChoice): void
  /** Authorizes the transfer (unless resuming) and copies its prompt. */
  onCopyPrompt(): void
  /** Opens the add-agent pane (the dialog closes). */
  onAddAgent(): void
  /** A sign-in prompt in the dialog asked an agent's state itself: the shell shows what it found. */
  onAgentStatus(id: AgentId, status: AgentAuthStatus): void
  onClose(): void
}

const COPY = {
  queue: {
    title: 'Transfer to Linear',
    description: (title: string) => `Hand “${title}” over to a Linear project, laid out in execution order. Either choice below authorizes the transfer.`,
    agentButton: 'Transfer with agent'
  },
  resume: {
    title: 'Resume transfer',
    description: (title: string) => `The transfer of “${title}” is authorized. Start an agent on it, or copy its prompt.`,
    agentButton: 'Resume with agent'
  }
} as const

/** What the person agrees to before authorizing: the handoff, how it ends, what it locks, and what the agent needs. */
function Explanations({ mode }: { mode: TransferDialogMode }): JSX.Element {
  return (
    <section className="chat-field start-run-section transfer-explain" aria-label="What the transfer does">
      {mode === 'queue' ? (
        <ul className="transfer-points">
          <li>It is a one-way handoff: Linear becomes the board, and nothing syncs back.</li>
          <li>The epic completes here once the agent&apos;s read-back of the Linear project matches the plan.</li>
          <li>Runs and Save are locked until the transfer is verified or canceled.</li>
        </ul>
      ) : null}
      <p className="field-hint">
        The agent uses its own Linear MCP server; Dark Mechanicus holds no Linear credential. Set it up once for the CLI the agent runs in:
      </p>
      <ul className="transfer-setup" aria-label="Linear MCP setup">
        {LINEAR_SETUP_LINES.map((line) => (
          <li key={line.cli}>
            <span className="transfer-setup-cli">{line.cli}</span>
            <code>{line.setup}</code>
          </li>
        ))}
      </ul>
      <p className="field-hint">Linear&apos;s sign-in may open in your browser, and the agent asks in the chat which Linear team to use.</p>
    </section>
  )
}

function AgentSection({ props, choice }: { props: TransferDialogProps; choice: AgentModelChoice }): JSX.Element {
  const { agent } = choice
  return (
    <section className="chat-field start-run-section" aria-label="Transfer with an agent">
      <h3 className="field-label">Transfer with an agent</h3>
      <p className="field-hint">Dark Mechanicus starts the agent in a chat of this folder and sends it the transfer. It cannot save plans.</p>
      <AgentChoice
        agents={props.agents}
        statuses={props.statuses}
        value={agent}
        onChange={choice.chooseAgent}
        onAddAgent={props.onAddAgent}
        onAgentStatus={props.onAgentStatus}
        emptyText="No agent is connected and signed in."
      />
      {agent === null ? null : <ModelChoice agent={agent} state={choice.models} value={choice.model} onChange={choice.chooseModel} />}
    </section>
  )
}

/**
 * Transfer to Linear, two ways, each authorizing the transfer first (`queueTransfer`): Transfer with agent starts a
 * connected, signed-in agent on it in a chat, and Copy prompt copies its kickoff for an agent the person starts
 * elsewhere. In `resume` mode the transfer is already authorized and neither queues. Only one action is taken per
 * opening, so a double click cannot queue twice or start two chats.
 */
export function TransferDialog(props: TransferDialogProps): JSX.Element {
  const choice = useAgentModelChoice(props.agents, props.statuses)
  const acted = useRef(false)
  const [pressed, setPressed] = useState(false)
  const copy = COPY[props.mode]
  const { agent } = choice
  const waiting = props.busy || pressed
  const canTransfer = agent !== null && choice.settled && !waiting
  const once = (action: () => void): void => {
    if (acted.current) return
    acted.current = true
    setPressed(true)
    action()
  }
  return (
    <Dialog
      title={copy.title}
      description={copy.description(props.epicTitle)}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant={canTransfer ? 'default' : 'primary'} disabled={waiting} onClick={() => once(props.onCopyPrompt)}>
            Copy prompt
          </Button>
          <Button
            variant="primary"
            disabled={!canTransfer}
            busy={waiting}
            onClick={() => {
              if (agent !== null) once(() => props.onTransferWithAgent({ agent, model: choice.model }))
            }}
          >
            {copy.agentButton}
          </Button>
        </>
      }
    >
      <div className="form">
        <Explanations mode={props.mode} />
        <AgentSection props={props} choice={choice} />
        <section className="chat-field start-run-section" aria-label="Copy prompt">
          <h3 className="field-label">Copy prompt</h3>
          <p className="field-hint">Copies the transfer prompt for an agent you start yourself, connected to this folder.</p>
        </section>
      </div>
    </Dialog>
  )
}
