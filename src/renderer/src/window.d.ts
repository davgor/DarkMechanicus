import type { AppInfoApi, AutoUpdateApi } from '../../preload'
import type { DmApi } from '../../shared/desktop/api'

declare global {
  interface Window {
    autoUpdate: AutoUpdateApi
    appInfo: AppInfoApi
    dm: DmApi
  }
}

export {}
