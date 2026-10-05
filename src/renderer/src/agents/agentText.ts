import { AGENT_DEFINITIONS } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentDownloadProgress, AgentKind, AgentView } from '../../../shared/desktop/api'

export const agentName = (kind: AgentKind): string => AGENT_DEFINITIONS[kind].displayName

/** One line per agent on its card in the add-agent pane. */
export const AGENT_BLURBS: Readonly<Record<AgentKind, string>> = {
  claude: 'Anthropic’s coding agent, run from the terminal.',
  codex: 'OpenAI’s coding agent, run from the terminal.',
  cursor: 'Cursor’s coding agent, run from the terminal.'
}

interface SignInLabel {
  text: string
  /** Matches the `tone-*` classes; the color always comes with the words. */
  tone: 'ok' | 'warn' | 'muted'
}

/** The sign-in state in words; undefined while the agent's own status command is still running. */
export function signInLabel(status: AgentAuthStatus | undefined): SignInLabel {
  if (status === undefined) {
    return { text: 'Checking sign-in…', tone: 'muted' }
  }
  switch (status.state) {
    case 'signed_in':
      return { text: 'Signed in', tone: 'ok' }
    case 'signed_out':
      return { text: 'Signed out', tone: 'warn' }
    case 'unknown':
      return { text: 'Sign-in unknown', tone: 'muted' }
  }
}

export function connectedViaText(via: AgentView['connectedVia']): string {
  return via === 'found' ? 'Found on this computer' : 'Downloaded by Dark Mechanicus'
}

/** What the running download is doing, from the progress the main process reports. */
export function phaseText(progress: Pick<AgentDownloadProgress, 'phase' | 'percent'>): string {
  switch (progress.phase) {
    case 'confirming':
      return 'Waiting for your confirmation…'
    case 'downloading':
      return progress.percent === null ? 'Downloading the installer…' : `Downloading the installer… ${progress.percent}%`
    case 'verifying':
      return 'Verifying the download…'
    case 'installing':
      return 'Running the installer…'
    case 'checking':
      return 'Checking the installed program…'
    case 'done':
      return 'Finishing up…'
    case 'cancelled':
      return 'Cancelled.'
    case 'failed':
      return 'Stopped.'
  }
}
