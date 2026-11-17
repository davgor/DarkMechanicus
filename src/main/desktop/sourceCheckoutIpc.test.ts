import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { idleAgentDeps } from '../../test/idleAgents'
import { sampleId } from '../../test/mcpHarness'
import { createFolderRegistry, type FolderRegistry } from './folderRegistry'
import { createDesktopHandlers } from './handlers'
import { registerDesktopIpc } from './ipc'
import { createSourceCheckouts } from './sourceCheckout'
import { createSourceCheckoutHandlers, registerSourceCheckoutIpc } from './sourceCheckoutIpc'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Machine {
  root: string
  registry: FolderRegistry
  /** What the native dialog answers next (null: cancelled); the renderer never fills it. */
  dialog: (string | null)[]
  /** Folders the desktop handlers asked the workspace pool to open. */
  opened: string[]
  associationFile: string
  /** A renderer's `ipcRenderer.invoke` on a channel main registered. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function never(what: string): never {
  throw new Error(`${what} is not part of this test`)
}

/** A folder laid out like a Git clone of the Dark Mechanicus source, set up as a project (markers are existence-only). */
function dmLookAlike(path: string): string {
  for (const file of ['src/core/workspace.ts', 'src/main/index.ts', 'src/preload/index.ts', 'src/mcp/server.ts', 'electron.vite.config.ts', '.git/HEAD']) {
    mkdirSync(join(path, file, '..'), { recursive: true })
    writeFileSync(join(path, file), '')
  }
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'dark-mechanicus' }))
  mkdirSync(join(path, '.darkmechanicus'))
  const project = { format: 'darkmechanicus.project', formatVersion: 1, projectId: sampleId('project', 7), name: 'Dark Mechanicus', keyPrefix: 'DM', createdAt: '2026-01-01T00:00:00.000Z' }
  writeFileSync(join(path, '.darkmechanicus', 'project.json'), JSON.stringify(project))
  return realpathSync.native(path)
}

function plainFolder(path: string): string {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'README.md'), '# other\n')
  return realpathSync.native(path)
}

/** This machine's real folder registry, source checkout store and IPC registrations, under a fresh temporary folder. */
function machine(): Machine {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-source-ipc-')))
  roots.push(root)
  const paths = { file: join(root, 'userData', 'folders.json'), homeDir: join(root, 'home'), dmHome: join(root, 'dm-home') }
  const registry = createFolderRegistry(paths)
  const associationFile = join(root, 'userData', 'source-checkout.json')
  const checkouts = createSourceCheckouts({ ...paths, file: associationFile, registry, installedAppDirs: () => [] })
  const dialog: (string | null)[] = []
  const opened: string[] = []
  const listeners = new Map<string, Listener>()
  const ipcMain = { handle: (channel: string, listener: Listener) => void listeners.set(channel, listener) }
  registerSourceCheckoutIpc(ipcMain, createSourceCheckoutHandlers({ checkouts, registry, pickDirectory: async () => dialog.shift() ?? null }))
  registerDesktopIpc(
    ipcMain,
    createDesktopHandlers({
      registry,
      pool: { get: (path) => (opened.push(path), never(`opening ${path}`)), close: () => undefined },
      pickDirectory: () => never('the folder dialog of dm:pickFolder'),
      writeClipboard: () => never('the clipboard'),
      openExternal: () => never('opening a link'),
      mcpConfig: () => never('the MCP snippet'),
      installSkills: () => never('installing skills'),
      connectClaudeCode: () => never('connecting Claude Code'),
      previewBoardRemoval: () => never('the board preview'),
      removeBoardFiles: () => never('removing board files'),
      ...idleAgentDeps()
    })
  )
  return {
    root,
    registry,
    dialog,
    opened,
    associationFile,
    invoke: async (channel, ...args) => (listeners.get(channel) ?? never(`channel ${channel}`))({} as IpcMainInvokeEvent, ...args)
  }
}

/** The code an IPC call was rejected with, or `ok`. */
function codeOf(call: Promise<unknown>): Promise<string> {
  return call.then(
    () => 'ok',
    (error: { code?: string }) => error.code ?? 'thrown'
  )
}

describe('sourceCheckout:associate takes only folders the person already tracks (DM-189 c4)', () => {
  it('refuses an untracked clone the renderer names, in any form, and tracks and associates nothing', async () => {
    const m = machine()
    const clone = dmLookAlike(join(m.root, 'clones', 'dm-a'))
    const refusals = {
      absolute: await codeOf(m.invoke('sourceCheckout:associate', clone)),
      relative: await codeOf(m.invoke('sourceCheckout:associate', 'clones/dm-a')),
      object: await codeOf(m.invoke('sourceCheckout:associate', { path: clone })),
      tooLong: await codeOf(m.invoke('sourceCheckout:associate', `C:\\${'a'.repeat(40_000)}`))
    }
    expect(refusals).toEqual({ absolute: 'unauthorized', relative: 'unauthorized', object: 'invalid_input', tooLong: 'invalid_input' })
    expect(m.registry.list()).toEqual([])
    expect(existsSync(m.associationFile)).toBe(false)
  })

  it('revalidates a tracked folder the renderer names before associating it', async () => {
    const m = machine()
    const plain = plainFolder(join(m.root, 'plain'))
    m.registry.track(plain)
    expect(await m.invoke('sourceCheckout:associate', plain)).toMatchObject({ outcome: 'refused', problem: 'not_dm_source' })
    expect(existsSync(m.associationFile)).toBe(false)
  })
})

describe('sourceCheckout:pick decides by the native dialog only (DM-189 c4)', () => {
  it('ignores any path the renderer sends: a cancelled dialog tracks nothing', async () => {
    const m = machine()
    const clone = dmLookAlike(join(m.root, 'clones', 'dm-a'))
    m.dialog.push(null)
    expect(await m.invoke('sourceCheckout:pick', clone)).toEqual({ outcome: 'cancelled' })
    expect(m.registry.list()).toEqual([])
  })

  it('screens the dialog’s folder, not the renderer’s: a plain folder chosen is refused even when the renderer names a clone', async () => {
    const m = machine()
    const clone = dmLookAlike(join(m.root, 'clones', 'dm-a'))
    m.dialog.push(plainFolder(join(m.root, 'plain')))
    expect(await m.invoke('sourceCheckout:pick', clone)).toMatchObject({ outcome: 'refused', problem: 'not_dm_source' })
    expect({ folders: m.registry.list(), associated: existsSync(m.associationFile) }).toEqual({ folders: [], associated: false })
  })

  it('associates the clone the dialog chose, whatever folder the renderer named', async () => {
    const m = machine()
    const clone = dmLookAlike(join(m.root, 'clones', 'dm-a'))
    const plain = plainFolder(join(m.root, 'plain'))
    m.dialog.push(clone)
    expect(await m.invoke('sourceCheckout:pick', plain)).toMatchObject({ outcome: 'associated', folder: { path: clone }, added: true })
    expect(m.registry.list().map((folder) => folder.path)).toEqual([clone])
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'available', target: { projectId: sampleId('project', 7) }, local: { path: clone } })
  })
})

describe('dm:command keeps workspace authorization for renderer paths (DM-189 c4)', () => {
  it('opens no workspace for an untracked folder the renderer names, even to set it up, while the checkout stays tracked', async () => {
    const m = machine()
    const clone = dmLookAlike(join(m.root, 'clones', 'dm-a'))
    const plain = plainFolder(join(m.root, 'plain'))
    m.dialog.push(clone)
    await m.invoke('sourceCheckout:pick')
    const answer = await m.invoke('dm:command', plain, 'initializeRepository', { name: 'Taken over' })
    expect(answer).toEqual({ ok: false, error: { code: 'unauthorized', message: 'That folder is not tracked by Dark Mechanicus.' } })
    expect({ opened: m.opened, setUp: existsSync(join(plain, '.darkmechanicus')) }).toEqual({ opened: [], setUp: false })
  })
})
