import type { AppInfoApi, AutoUpdateApi } from '../../preload'
import type { DmApi } from '../../shared/desktop/api'
import type { GitApi } from '../../shared/git/api'
import type { GithubApi } from '../../shared/github/api'

declare global {
  interface Window {
    autoUpdate: AutoUpdateApi
    appInfo: AppInfoApi
    dm: DmApi
    git: GitApi
    github: GithubApi
  }
}

export {}
