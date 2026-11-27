import { useState } from 'react'
import { isActiveRunState } from '../../../shared/domain/status'
import type { RunView } from '../../../shared/domain/views'
import { agentName } from '../agents/agentText'
import { SignInOffer } from '../agents/SignInPrompt'
import { deliveryLine, type DeliveryLine as DeliveryHold } from './deliveryView'
import { orchestratingChat } from './orchestration'
import { OrchestratorEntry } from './OrchestratorFeed'
import {
  adoptNotice,
  orchestratorNote,
  resumeBlocked,
  runActions,
  runBarCounts,
  runPill,
  runSummary,
  signedOutNote,
  type AdoptNotice,
  type OrchestratorNote,
  type RunActions,
  type SignedOutNote
} from './runBarView'
import { StatePill } from './StatePill'
import type { WorkspaceHandle } from './useWorkspace'

interface RunButtonsProps {
  ws: WorkspaceHandle
  actions: RunActions
  /** Why the run was paused, when it was for a lost sign-in: Resume waits for the agent to be signed in. */
  signedOut: SignedOutNote | null
}

/** Resume run; after a lost sign-in it waits until the agent is signed in again, and says so. */
function ResumeButton({ ws, signedOut }: Pick<RunButtonsProps, 'ws' | 'signedOut'>): JSX.Element {
  const held = resumeBlocked(signedOut)
  return (
    <button
      type="button"
      className="btn"
      disabled={ws.state.busy || held}
      title={held && signedOut?.agent ? `Sign in to ${agentName(signedOut.agent, ws.orchestration.agents)} first` : undefined}
      onClick={() => void ws.actions.runCommand('resume')}
    >
      Resume run
    </button>
  )
}

function RunButtons({ ws, actions, signedOut }: RunButtonsProps): JSX.Element {
  const busy = ws.state.busy
  const open = ws.state.checkpointOpen
  return (
    <div className="ew-bar-actions">
      {actions.pause ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.runCommand('pause')}>
          Pause run
        </button>
      ) : null}
      {actions.resume ? <ResumeButton ws={ws} signedOut={signedOut} /> : null}
      {actions.takeover ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.runCommand('takeover')}>
          Take over
        </button>
      ) : null}
      {actions.cancel ? (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => ws.dispatch({ type: 'confirm', kind: 'cancel_run' })}>
          Cancel run
        </button>
      ) : null}
      {actions.report === null ? null : (
        <button type="button" className="btn" onClick={() => ws.dispatch({ type: open ? 'close_checkpoint' : 'open_checkpoint' })}>
          {open ? 'Open graph' : actions.report}
        </button>
      )}
    </div>
  )
}

function AdoptLine({ ws, notice }: { ws: WorkspaceHandle; notice: AdoptNotice }): JSX.Element {
  return (
    <p className="ew-bar-note">
      <span>{notice.note}</span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!notice.enabled || ws.state.busy}
        title={notice.enabled ? undefined : 'Available at a checkpoint or while the run is paused'}
        onClick={() => void ws.actions.adopt(notice.revisionId)}
      >
        Adopt
      </button>
    </p>
  )
}

/** Which chat is orchestrating the run, with a link that shows it in the Agent tab; or that a queued run waits for an orchestrator. */
function OrchestratorLine({ ws, note }: { ws: WorkspaceHandle; note: OrchestratorNote }): JSX.Element {
  if (note.kind === 'waiting') {
    return <p className="ew-bar-note">{note.text}</p>
  }
  return (
    <p className="ew-bar-note">
      <span>{note.text}</span>
      <button type="button" className="ew-link" onClick={() => ws.dispatch({ type: 'open_agent', chatId: note.chatId })}>
        {note.link}
      </button>
    </p>
  )
}

function DeliveryChecks({ checks }: { checks: DeliveryHold['checks'] }): JSX.Element | null {
  return checks.length === 0 ? null : (
    <ul className="ew-delivery-checks" aria-label="Delivery checks">
      {checks.map((check, index) => (
        // Two checks can share a name, so the position identifies the entry.
        <li key={`${index}:${check.name}`} className={`is-${check.status}`}>
          <span className="cp-icon" aria-label={check.status}>
            {check.icon}
          </span>
          <span>{check.name}</span>
          <span className="ew-muted">{check.detail}</span>
        </li>
      ))}
    </ul>
  )
}

/** Waive…, then the reason box: Waive delivery stays disabled until the trimmed reason is non-empty. */
function WaiveDelivery({ ws, sprintId }: { ws: WorkspaceHandle; sprintId: string }): JSX.Element {
  // null while the reason box is closed.
  const [reason, setReason] = useState<string | null>(null)
  const busy = ws.state.busy
  if (reason === null) {
    return (
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setReason('')}>
        Waive…
      </button>
    )
  }
  const text = reason.trim()
  const waive = async (): Promise<void> => {
    if (text !== '' && (await ws.actions.waiveDelivery(sprintId, text))) {
      setReason(null)
    }
  }
  return (
    <form
      className="ew-delivery-waive"
      onSubmit={(event) => {
        event.preventDefault()
        void waive()
      }}
    >
      <input
        type="text"
        className="input"
        aria-label="Why waive the delivery check"
        placeholder="Why the delivery check can be skipped"
        maxLength={2000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <button type="submit" className="btn" disabled={busy || text === ''}>
        Waive delivery
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setReason(null)}>
        Cancel
      </button>
    </form>
  )
}

/**
 * An earlier sprint's delivery that holds the run's next claims: no check yet, or the latest check's named results,
 * with the person's Waive…. Nothing once every earlier delivering sprint passed its latest check or was waived.
 */
function DeliveryLine({ ws, run }: { ws: WorkspaceHandle; run: RunView }): JSX.Element | null {
  const line = deliveryLine(run, ws.data.saved?.bundle ?? null)
  if (line === null) {
    return null
  }
  const head = `Sprint ${line.ordinal} delivery to ${line.target}`
  return (
    <div className="ew-bar-note ew-bar-delivery" role="group" aria-label="Sprint delivery">
      <span>{line.state === 'pending' ? `${head}: waiting for the Magos to record it` : `${head}: the latest check failed`}</span>
      <DeliveryChecks checks={line.checks} />
      <WaiveDelivery key={line.sprintId} ws={ws} sprintId={line.sprintId} />
    </div>
  )
}

/**
 * A run paused because its orchestrator's agent signed out: says so, links the orchestrator chat (shown in the Agent
 * tab), and offers Sign in right here (or Check again for a state that could not be told). Resume waits for the agent.
 */
function SignedOutLine({ ws, note }: { ws: WorkspaceHandle; note: SignedOutNote }): JSX.Element {
  const host = ws.orchestration
  const { agent, chat } = note
  return (
    <div className="ew-bar-note ew-bar-signin">
      <span>{note.text}</span>
      {chat === null ? null : (
        <button type="button" className="ew-link" onClick={() => ws.dispatch({ type: 'open_agent', chatId: chat.id })}>
          {chat.title}
        </button>
      )}
      {note.signedIn ? <span>Signed in again. The run can resume.</span> : null}
      {agent === null ? null : <SignInOffer agent={agent} name={agentName(agent, host.agents)} status={note.status} onStatus={(status) => host.onAgentStatus(agent, status)} />}
    </div>
  )
}

function OwnershipLine({ run }: { run: RunView }): JSX.Element | null {
  const imported = !run.ownedByThisMachine && isActiveRunState(run.state)
  return imported ? (
    <p className="ew-bar-note">This run was imported from another machine. Take over to control it here.</p>
  ) : null
}

/** Run state, pinned revision, sprint progress, counts and controls (Saved view). */
export function RunBar({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const run = ws.data.run
  if (run === null) {
    return null
  }
  const pill = runPill(run)
  const adopt = adoptNotice(run, ws.data.epic)
  const reportAt = ws.data.checkpoint?.report?.createdAt ?? null
  const chat = orchestratingChat(ws.orchestration.chats, run)
  const signedOut = signedOutNote(run, chat, ws.orchestration.statuses, ws.orchestration.agents)
  const orchestrator = signedOut === null ? orchestratorNote(run, chat, ws.orchestration.agents) : null
  return (
    <div className="ew-bar ew-runbar" aria-label="Run">
      <div className="ew-bar-row">
        <StatePill tone={pill.tone} label={pill.label} />
        <span className="ew-bar-text">{runSummary(run, ws.now, reportAt)}</span>
        <OrchestratorEntry ws={ws} run={run} />
        <ul className="ew-counts" aria-label="Ticket counts">
          {runBarCounts(run).map((item) => (
            <li key={item.key} className={`ew-count ew-tone-${item.tone}`}>
              <span className="ew-dot" aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
        <RunButtons ws={ws} actions={runActions(run, { checkpoint: ws.data.checkpoint !== null, overview: run.state === 'completed' })} signedOut={signedOut} />
      </div>
      {signedOut === null ? null : <SignedOutLine ws={ws} note={signedOut} />}
      {orchestrator === null ? null : <OrchestratorLine ws={ws} note={orchestrator} />}
      <DeliveryLine ws={ws} run={run} />
      {adopt === null ? null : <AdoptLine ws={ws} notice={adopt} />}
      <OwnershipLine run={run} />
    </div>
  )
}
