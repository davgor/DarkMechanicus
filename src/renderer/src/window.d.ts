import type { AppInfoApi, AutoUpdateApi } from '../../preload'

declare global {
  interface Window {
    autoUpdate: AutoUpdateApi
    appInfo: AppInfoApi
  }
}

export {}
