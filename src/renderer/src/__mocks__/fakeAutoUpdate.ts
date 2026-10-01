import type { AutoUpdateApi } from '../../../preload'
import type { AutoUpdateState } from '../../../shared/autoUpdate/types'

/** Hand-written window.autoUpdate: reports an idle state and records update checks. */
export class FakeAutoUpdate implements AutoUpdateApi {
  state: AutoUpdateState = { phase: 'idle', currentVersion: '0.4.0' }
  checks = 0
  installs = 0
  private listeners: ((state: AutoUpdateState) => void)[] = []

  getState(): Promise<AutoUpdateState> {
    return Promise.resolve(this.state)
  }

  checkForUpdates(): Promise<void> {
    this.checks += 1
    return Promise.resolve()
  }

  quitAndInstall(): Promise<void> {
    this.installs += 1
    return Promise.resolve()
  }

  onEvent(listener: (state: AutoUpdateState) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener)
    }
  }

  emit(state: AutoUpdateState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }
}
