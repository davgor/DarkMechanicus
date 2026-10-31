import { useState } from 'react'
import { epicBranchName } from '../../../shared/domain/branchName'
import type { AgentAuthStatus, AgentId, AgentView } from '../../../shared/desktop/api'
import { AgentChoice, ModelChoice } from '../agents/NewChatFields'
import type { AgentStatuses } from '../agents/useAgents'
import { useAgentModelChoice } from '../agents/useAgentModelChoice'
import type { AgentModelChoice } from '../agents/useAgentModelChoice'
import { useFolderDefaultAgent } from '../agents/useFolderDefaultAgent'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import type { StartRunChoice } from './orchestration'

interface StartRunDialogProps {
  epicTitle: string
  /** The epic's folder; its default agent is chosen first when it can chat. */
  folderPath: string
  /** The connected agents and their sign-in states. */
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** True in a folder of repositories, where a run needs the epic branch name first. */
  multiRepo: boolean
  /** The epic branch name, or null when none is set. */
  branchName: string | null
  /** Records the epic branch name typed here; resolves false when it was refused (the shell says why). */
  onSetBranch(name: string): Promise<boolean>
  /** Starting the run is in progress; both choices wait. */
  busy: boolean
  /** Queues the run, as the Start run button always did, for an orchestrator started elsewhere to pick up. */
  onLeavePending(): void
  /** Queues the run and starts the chosen agent as its orchestrator. */
  onRunWithAgent(choice: StartRunChoice): void
  /** Opens the add-agent pane (the dialog closes). */
  onAddAgent(): void
  /** A sign-in prompt in the dialog asked an agent's state itself: the shell shows what it found, and the agent can be chosen once it is signed in. */
  onAgentStatus(id: AgentId, status: AgentAuthStatus): void
  onClose(): void
}

const DESCRIPTION =
  'Choose who runs this epic. An agent started here runs it in a chat you can follow, or you leave the run pending for an orchestrator you start yourself.'

type DialogProps = StartRunDialogProps

/** A lowercase hyphenated slug of the epic title, the Epic branch field's first value. */
function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Why a branch name is refused, by the shared epic branch name rule; null when it is valid. */
function branchProblem(name: string): string | null {
  const parsed = epicBranchName.safeParse(name)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid branch name')
}

/** A folder of repositories only: the epic branch, asked for when none is set, shown read-only otherwise. */
function EpicBranchSection(props: {
  branchName: string | null
  value: string
  problem: string | null
  onChange(value: string): void
}): JSX.Element {
  if (props.branchName !== null) {
    return (
      <section className="chat-field start-run-section" aria-label="Epic branch">
        <h3 className="field-label">Epic branch</h3>
        <p className="field-hint">
          <code>{props.branchName}</code>
        </p>
      </section>
    )
  }
  return (
    <section className="chat-field start-run-section" aria-label="Epic branch">
      <label className="field-label" htmlFor="start-run-epic-branch">
        Epic branch
      </label>
      <p className="field-hint">The branch the run works on in every repository its tickets name.</p>
      <input
        id="start-run-epic-branch"
        required
        value={props.value}
        aria-invalid={props.problem !== null}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.problem === null ? null : (
        <p className="form-error" role="alert">
          {props.problem}
        </p>
      )}
    </section>
  )
}

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

/** The Epic branch field's state, and a start that records the typed branch first when one is asked for. */
function useBranchStart(props: DialogProps): {
  branch: string
  setBranch(value: string): void
  problem: string | null
  start(then: () => void): Promise<void>
} {
  const askBranch = props.multiRepo && props.branchName === null
  const [branch, setBranch] = useState(() => branchSlug(props.epicTitle))
  const problem = askBranch ? branchProblem(branch) : null
  const start = async (then: () => void): Promise<void> => {
    if (problem !== null) return
    if (askBranch && !(await props.onSetBranch(branch))) return
    then()
  }
  return { branch, setBranch, problem, start }
}

/**
 * Start run, two ways. Run with an agent: pick a connected, signed-in agent and its model; Dark
 * Mechanicus queues the run and starts that agent as the orchestrator in a chat of this folder.
 * Leave pending: queue the run and wait for an external orchestrator. A signed-out agent has Sign in
 * in the list and can be chosen once it is signed in, without leaving the dialog; without a usable
 * agent the first choice links to where one is added, and Leave pending still works.
 */
export function StartRunDialog(props: StartRunDialogProps): JSX.Element {
  const preferred = useFolderDefaultAgent(props.folderPath)
  const choice = useAgentModelChoice(props.agents, props.statuses, preferred.agentId)
  const { agent } = choice
  const { branch, setBranch, problem, start } = useBranchStart(props)
  const blocked = props.busy || problem !== null
  const canRun = agent !== null && preferred.loaded && choice.settled && !blocked
  return (
    <Dialog
      title="Start run"
      description={DESCRIPTION}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant={canRun ? 'default' : 'primary'} disabled={blocked} onClick={() => void start(props.onLeavePending)}>
            Leave pending
          </Button>
          <Button
            variant="primary"
            disabled={!canRun}
            busy={props.busy}
            onClick={() => {
              if (agent !== null) void start(() => props.onRunWithAgent({ agent, model: choice.model }))
            }}
          >
            Run with agent
          </Button>
        </>
      }
    >
      <div className="form">
        {props.multiRepo ? (
          <EpicBranchSection branchName={props.branchName} value={branch} problem={problem} onChange={setBranch} />
        ) : null}
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
