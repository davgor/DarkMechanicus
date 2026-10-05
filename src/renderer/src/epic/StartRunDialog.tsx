import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import { AgentChoice, ModelChoice } from '../agents/NewChatFields'
import type { AgentStatuses } from '../agents/useAgents'
import { useAgentModelChoice } from '../agents/useAgentModelChoice'
import type { AgentModelChoice } from '../agents/useAgentModelChoice'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import type { StartRunChoice } from './orchestration'

interface StartRunDialogProps {
  epicTitle: string
  /** The connected agents and their sign-in states. */
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** Starting the run is in progress; both choices wait. */
  busy: boolean
  /** Queues the run, as the Start run button always did, for an orchestrator started elsewhere to pick up. */
  onLeavePending(): void
  /** Queues the run and starts the chosen agent as its orchestrator. */
  onRunWithAgent(choice: StartRunChoice): void
  /** Opens the add-agent pane (the dialog closes). */
  onAddAgent(): void
  /** A sign-in prompt in the dialog asked an agent's state itself: the shell shows what it found, and the agent can be chosen once it is signed in. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onClose(): void
}

const DESCRIPTION =
  'Choose who runs this epic. An agent started here runs it in a chat you can follow, or you leave the run pending for an orchestrator you start yourself.'

type DialogProps = StartRunDialogProps

/** The first choice: the agent (only connected, signed-in ones; a signed-out one has Sign in in the list, the rest say where to fix that) and its model. */
function RunWithAgentSection({ props, choice }: { props: DialogProps; choice: AgentModelChoice }): JSX.Element {
  const { agent } = choice
  return (
    <section className="chat-field start-run-section" aria-label="Run with an agent">
      <h3 className="field-label">Run with an agent</h3>
      <p className="field-hint">
        {`Dark Mechanicus starts the agent as the orchestrator of “${props.epicTitle}” and sends it the run. It cannot save plans.`}
      </p>
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
 * Start run, two ways. Run with an agent: pick a connected, signed-in agent and its model; Dark
 * Mechanicus queues the run and starts that agent as the orchestrator in a chat of this folder.
 * Leave pending: queue the run and wait for an external orchestrator. A signed-out agent has Sign in
 * in the list and can be chosen once it is signed in, without leaving the dialog; without a usable
 * agent the first choice links to where one is added, and Leave pending still works.
 */
export function StartRunDialog(props: StartRunDialogProps): JSX.Element {
  const choice = useAgentModelChoice(props.agents, props.statuses)
  const { agent } = choice
  const canRun = agent !== null && choice.settled && !props.busy
  return (
    <Dialog
      title="Start run"
      description={DESCRIPTION}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant={canRun ? 'default' : 'primary'} disabled={props.busy} onClick={props.onLeavePending}>
            Leave pending
          </Button>
          <Button
            variant="primary"
            disabled={!canRun}
            busy={props.busy}
            onClick={() => {
              if (agent !== null) props.onRunWithAgent({ agent, model: choice.model })
            }}
          >
            Run with agent
          </Button>
        </>
      }
    >
      <div className="form">
        <RunWithAgentSection props={props} choice={choice} />
        <section className="chat-field start-run-section" aria-label="Leave pending">
          <h3 className="field-label">Leave pending</h3>
          <p className="field-hint">
            Queues the run and waits. It starts when an external orchestrator, such as Claude Code connected to this folder, picks it up.
          </p>
        </section>
      </div>
    </Dialog>
  )
}
