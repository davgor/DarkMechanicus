/** Renders the epic workspace against a FakeBackend with a fixed clock (test support only). */
import { render, type RenderResult } from '@testing-library/react'
import type { Clock } from '../clock'
import { ClockContext } from '../clock'
import { EpicWorkspace, type EpicWorkspaceProps } from '../EpicWorkspace'
import type { FakeBackend } from './fakeBackend'
import { NOW, folder } from './fixtures'

export const FIXED_CLOCK: Clock = {
  now: () => NOW,
  subscribe: () => () => undefined
}

export interface WorkspaceHarness extends RenderResult {
  backend: FakeBackend
  changes: { count: number }
  opened: string[]
  refresh(token: number): void
}

export function renderWorkspace(backend: FakeBackend, patch: Partial<EpicWorkspaceProps> = {}): WorkspaceHarness {
  window.dm = backend
  const changes = { count: 0 }
  const opened: string[] = []
  const element = (token: number): JSX.Element => (
    <ClockContext.Provider value={FIXED_CLOCK}>
      <EpicWorkspace
        folder={folder()}
        epicId="ep_1"
        refreshToken={token}
        onChanged={() => {
          changes.count += 1
        }}
        onOpenEpic={(epicId) => opened.push(epicId)}
        {...patch}
      />
    </ClockContext.Provider>
  )
  const result = render(element(0))
  return { ...result, backend, changes, opened, refresh: (token) => result.rerender(element(token)) }
}
