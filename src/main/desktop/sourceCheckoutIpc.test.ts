import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindForge } from '../../core/repo/forgeBinding'
import { projectKey } from '../../core/repo/storageMode'
import { idleAgentDeps } from '../../test/idleAgents'
import { gitIn, put } from '../../test/gitScratch'
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
  dialog: (string | null | (() => string))[]
  suggested: (string | undefined)[]
  dmHome: string
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
  const dialog: Machine['dialog'] = []
  const suggested: (string | undefined)[] = []
  const opened: string[] = []
  const listeners = new Map<string, Listener>()
  const ipcMain = { handle: (channel: string, listener: Listener) => void listeners.set(channel, listener) }
  registerSourceCheckoutIpc(ipcMain, createSourceCheckoutHandlers({ checkouts, registry,
    pickDirectory: async (path) => {
      suggested.push(path)
      const selected = dialog.shift()
      return typeof selected === 'function' ? selected() : selected ?? null
    } }))
  registerDesktopIpc(
    ipcMain,
    createDesktopHandlers({
      registry,
      pool: { get: (path) => (opened.push(path), never(`opening ${path}`)), close: () => undefined },
      releaseFolder: () => never('releasing a folder'),
      stopMailMonitor: () => never('stopping a mail monitor'),
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
    suggested,
    dmHome: paths.dmHome,
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

function forgeSource(m: Machine) {
  const world = join(m.root, 'forge-world')
  const member = join(world, 'DarkMechanicus')
  const code = dmLookAlike(join(m.root, 'code'))
  rmSync(join(code, '.git'), { recursive: true })
  const sourceRecord = join(code, '.darkmechanicus', 'project.json')
  const record = readFileSync(sourceRecord, 'utf8')
  rmSync(join(code, '.darkmechanicus'), { recursive: true })
  const worldRepository = 'https://github.com/example/Forge-World.git'
  const sourceRepository = 'https://github.com/example/DarkMechanicus.git'
  const writeReference = (worldUrl = worldRepository, projectFolder = 'DarkMechanicus') => put(code, '.forge-world.json', JSON.stringify({
    version: 1, worldRepository: worldUrl, projectFolder
  }))
  writeReference()
  gitIn(code, 'init', '-q')
  gitIn(code, 'remote', 'add', 'origin', sourceRepository)
  put(world, 'forge-world.json', JSON.stringify({ version: 1, owner: 'example', projects: [{ folder: 'DarkMechanicus', repository: sourceRepository }], syncMinutes: 5 }))
  put(world, '.gitignore', '**/.darkmechanicus/local/\n')
  put(member, '.darkmechanicus/project.json', record)
  put(member, '.darkmechanicus/local/source-checkout.json', JSON.stringify({ checkout: code }))
  gitIn(world, 'init', '-q')
  gitIn(world, 'remote', 'add', 'origin', worldRepository)
  gitIn(world, 'add', '.')
  gitIn(world, 'commit', '-qm', 'Initialize fixture world')
  return { world, member, code, sourceRecord, sourceRepository, writeReference,
    hint: join(member, '.darkmechanicus', 'local', 'source-checkout.json'),
    project: join(member, '.darkmechanicus', 'project.json') }
}

  it('offers the verified local checkout and requires explicit selection before using the existing member', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'none' })
    expect(await m.invoke('sourceCheckout:pick', f.code)).toEqual({ outcome: 'cancelled' })
    expect(m.suggested).toEqual([f.code])
    expect(existsSync(m.associationFile)).toBe(false)
    expect(await codeOf(m.invoke('sourceCheckout:associate', f.code))).toBe('unauthorized')

    m.dialog.push(f.member, f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({
      outcome: 'refused',
      problem: 'not_dm_source',
      message: expect.stringContaining('is a Forge World ticket folder'),
      recovery: expect.stringMatching(/^Choose the linked Dark Mechanicus code checkout at .+code\.$/)
    })
    expect(existsSync(m.associationFile)).toBe(false)
    expect(await m.invoke('sourceCheckout:pick', f.member)).toMatchObject({
      outcome: 'associated', added: false, folder: { path: f.member, initialized: true },
      checkout: { status: 'available', target: { projectId: sampleId('project', 7) }, local: { path: f.code, projectPath: f.member } }
    })
    expect(m.registry.list().map(folder => folder.path)).toEqual([f.world, f.member])
    expect(existsSync(f.sourceRecord)).toBe(false)
    expect(m.opened).toEqual([])
  })

  it('directs a mistaken ticket-folder selection toward existing local code when no hint verifies', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    rmSync(f.hint)
    m.dialog.push(f.member)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({
      outcome: 'refused',
      message: expect.stringContaining('is a Forge World ticket folder'),
      recovery: expect.stringContaining('Choose your existing Dark Mechanicus code checkout outside the Forge World')
    })
    expect(m.suggested).toEqual([undefined])
    expect(existsSync(m.associationFile)).toBe(false)
  })

  it('refuses missing and untracked members, a different project reference and a different source or world origin before writing', async () => {
    const m = machine()
    const f = forgeSource(m)
    async function refuses() {
      m.dialog.push(f.code)
      expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
      expect(m.suggested.at(-1)).toBeUndefined()
      expect(existsSync(m.associationFile)).toBe(false)
      expect(existsSync(f.sourceRecord)).toBe(false)
      expect(m.registry.resolve(f.code)).toBeNull()
    }
    await refuses()
    m.registry.track(f.world)
    const record = readFileSync(f.project, 'utf8')
    rmSync(f.project)
    await refuses()
    writeFileSync(f.project, record)
    f.writeReference(undefined, 'Unknown')
    await refuses()
    f.writeReference('https://github.com/example/wrong-world.git')
    await refuses()
    f.writeReference()
    gitIn(f.code, 'remote', 'set-url', 'origin', 'https://github.com/example/wrong-source.git')
    await refuses()
  })

  it('permits authoritative explicit selection without the optional hint and revalidates project identity and a substituted path', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    rmSync(f.hint)
    m.dialog.push(f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'associated' })
    expect(m.suggested).toEqual([undefined])
    const saved = readFileSync(m.associationFile, 'utf8')
    const oldProject = readFileSync(f.project, 'utf8')
    writeFileSync(f.project, oldProject.replace(sampleId('project', 7), sampleId('project', 8)))
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'unavailable', problem: 'project_mismatch' })
    writeFileSync(f.project, oldProject)
    const movedMember = join(f.world, 'moved-member')
    renameSync(f.member, movedMember)
    symlinkSync(movedMember, f.member, 'junction')
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'unavailable', problem: 'project_mismatch' })
    rmSync(f.member)
    renameSync(movedMember, f.member)
    const moved = join(m.root, 'moved-code')
    renameSync(f.code, moved)
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'unavailable', problem: 'missing' })
    symlinkSync(moved, f.code, 'junction')
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'unavailable', problem: 'relocated' })
    m.dialog.push(f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'relocated' })
    expect(readFileSync(m.associationFile, 'utf8')).toBe(saved)
  })

  it('refuses an active Forge binding that points at a different member', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    bindForge(m.dmHome, f.code, f.member, '')
    m.dialog.push(f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'associated' })
    const saved = readFileSync(m.associationFile, 'utf8')
    const other = join(f.world, 'OtherMember')
    mkdirSync(other)
    bindForge(m.dmHome, f.code, other, '')
    expect(await m.invoke('sourceCheckout:get')).toMatchObject({ status: 'unavailable', problem: 'project_mismatch' })
    expect(readFileSync(m.associationFile, 'utf8')).toBe(saved)
  })

  it('refuses a member reserved by an unfinished Force migration', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    put(m.dmHome, join('forge-bindings', projectKey(join(m.root, 'pending')) + '.move.json'), JSON.stringify({ target: f.member, force: true }))
    m.dialog.push(f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
    expect(m.suggested).toEqual([undefined])
    expect(existsSync(m.associationFile)).toBe(false)
  })

  it('checks the mapping again after the native chooser returns', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    m.dialog.push(() => {
      gitIn(f.code, 'remote', 'set-url', 'origin', 'https://github.com/example/substitution.git')
      return f.code
    })
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
    expect(m.suggested).toEqual([f.code])
    expect(existsSync(m.associationFile)).toBe(false)
  })

  it('refuses a redirected ticket database or card directory with no local checkout hint', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    rmSync(f.hint)
    const outside = join(m.root, 'outside-ticket-store')
    mkdirSync(outside)
    const local = join(f.member, '.darkmechanicus', 'local')
    rmdirSync(local)
    for (const path of [local, join(f.member, '.darkmechanicus', 'kanban')]) {
      symlinkSync(outside, path, 'junction')
      m.dialog.push(f.code)
      expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
      expect(existsSync(m.associationFile)).toBe(false)
      rmSync(path)
    }
  })

  it('rejects Git-delivered hints both staged and committed, even while the index has a pending deletion', async () => {
    const m = machine()
    const f = forgeSource(m)
    m.registry.track(f.world)
    const privatePath = 'DarkMechanicus/.darkmechanicus/local/source-checkout.json'
    gitIn(f.world, 'add', '-f', '--', privatePath)
    m.dialog.push(f.code, f.code)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
    gitIn(f.world, 'commit', '-qm', 'Fixture deliberately tracks the hint')
    gitIn(f.world, 'rm', '--cached', '--', privatePath)
    expect(await m.invoke('sourceCheckout:pick')).toMatchObject({ outcome: 'refused', problem: 'project_mismatch' })
    expect(m.suggested).toEqual([undefined, undefined])
    expect(existsSync(m.associationFile)).toBe(false)
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
