import { AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { ActivityNote } from './ActivityNote'
import { AGENT_BLURBS, agentName } from './agentText'
import { CheckAgain, SignInPrompt } from './SignInPrompt'
import type { AgentsModel } from './useAgents'

interface AddAgentPaneProps {
  agents: AgentsModel
}

interface AgentCardProps {
  kind: AgentKind
  agents: AgentsModel
  connected: AgentView | undefined
}

function ConnectedLine({ agent }: { agent: AgentView }): JSX.Element {
  return (
    <p className="agent-card-state tone-ok">
      <Icon name="check" size={14} />
      <span>{agent.version === null ? 'Connected' : `Connected · v${agent.version}`}</span>
    </p>
  )
}

/**
 * Whether a connected agent can be used yet, right on its card: a signed-out one says so and offers
 * Sign in (so the person learns it here, not from a failed chat), an unknown one gives its reason and
 * Check again.
 */
function SignInLine({ kind, status, onStatus }: { kind: AgentKind; status: AgentAuthStatus | undefined; onStatus(status: AgentAuthStatus): void }): JSX.Element {
  const name = agentName(kind)
  switch (status?.state) {
    case undefined:
      return <p className="agent-card-state tone-muted">Checking sign-in…</p>
    case 'signed_in':
      return <p className="agent-card-state tone-ok">Signed in</p>
    case 'signed_out':
      return (
        <>
          <p className="agent-card-state tone-warn">
            <Icon name="warning" size={14} />
            <span>{`Signed out. Sign in to use ${name}.`}</span>
          </p>
          <SignInPrompt kind={kind} onStatus={onStatus} />
        </>
      )
    case 'unknown':
      return <CheckAgain kind={kind} reason={status.reason} onStatus={onStatus} />
  }
}

/** Find opens a native file dialog; Download (Update once connected) runs the vendor's installer after a confirmation. */
function CardActions({ kind, agents, connected }: AgentCardProps): JSX.Element {
  const name = agentName(kind)
  const activity = agents.activity(kind)
  return (
    <div className="button-row">
      <Button
        icon="search"
        aria-label={`Find ${name}`}
        busy={activity.finding}
        disabled={activity.busy}
        onClick={() => void agents.find(kind)}
      >
        Find
      </Button>
      <Button
        icon={connected ? 'refresh' : 'download'}
        aria-label={`${connected ? 'Update' : 'Download'} ${name}`}
        busy={activity.download !== null}
        disabled={activity.busy}
        onClick={() => void agents.download(kind)}
      >
        {connected ? 'Update' : 'Download'}
      </Button>
    </div>
  )
}

function AgentCard(props: AgentCardProps): JSX.Element {
  const { kind, agents, connected } = props
  const name = agentName(kind)
  return (
    <article className="card agent-card" aria-label={name}>
      <h2 className="agent-card-title">{name}</h2>
      <p className="note">{AGENT_BLURBS[kind]}</p>
      {connected ? <ConnectedLine agent={connected} /> : null}
      <ActivityNote name={name} activity={agents.activity(kind)} />
      {connected ? <SignInLine kind={kind} status={agents.statuses[kind]} onStatus={(status) => agents.recordStatus(kind, status)} /> : null}
      <CardActions {...props} />
    </article>
  )
}

/** Replaces the main pane when + is pressed: one card per supported agent to find or download. */
export function AddAgentPane({ agents }: AddAgentPaneProps): JSX.Element {
  return (
    <div className="home agent-pane">
      <header className="home-header">
        <div>
          <span className="eyebrow">AGENTS</span>
          <h1 className="display">Add an agent</h1>
          <p className="lede">
            Connect the coding agents Dark Mechanicus can work with. Find one already installed on this computer, or
            download it from its official source.
          </p>
        </div>
      </header>
      <div className="agent-cards">
        {AGENT_KINDS.map((kind) => (
          <AgentCard
            key={kind}
            kind={kind}
            agents={agents}
            connected={agents.agents.find((agent) => agent.kind === kind)}
          />
        ))}
      </div>
    </div>
  )
}
