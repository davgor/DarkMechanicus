import type { AutoUpdatePhase, AutoUpdateState } from '../../../shared/autoUpdate/types'

export function shouldHideUpdateBanner(phase: AutoUpdatePhase): boolean {
  return phase === 'idle' || phase === 'checking' || phase === 'error'
}

export function shouldShowRestartButton(phase: AutoUpdatePhase): boolean {
  return phase === 'downloaded'
}

export function formatUpdateBannerText(update: AutoUpdateState): string {
  if (update.message) {
    return update.message
  }
  if (update.phase === 'downloading') {
    return `Downloading update… ${update.downloadPercent ?? 0}%`
  }
  return `Update ${update.availableVersion ?? ''} available`
}
