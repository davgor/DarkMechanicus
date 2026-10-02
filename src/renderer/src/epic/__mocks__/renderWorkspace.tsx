/**
 * Renders the epic workspace against a FakeBackend with a fixed clock and its own view memory, so
 * no test inherits the views another one picked (test support only).
 */
import { render, type RenderResult } from '@testing-library/react'
import type { Clock } from '../clock'
import { ClockContext } from '../clock'
import { EpicWorkspace, type EpicWorkspaceProps } from '../EpicWorkspace'
import { ViewMemoryContext, createViewMemory } from '../viewMemory'
import type { FakeBackend } from './fakeBackend'
import { NOW, folder } from './fixtures'

const FIXED_CLOCK: Clock = {
  now: () => NOW,
  subscribe: () => () => undefined
}

export interface WorkspaceHarness extends RenderResult {
  backend: FakeBackend
  changes: { count: number }
  opened: string[]
  refresh(token: number): void
  /** Shows another epic in the same place, as picking it in the sidebar does. */
  openEpic(epicId: string): void
}

export function renderWorkspace(backend: FakeBackend, patch: Partial<EpicWorkspaceProps> = {}): WorkspaceHarness {
  window.dm = backend
  const changes = { count: 0 }
  const opened: string[] = []
  const memory = createViewMemory()
  let shown = { refreshToken: patch.refreshToken ?? 0, epicId: patch.epicId ?? 'ep_1' }
  const element = (): JSX.Element => (
    <ClockContext.Provider value={FIXED_CLOCK}>
      <ViewMemoryContext.Provider value={memory}>
        <EpicWorkspace
          folder={folder()}
          onChanged={() => {
            changes.count += 1
          }}
          onOpenEpic={(epicId) => opened.push(epicId)}
          {...patch}
          {...shown}
        />
      </ViewMemoryContext.Provider>
    </ClockContext.Provider>
  )
  const result = render(element())
  const show = (next: Partial<typeof shown>): void => {
    shown = { ...shown, ...next }
    result.rerender(element())
  }
  return {
    ...result,
    backend,
    changes,
    opened,
    refresh: (refreshToken) => show({ refreshToken }),
    openEpic: (epicId) => show({ epicId })
  }
}
