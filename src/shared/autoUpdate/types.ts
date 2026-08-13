export type AutoUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface AutoUpdateState {
  phase: AutoUpdatePhase
  currentVersion: string
  availableVersion?: string
  downloadPercent?: number
  message?: string
}

export const AUTO_UPDATE_EVENT_CHANNEL = 'autoUpdate:event'
