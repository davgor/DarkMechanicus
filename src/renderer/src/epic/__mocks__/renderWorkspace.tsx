/**
 * Renders the epic workspace against a FakeBackend with a fixed clock and its own view memory, so
 * no test inherits the views another one picked (test support only).
 */
import { render, type RenderResult } from '@testing-library/react'
import { SignInRecorder } from '../../__mocks__/signInRecorder'
import type { Clock } from '../clock'
import { ClockContext } from '../clock'
import { EpicWorkspace, type EpicWorkspaceProps } from '../EpicWorkspace'
import { ViewMemoryContext, createViewMemory } from '../viewMemory'
import type { FakeBackend } from './fakeBackend'
import { fakeOrchestration } from './fakeOrchestration'
import { NOW, folder } from './fixtures'

const FIXED_CLOCK: Clock = {
  now: () => NOW,
  subscribe: () => () => undefined
}

export interface WorkspaceHarness extends RenderResult {
  backend: FakeBackend
  changes: { count: number }
  /** Times the workspace reported its epic deleted. */
  deleted: { count: number }
  opened: string[]
  /** The sign-in views the workspace's Sign in buttons opened, as the shell would show them. */
  signIn: SignInRecorder
  refresh(token: number): void
  /** Shows another epic in the same place, as picking it in the sidebar does. */
  openEpic(epicId: string): void
}

export function renderWorkspace(backend: FakeBackend, patch: Partial<EpicWorkspaceProps> = {}): WorkspaceHarness {
  window.dm = backend
  const changes = { count: 0 }
  const deleted = { count: 0 }
  const opened: string[] = []
  const memory = createViewMemory()
  const host = fakeOrchestration()
  const signIn = new SignInRecorder()
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
          onDeleted={() => {
            deleted.count += 1
          }}
          orchestration={host}
          {...patch}
          {...shown}
        />
      </ViewMemoryContext.Provider>
    </ClockContext.Provider>
  )
  const result = render(signIn.wrap(element()))
  const show = (next: Partial<typeof shown>): void => {
    shown = { ...shown, ...next }
    result.rerender(signIn.wrap(element()))
  }
  return {
    ...result,
    backend,
    changes,
    deleted,
    opened,
    signIn,
    refresh: (refreshToken) => show({ refreshToken }),
    openEpic: (epicId) => show({ epicId })
  }
}
