import { isActiveRunState } from '../../../shared/domain/status'
import type { RunView } from '../../../shared/domain/views'
import { agentName } from '../agents/agentText'
import { SignInOffer } from '../agents/SignInPrompt'
import { orchestratingChat } from './orchestration'
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
      title={held && signedOut?.agent ? `Sign in to ${agentName(signedOut.agent)} first` : undefined}
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

/** Which chat is orchestrating the run, with a link to it; or that a queued run waits for an orchestrator. */
function OrchestratorLine({ ws, note }: { ws: WorkspaceHandle; note: OrchestratorNote }): JSX.Element {
  if (note.kind === 'waiting') {
    return <p className="ew-bar-note">{note.text}</p>
  }
  return (
    <p className="ew-bar-note">
      <span>{note.text}</span>
      <button type="button" className="ew-link" onClick={() => ws.orchestration.onOpenChat(note.chatId)}>
        {note.link}
      </button>
    </p>
  )
}

/**
 * A run paused because its orchestrator's agent signed out: says so, links the orchestrator chat, and offers
 * Sign in right here (or Check again for a state that could not be told). Resume waits for the agent.
 */
function SignedOutLine({ ws, note }: { ws: WorkspaceHandle; note: SignedOutNote }): JSX.Element {
  const host = ws.orchestration
  const { agent, chat } = note
  return (
    <div className="ew-bar-note ew-bar-signin">
      <span>{note.text}</span>
      {chat === null ? null : (
        <button type="button" className="ew-link" onClick={() => host.onOpenChat(chat.id)}>
          {chat.title}
        </button>
      )}
      {note.signedIn ? <span>Signed in again. The run can resume.</span> : null}
      {agent === null ? null : <SignInOffer kind={agent} status={note.status} onStatus={(status) => host.onAgentStatus(agent, status)} />}
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
  const signedOut = signedOutNote(run, chat, ws.orchestration.statuses)
  const orchestrator = signedOut === null ? orchestratorNote(run, chat) : null
  return (
    <div className="ew-bar ew-runbar" aria-label="Run">
      <div className="ew-bar-row">
        <StatePill tone={pill.tone} label={pill.label} />
        <span className="ew-bar-text">{runSummary(run, ws.now, reportAt)}</span>
        <ul className="ew-counts" aria-label="Ticket counts">
          {runBarCounts(run).map((item) => (
            <li key={item.key} className={`ew-count ew-tone-${item.tone}`}>
              <span className="ew-dot" aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
        <RunButtons ws={ws} actions={runActions(run, { checkpoint: ws.data.checkpoint !== null, overview: ws.data.overview !== null })} signedOut={signedOut} />
      </div>
      {signedOut === null ? null : <SignedOutLine ws={ws} note={signedOut} />}
      {orchestrator === null ? null : <OrchestratorLine ws={ws} note={orchestrator} />}
      {adopt === null ? null : <AdoptLine ws={ws} notice={adopt} />}
      <OwnershipLine run={run} />
    </div>
  )
}
