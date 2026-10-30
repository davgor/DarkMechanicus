import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentAuthStatus, AgentView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { formatShortDate } from '../sidebar/epicStatusLine'
import { ActivityNote } from './ActivityNote'
import { connectedViaText, signInLabel } from './agentText'
import { CheckAgain, SignInPrompt } from './SignInPrompt'
import type { AgentsModel } from './useAgents'

interface AgentPageProps {
  agent: AgentView
  agents: AgentsModel
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The state is its color plus its words; Sign in is always offered (it also switches accounts), and an unknown state adds its reason and Check again. */
function SignInRow({ agent, agents }: AgentPageProps): JSX.Element {
  const { id } = agent
  const status = agents.statuses[id]
  const state = signInLabel(status)
  const record = (fresh: AgentAuthStatus): void => agents.recordStatus(id, fresh)
  return (
    <Row label="Sign-in">
      <div className="agent-signin">
        <span className={`agent-state tone-${state.tone}`}>
          <span className="agent-state-dot" aria-hidden="true" />
          {state.text}
        </span>
        <SignInPrompt
          key={status?.state ?? 'checking'}
          agent={id}
          name={agent.displayName}
          variant={status?.state === 'signed_out' ? 'primary' : 'default'}
          disabled={agents.activity(id).busy}
          onStatus={record}
        />
      </div>
      {status?.state === 'unknown' ? <CheckAgain agent={id} name={agent.displayName} reason={status.reason} onStatus={record} /> : null}
      {status === undefined || status.state === 'unknown' ? null : <p className="note">{status.reason}</p>}
    </Row>
  )
}

function Details({ agent, agents }: AgentPageProps): JSX.Element {
  return (
    <section className="card" aria-label="Connection">
      <h2 className="card-title">Connection</h2>
      <dl className="kv agent-kv">
        <Row label="Executable">
          <span className="mono">{agent.executablePath}</span>
        </Row>
        <Row label="Version">{agent.version ?? 'Unknown'}</Row>
        <Row label="Connected">
          {connectedViaText(agent.connectedVia)} · {formatShortDate(agent.connectedAt)}
        </Row>
        <SignInRow agent={agent} agents={agents} />
      </dl>
    </section>
  )
}

interface RemoveDialogProps {
  name: string
  onConfirm(): void
  onCancel(): void
}

/** Remove only forgets the connection, so the question says what stays. */
function RemoveDialog({ name, onConfirm, onCancel }: RemoveDialogProps): JSX.Element {
  return (
    <Dialog
      title={`Remove ${name}?`}
      description={`This only removes it from Dark Mechanicus. The ${name} CLI stays installed on this computer: nothing is uninstalled or deleted, and you can connect it again any time.`}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Remove
          </Button>
        </>
      }
    />
  )
}

/** A connected agent: where it runs from, how it was connected, whether it is signed in, and what can be done about it. */
export function AgentPage({ agent, agents }: AgentPageProps): JSX.Element {
  const [removing, setRemoving] = useState(false)
  const name = agent.displayName
  const { kind } = agent
  const activity = agents.activity(agent.id)
  return (
    <div className="home agent-pane">
      <header className="home-header">
        <div>
          <span className="eyebrow">AGENT</span>
          <h1 className="display">{name}</h1>
        </div>
      </header>
      <Details agent={agent} agents={agents} />
      <ActivityNote name={name} activity={activity} />
      <div className="button-row">
        {kind === 'custom' ? null : (
          <>
            <Button icon="search" busy={activity.finding} disabled={activity.busy} onClick={() => void agents.find(kind)}>
              Find again
            </Button>
            <Button
              icon="refresh"
              busy={activity.download !== null}
              disabled={activity.busy}
              onClick={() => void agents.download(kind)}
            >
              Update
            </Button>
          </>
        )}
        <Button disabled={activity.busy} onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
      {removing ? (
        <RemoveDialog
          name={name}
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false)
            void agents.remove(agent.id)
          }}
        />
      ) : null}
    </div>
  )
}
