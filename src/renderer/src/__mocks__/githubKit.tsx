import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ToastProvider } from '../app/toasts'
import { GithubAccountProvider } from '../github/GithubAccount'
import { FakeDm } from './fakeDm'
import { FakeGithub } from './fakeGithub'
import { ManualScheduler } from './manualScheduler'

/** window.github and window.dm fakes plus a manual clock, for views that use the GitHub account. */
export interface GithubKit {
  github: FakeGithub
  dm: FakeDm
  scheduler: ManualScheduler
}

export function githubKit(): GithubKit {
  const kit = { github: new FakeGithub(), dm: new FakeDm(), scheduler: new ManualScheduler() }
  window.github = kit.github
  window.dm = kit.dm
  return kit
}

/** Renders `children` inside the toast and GitHub account providers, as App does. */
export function renderWithGithub(kit: GithubKit, children: ReactNode): void {
  render(
    <ToastProvider scheduler={kit.scheduler}>
      <GithubAccountProvider>{children}</GithubAccountProvider>
    </ToastProvider>
  )
}
