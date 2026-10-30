import { AGENT_DEFINITIONS, isBuiltInAgentKind } from '../../../shared/desktop/agentKinds'
import type { AgentAuthStatus, AgentDownloadProgress, AgentId, AgentProtocol, AgentView, BuiltInAgentKind } from '../../../shared/desktop/api'

/**
 * What to call an agent by its id (a chat's agent, which can outlive its connection): the connected
 * agent's `displayName` when it is among `connected`, otherwise the built-in kind's name, or a generic one for a custom agent.
 */
export function agentName(id: AgentId, connected: readonly Pick<AgentView, 'id' | 'displayName'>[] = []): string {
  const agent = connected.find((candidate) => candidate.id === id)
  if (agent !== undefined) {
    return agent.displayName
  }
  return isBuiltInAgentKind(id) ? AGENT_DEFINITIONS[id].displayName : 'Custom agent'
}

/** One line per agent on its card in the add-agent pane. */
export const AGENT_BLURBS: Readonly<Record<BuiltInAgentKind, string>> = {
  claude: 'Anthropic’s coding agent, run from the terminal.',
  codex: 'OpenAI’s coding agent, run from the terminal.',
  cursor: 'Cursor’s coding agent, run from the terminal.',
  autonomous: 'The Autonomous coding agent (a8s). Install it with its own installer, then find it here.'
}

/** The Custom CLI card's line in the add-agent pane. */
export const CUSTOM_AGENT_BLURB = 'Any other coding agent CLI that speaks ACP, Codex app-server or Claude Code SDK.'

interface ProtocolText {
  label: string
  /** One line on what the protocol is, shown beside its choice. */
  hint: string
}

/** What each protocol a custom CLI can speak is called, in the order the form offers them. */
export const PROTOCOL_TEXT: Readonly<Record<AgentProtocol, ProtocolText>> = {
  acp: { label: 'ACP', hint: 'Agent Client Protocol over standard input and output, as Cursor and Autonomous speak it.' },
  codex: { label: 'Codex app-server', hint: 'The JSON-RPC server Codex runs with its app-server command.' },
  claude: { label: 'Claude Code SDK', hint: 'Claude Code’s streaming JSON mode; the app adds its own flags after your arguments.' }
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
    case 'unchecked':
      return { text: 'Sign-in not checked', tone: 'muted' }
  }
}

const CONNECTED_VIA_TEXT: Readonly<Record<AgentView['connectedVia'], string>> = {
  found: 'Found on this computer',
  downloaded: 'Downloaded by Dark Mechanicus',
  custom: 'Added as a custom CLI'
}

export function connectedViaText(via: AgentView['connectedVia']): string {
  return CONNECTED_VIA_TEXT[via]
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
