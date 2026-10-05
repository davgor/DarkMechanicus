import type { AgentActivity, DownloadState } from './agentActivity'
import type { AgentOutcome } from './agentOutcomes'
import { phaseText } from './agentText'

interface ActivityNoteProps {
  /** The agent's display name, which labels its progress bar. */
  name: string
  activity: AgentActivity
}

/** Only the download phase knows how far along it is; every other step is shown as working. */
function Progress({ name, download }: { name: string; download: DownloadState }): JSX.Element {
  const value = download.phase === 'downloading' && download.percent !== null ? download.percent : undefined
  return <progress className="agent-progress" max={100} value={value} aria-label={`${name} download progress`} />
}

/**
 * The download starts at its confirmation: the main process asks in a native dialog (where the
 * installer comes from, the command that runs, where it installs) and reports nothing else until it
 * is answered, so this is what the person sees meanwhile.
 */
function DownloadNote({ name, download }: { name: string; download: DownloadState }): JSX.Element {
  return (
    <div className="agent-note" role="status">
      <p className="agent-note-title">{phaseText(download)}</p>
      {download.phase === 'confirming' ? (
        <p className="note">
          A dialog shows the source of the installer, the command that runs and where it installs. Nothing is
          downloaded until you confirm.
        </p>
      ) : (
        <Progress name={name} download={download} />
      )}
    </div>
  )
}

function OutcomeNote({ outcome }: { outcome: AgentOutcome }): JSX.Element {
  return (
    <div className="agent-note" role="status">
      <p className={`agent-note-title tone-${outcome.tone}`}>{outcome.title}</p>
      {outcome.detail === null ? null : <p className="note">{outcome.detail}</p>}
      {outcome.output.length === 0 ? null : <pre className="code-block agent-output">{outcome.output.join('\n')}</pre>}
    </div>
  )
}

function WorkingNote({ text }: { text: string }): JSX.Element {
  return (
    <div className="agent-note" role="status">
      <p className="agent-note-title">{text}</p>
    </div>
  )
}

/** What is happening for an agent, or what the last action came to; nothing when neither applies. */
export function ActivityNote({ name, activity }: ActivityNoteProps): JSX.Element | null {
  if (activity.download !== null) {
    return <DownloadNote name={name} download={activity.download} />
  }
  if (activity.finding) {
    return <WorkingNote text="Choose the program in the file dialog…" />
  }
  return activity.outcome === null ? null : <OutcomeNote outcome={activity.outcome} />
}
