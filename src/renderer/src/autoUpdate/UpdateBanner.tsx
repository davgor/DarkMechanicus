import { useEffect, useState } from 'react'
import type { AutoUpdateState } from '../../../shared/autoUpdate/types'

const DEFAULT_STATE: AutoUpdateState = {
  phase: 'idle',
  currentVersion: '0.0.0'
}

export function useAppUpdate(): AutoUpdateState {
  const [state, setState] = useState<AutoUpdateState>(DEFAULT_STATE)

  useEffect(() => {
    let active = true
    void window.autoUpdate.getState().then((initial) => {
      if (active) {
        setState(initial)
      }
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

  if (update.phase === 'idle' || update.phase === 'checking' || update.phase === 'error') {
    return null
  }

  const showRestart = update.phase === 'downloaded'

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-text">
        {update.message ??
          (update.phase === 'downloading'
            ? `Downloading update… ${update.downloadPercent ?? 0}%`
            : `Update ${update.availableVersion ?? ''} available`)}
      </span>
      {showRestart ? (
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
