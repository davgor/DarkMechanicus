/** A browser pipe that cannot start (R19-6): logged once, no address, and the rest of the browser still works and closes. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBrowser, type BrowserWindowLike, type WiredView } from './browserWiring'
import { fakeView, fakeWindow, type BeforeRequest, type FakeView } from './__mocks__/browserViewFakes'

const listen = vi.hoisted(() => ({ failure: null as unknown }))
vi.mock('../control/controlServer', () => ({
  createControlServer: () => Promise.reject(listen.failure)
}))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function start() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-browser-nopipe-')))
  roots.push(root)
  const windows: BrowserWindowLike<WiredView>[] = [fakeWindow().window]
  const views: FakeView[] = []
  const beforeRequests = new Map<string, BeforeRequest>()
  const log = vi.fn<(line: string) => void>()
  const wiring = startBrowser<WiredView>({
    root: join(root, 'browser'), appUrl: null, windows: () => windows, registry: { resolve: () => null },
    createView: (webPreferences) => {
      const view = fakeView(beforeRequests, webPreferences.partition)
      views.push(view)
      return view as unknown as WiredView
    },
    authorize: () => { throw new Error('no pipe, no requests') },
    images: { put: vi.fn() }, chatFor: () => null, bindings: { threadsOf: () => [] }, ticketKeyOfAttempt: async () => null,
    push: vi.fn(), log
  })
  return { wiring, views, log, folder: root }
}

describe('a browser pipe that cannot start', () => {
  it.each([
    ['an error', new Error('listen EACCES'), 'Browser transport failed: listen EACCES'],
    ['a bare value', 'pipe name taken', 'Browser transport failed: pipe name taken']
  ])('rejected with %s: logs it, leaves no address, and still closes every view on dispose', async (_name, failure, line) => {
    listen.failure = failure
    const { wiring, views, log, folder } = start()
    await expect(wiring.ready).rejects.toBe(failure)
    expect(log).toHaveBeenCalledWith(line)
    expect(wiring.address()).toBeUndefined()
    wiring.host.ensureAgentTab({ folder, chatId: 'chat-a' })
    await expect(wiring.dispose()).resolves.toBeUndefined()
    expect(views[0].webContents.close).toHaveBeenCalledOnce()
  })
})
