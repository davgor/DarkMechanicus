import { useEffect, useState } from 'react'
import type { AutoUpdateState } from '../../../shared/autoUpdate/types'
import {
  formatUpdateBannerText,
  shouldHideUpdateBanner,
  shouldShowRestartButton
} from './updateBannerView'

const DEFAULT_STATE: AutoUpdateState = {
  phase: 'idle',
  currentVersion: '0.0.0'
}

export function useAppUpdate(): AutoUpdateState {
  const [state, setState] = useState<AutoUpdateState>(DEFAULT_STATE)

  useEffect(() => {
    let active = true
    void window.autoUpdate.getState().then((initial) => {
      const apply = active ? setState : (_value: AutoUpdateState): void => undefined
      apply(initial)
    })
    const unsubscribe = window.autoUpdate.onEvent((event) => {
      setState(event)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}

export function UpdateBanner(): JSX.Element | null {
  const update = useAppUpdate()

  return shouldHideUpdateBanner(update.phase) ? null : (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-text">{formatUpdateBannerText(update)}</span>
      {shouldShowRestartButton(update.phase) ? (
        <button
          type="button"
          className="update-banner-restart"
          onClick={() => void window.autoUpdate.quitAndInstall()}
        >
          Restart now
        </button>
      ) : null}
    </div>
  )
}
