import type { AppInfoApi, AutoUpdateApi } from '../../preload'
import type { DmApi } from '../../shared/desktop/api'
import type { GitApi } from '../../shared/git/api'

declare global {
  interface Window {
    autoUpdate: AutoUpdateApi
    appInfo: AppInfoApi
    dm: DmApi
    git: GitApi
  }
}

export {}
