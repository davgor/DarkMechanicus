import type { AgentDownloadProgress } from '../../../shared/desktop/api'
import type { AgentOutcome } from './agentOutcomes'

/** How far a running download has got, as the main process last reported it. */
export type DownloadState = Pick<AgentDownloadProgress, 'phase' | 'percent'>

/** What is going on for one agent kind, kept above the screens so it survives moving between them. */
export interface ActivityState {
  /** The native file dialog of Find is open. */
  finding: boolean
  /** A download (or an update) is running, from its confirmation to its end. */
  download: DownloadState | null
  /** What the last action came to, shown where it was started until the next one begins. */
  outcome: AgentOutcome | null
}

export interface AgentActivity extends ActivityState {
  /** Find or Download is in flight, so neither can start again for this kind. */
  busy: boolean
}

export const IDLE_ACTIVITY: ActivityState = { finding: false, download: null, outcome: null }

export function describeActivity(state: ActivityState): AgentActivity {
  return { ...state, busy: state.finding || state.download !== null }
}
