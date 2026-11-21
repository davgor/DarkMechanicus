import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import type { GitRunner } from '../git/runner'
import type { CredentialSession } from '../git/credentials'
import { bindForge, FORGE_POINTER, pendingForgeTransfer, withForgeTransfer } from '../../core/repo/forgeBinding'
import { retireSqlitePolicy } from '../../core/repo/deliveryPolicy'
import { readProject } from '../../core/repo/initialize'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { dbProjectDir, SQLITE_STANDARDS_FILE } from '../../core/repo/storageMode'
import { assertStorageIdle } from '../../core/repo/storageMigration'
import { requireTracked } from './handlers'
import { FORGE_FILE, createForge, githubRemote, parseForge, projectName, updateForge } from './forgeManifest'
import { ForgeGit } from './forgeGit'
import type { FolderRegistry } from './folderRegistry'
import type { WorkspacePool } from './workspacePool'

const POINTER = FORGE_POINTER
interface Services {
  runner?: GitRunner
  registry: FolderRegistry
  pool: WorkspacePool
  session: CredentialSession
  pickDirectory(): Promise<string | null>
  cleanup(source: string): void
  home: string
  publish(name: string): Promise<void>
  onConflict(root: string, member: string | null): Promise<void>
  onSynced(root: string): Promise<void>
}
interface ForgeMove { root: string; member: string; source: string; folder: string; repository: string }
function ensureReconciled(result: import('../../shared/domain/views').ReconcileResultView): void {
  if (result.rejected.length || result.conflicts.length || result.profileConflicts.length || result.kanbanConflicts.length) throw new Error('Ticket records need reconciliation.')
}

function readPointer(note: string) {
  if (lstatSync(note).isSymbolicLink()) throw new Error('Invalid Forge World pointer.')
  const match = /^Forge World: (\S+)\r?\nProject folder: (.+?)\r?$/m.exec(readFileSync(note, 'utf8'))
  if (!match) throw new Error('Cannot read the Forge World pointer for this project.')
  return match
}

class ForgeService {
  private readonly git: ForgeGit
  private readonly resolving = new Set<string>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly last = new Map<string, number>()
  private readonly next = new Map<string, number>()
  private readonly errors = new Map<string, string>()

  constructor(private readonly deps: Services) { this.git = new ForgeGit(deps.session, deps.runner) }
  rootOf(input: unknown) {
    const root = requireTracked(this.deps.registry, input)
    if (realpathSync.native(root) !== root) throw new Error('The tracked folder moved.')
    return root
  }
  worldAt(root: string) {
    const file = join(root, FORGE_FILE)
    if (lstatSync(file).isSymbolicLink()) throw new Error('Invalid Forge World manifest.')
    return parseForge(readFileSync(file, 'utf8'))
  }
  sync(root: string, afterMutation = false): Promise<void> {
    const pending = this.active.get(root)
    if (pending) return afterMutation ? pending.then(() => this.sync(root)) : pending
    const work = (async () => {
      try {
        await this.git.sync(root, async () => {
          for (const project of this.worldAt(root).projects) {
            const member = join(root, project.folder)
            if (this.deps.registry.resolve(member) && existsSync(join(member, '.darkmechanicus/project.json'))) {
              const imported = await this.deps.pool.get(member).reconcileRepository()
              ensureReconciled(imported)
            }
          }
        })
        await this.deps.onSynced(root)
        this.resolving.delete(root)
        this.errors.delete(root)
        this.last.set(root, Date.now())
      } catch (error) {
        this.errors.set(root, error instanceof Error ? error.message : String(error))
        const conflicts = (await this.git.run(root, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
        if (conflicts.length) {
          const head = parseForge((await this.git.run(root, ['show', 'HEAD:' + FORGE_FILE])).stdout)
          if (!conflicts.every(path => path === FORGE_FILE || head.projects.some(p => path.startsWith(p.folder + '/.darkmechanicus/')))) throw error
          this.deps.registry.cacheForge?.(root, head)
          const project = head.projects.find(p => this.deps.registry.resolve(join(root, p.folder)))
          await this.deps.onConflict(root, project ? join(root, project.folder) : null)
          this.resolving.add(root)
        }
        throw error
      }
    })().finally(() => this.active.delete(root))
    this.active.set(root, work)
    return work
  }
  async checkout(repository: string, adopt: boolean) {
    const url = githubRemote(repository)
    const parts = new URL(url).pathname.slice(1, -4).split('/')
    const parent = join(this.deps.home, 'forge-worlds', parts[0])
    mkdirSync(parent, { recursive: true })
    const root = await this.existingCheckout(url) ?? join(parent, projectName(parts[1]))
    if (!existsSync(root)) {
      await this.git.run(parent, ['clone', '--no-checkout', '--', url, root], url)
      if ((await this.git.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { acceptExitCodes: [0, 128] })).code === 0) {
        await this.git.inspectTree(root, 'HEAD')
        await this.git.run(root, ['checkout', 'HEAD', '--', '.'])
      }
    }
    if (realpathSync.native(root) !== resolve(root)) throw new Error('Invalid Forge World checkout.')
    if (githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim()).toLowerCase() !== url.toLowerCase()) throw new Error('Checkout origin differs from requested Forge World.')
    if (!existsSync(join(root, FORGE_FILE)) && adopt) createForge(root, parts[0])
    this.worldAt(root)
    if ((await this.git.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { acceptExitCodes: [0, 128] })).code === 0) await this.git.inspectTree(root, 'HEAD')
    this.deps.registry.track(root)
    await this.sync(root)
    return root
  }
  async openProject(source: string): Promise<string> {
    const pending = pendingForgeTransfer(this.deps.home, source)
    if (pending && existsSync(join(dirname(pending), FORGE_FILE))) {
      await this.convert(dirname(pending), source)
      return pending
    }
    const note = join(source, POINTER)
    if (!existsSync(note)) return this.openUnlinked(source)
    const match = readPointer(note)
    const bound = this.deps.registry.list().filter(f => f.forgeWorld)
    for (const candidate of bound) {
      const member = join(candidate.path, projectName(match[2]))
      const target = pendingForgeTransfer(this.deps.home, member)
      if (target === source + '/repo' || target === source + '/db') {
        return this.restore(candidate.path, member, source, target.endsWith('/db') ? 'db' : 'repo')
      }
    }
    const root = await this.checkout(match[1], false)
    const project = this.worldAt(root).projects.find(p => p.folder === projectName(match[2]))
    if (!project) throw new Error('The Forge World does not contain this project.')
    const member = join(root, project.folder)
    bindForge(this.deps.home, source, member, readFileSync(note, 'utf8'))
    return member
  }
  async add(root: string, repository: string, name: string) {
    const world = this.worldAt(root)
    const folder = projectName(name)
    const url = githubRemote(repository)
    const member = join(root, folder)
    if (world.projects.some(p => p.folder.toLowerCase() === folder.toLowerCase() || p.repository.toLowerCase() === url.toLowerCase())) throw new Error('This repository or folder is already tracked.')
    if (!existsSync(member)) mkdirSync(member)
    else throw new Error('The project folder already exists in this Forge World.')
    await this.deps.pool.get(member).initializeRepository({ name: folder, mode: 'repo' })
    updateForge(root, w => w.projects.push({ folder, repository: url }))
    await this.sync(root, true)
  }
  async convert(root: string, source: string) {
    this.worldAt(root)
    if (root === source || this.deps.registry.list().some(f => f.path === source && (f.forgeWorld || f.forgeParent))) throw new Error('Select a source code project.')
    const folder = projectName(basename(source))
    const repository = githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim())
    const remote = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    const member = join(root, folder)
    await withForgeTransfer(this.deps.home, source, member, async (phase, advance) => {
      const note = join(source, POINTER)
      const body = [
        '# Ticket source control', '', 'Forge World: ' + remote, 'Project folder: ' + folder, '',
        'Clone or pull the Forge World above, then open the named folder for tickets.',
        'The root forge-world.json contains all linked project folders and their repository URLs.', ''
      ].join('\n')
      const move = { root, member, source, folder, repository }
      if (phase === 0) { await this.checkSource(move); advance(1) }
      if (phase < 2) { await this.exportSource(move); advance(2) }
      if (phase < 3) { await this.sync(root, true); advance(3) }
      if (phase < 4) { await this.retireSource(source, member); advance(4) }
      this.deps.cleanup(source)
      if (!existsSync(note)) writeFileSync(note, body, { flag: 'wx' })
      if (readFileSync(note, 'utf8') !== body) throw new Error('The source pointer changed during conversion.')
      bindForge(this.deps.home, source, member, body)
      this.deps.registry.untrack(source)
    })
  }
  async restore(root: string, member: string, source: string, mode: 'db' | 'repo') {
    const note = join(source, POINTER)
    const remote = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    const text = existsSync(note) ? readFileSync(note, 'utf8') : ''
    const linked = this.worldAt(root).projects.find(p => p.folder === basename(member))
    if (!text && (!linked || githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim()).toLowerCase() !== linked.repository.toLowerCase())) throw new Error('Select the linked code repository.')
    if (text && (!text.split(/\r?\n/).includes('Forge World: ' + remote) || !text.split(/\r?\n/).includes('Project folder: ' + basename(member)))) throw new Error('Choose the code checkout linked to this project.')
    await withForgeTransfer(this.deps.home, member, source + '/' + mode, async (phase, advance) => {
      if (phase === 0) {
        const ctx = this.deps.pool.get(member).ctx()
        assertStorageIdle({ db: ctx.db, clock: ctx.clock, sessionId: ctx.session.id })
        await this.sync(root)
        await this.deps.pool.get(member).flushPortableState()
        if (existsSync(join(source, '.darkmechanicus')) || existsSync(dbProjectDir(source, this.deps.home))) throw new Error('The destination already contains a ticket store.')
        advance(1)
      }
      if (phase < 2) {
        const dest = mode === 'repo' ? join(source, '.darkmechanicus') : dbProjectDir(source, this.deps.home)
        if (!existsSync(join(dest, 'project.json'))) this.deps.pool.get(member).exportForge!(source, mode)
        advance(2)
      }
      if (phase < 3) {
        await this.archiveStore(root, member)
        advance(3)
      }
      await this.sync(root, true)
      if (existsSync(note)) unlinkSync(note)
      this.deps.registry.track(source)
    })
    return source
  }
  register(ipc: Pick<IpcMain, 'handle'>) {
    ipc.handle('forge:create', async (_e, folder) => {
      const root = this.rootOf(folder)
      const url = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
      if (resolve((await this.git.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()) !== root) throw new Error('Select a Git repository root.')
      if (this.deps.pool.get(root).isInitialized()) throw new Error('Choose a dedicated ticket repository for the Forge World.')
      createForge(root, new URL(url).pathname.split('/')[1])
      await this.sync(root)
    })
    ipc.handle('forge:connect', async (_e, folder, repository, publish) => {
      this.rootOf(folder)
      const url = githubRemote(repository)
      const name = basename(new URL(url).pathname, '.git')
      if (publish === true) {
        if (new URL(url).pathname.split('/')[1] !== this.deps.session.getAccount()?.login) throw new Error('Publish under the signed-in account.')
        await this.deps.publish(name)
      }
      return this.checkout(url, true)
    })
    ipc.handle('forge:convert', (_e, world, source) => this.convert(this.rootOf(world), this.rootOf(source)))
    ipc.handle('forge:restore', async (_e, memberFolder, mode) => {
      if (mode !== 'db' && mode !== 'repo') throw new Error('Choose SQLite only or self-contained repo.')
      const member = this.rootOf(memberFolder)
      const root = this.deps.registry.list().find(f => f.path === member)?.forgeParent
      if (!root) throw new Error('Select a Forge World project.')
      const picked = await this.deps.pickDirectory()
      if (!picked) return null
      const source = realpathSync.native(picked)
      return this.restore(root, member, source, mode)
    })
    ipc.handle('forge:pickConvert', async (_e, world) => {
      const root = this.rootOf(world)
      this.worldAt(root)
      const picked = await this.deps.pickDirectory()
      if (picked) await this.convert(root, this.deps.registry.track(picked).folder.path)
    })
    ipc.handle('forge:add', (_e, folder, repository, name) => this.add(this.rootOf(folder), repository, name))
    ipc.handle('forge:interval', (_e, folder, minutes) => { const root = this.rootOf(folder); updateForge(root, world => { world.syncMinutes = minutes }); this.next.set(root, Date.now() + minutes * 60_000) })
    ipc.handle('forge:sync', (_e, folder) => this.sync(this.rootOf(folder)))
    ipc.handle('forge:status', (_e, folder) => { const root = this.rootOf(folder); return { last: this.last.get(root) ?? null, error: this.errors.get(root) ?? null } })
  }
  tick() {
    for (const root of this.resolving) {
      if (!this.active.has(root)) void this.git.run(root, ['ls-files', '-u']).then(result => {
        if (!result.stdout) return this.sync(root)
      }).catch(() => undefined)
    }
    for (const folder of this.deps.registry.list()) {
      if ((!folder.forgeWorld && !folder.forgeIssue) || Date.now() < (this.next.get(folder.path) ?? 0)) continue
      this.next.set(folder.path, Date.now() + (folder.forgeWorld?.syncMinutes ?? 5) * 60_000)
      void this.sync(folder.path).catch(() => undefined)
    }
  }
  async existingCheckout(url: string) {
    for (const candidate of this.deps.registry.list().filter(f => f.forgeWorld && f.available)) {
      const remote = await this.git.run(candidate.path, ['remote', 'get-url', 'origin'], undefined, { acceptExitCodes: [0, 2, 128] })
      if (remote.code === 0 && githubRemote(remote.stdout.trim()).toLowerCase() === url.toLowerCase()) {
        return candidate.path
      }
    }
    return null
  }

  async openUnlinked(source: string) {
    if (existsSync(join(source, FORGE_FILE))) {
      this.worldAt(source)
      this.deps.registry.track(source)
      await this.sync(source)
      return source
    }
    if (!existsSync(join(source, '.git'))) return source
    const worlds = this.deps.registry.list().filter(f => f.forgeWorld)
    if (!worlds.length) return source
    const origin = await this.git.run(source, ['remote', 'get-url', 'origin'], undefined, { acceptExitCodes: [0, 2, 128] })
    let url: string
    try { url = githubRemote(origin.stdout.trim()).toLowerCase() } catch { return source }
    for (const world of worlds) {
      const linked = world.forgeWorld?.projects.find(project => project.repository.toLowerCase() === url)
      if (linked) { await this.sync(world.path); return join(world.path, linked.folder) }
    }
    return source
  }
  async checkSource({ root, member, source, folder, repository }: ForgeMove) {
    if (existsSync(join(source, POINTER)) || existsSync(member) || this.worldAt(root).projects.some(p => p.folder.toLowerCase() === folder.toLowerCase() || p.repository.toLowerCase() === repository.toLowerCase())) throw new Error('This Forge World project or pointer already exists.')
    const original = this.deps.pool.get(source)
    if (!original.isInitialized()) return
    const ctx = original.ctx()
    assertStorageIdle({ db: ctx.db, clock: ctx.clock, sessionId: ctx.session.id })
    const flushed = await original.flushPortableState()
    if (flushed.failed) throw new Error('Flush pending ticket records before converting.')
    await this.validateSource(source)
  }
  async validateSource(source: string) {
    const original = this.deps.pool.get(source)
    ensureReconciled(await original.reconcileRepository())
    if ((await original.getStorageStatus()).storage.mode === 'repo' && (await this.git.run(source, ['status', '--porcelain', '--', '.darkmechanicus'])).stdout.trim()) throw new Error('Commit the current Dark Mechanicus records before converting.')
  }
  async exportSource({ root, member, source, folder, repository }: ForgeMove) {
    if (!existsSync(member)) mkdirSync(member)
    if (realpathSync.native(member) !== member) throw new Error('The ticket folder moved during conversion.')
    const original = this.deps.pool.get(source)
    if (!existsSync(join(member, '.darkmechanicus/project.json'))) {
      if (original.isInitialized()) original.exportForge!(member)
      else await this.deps.pool.get(member).initializeRepository({ name: folder, mode: 'repo' })
    }
    if (!this.worldAt(root).projects.some(p => p.folder === folder && p.repository === repository)) updateForge(root, w => w.projects.push({ folder, repository }))
  }
  async retireSource(source: string, member: string) {
    const original = this.deps.pool.get(source)
    if (original.isInitialized() && (await original.getStorageStatus()).storage.mode === 'repo') {
      const result = await original.switchStorageMode({ mode: 'db', confirmed: true })
      if (result.cleanupPending) throw new Error('Reopen the source to finish the storage cleanup.')
    }
    this.deps.pool.close(source)
    if (existsSync(join(source, SQLITE_STANDARDS_FILE))) {
      const exported = readProject(resolveLayout(member), nodeFs)
      retireSqlitePolicy({ layout: resolveLayout(source), fs: nodeFs }, exported?.deliveryStandards)
    }
    const retained = dbProjectDir(source, this.deps.home)
    if (existsSync(retained)) renameSync(retained, retained + '.pre-forge-' + randomUUID())
  }
  async archiveStore(root: string, member: string) {
    this.deps.pool.close(member)
    const metadata = (await this.git.run(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
    const archive = join(metadata, 'forge-archive', basename(member) + '-' + randomUUID())
    mkdirSync(dirname(archive), { recursive: true })
    if (existsSync(join(member, '.darkmechanicus'))) renameSync(join(member, '.darkmechanicus'), archive)
    if (existsSync(member) && readdirSync(member).length === 0) rmdirSync(member)
    updateForge(root, w => { w.projects = w.projects.filter(p => p.folder !== basename(member)) })
  }
}

export function startForge(ipc: Pick<IpcMain, 'handle'>, deps: Services) {
  const service = new ForgeService(deps)
  service.register(ipc)
  const timer = setInterval(() => service.tick(), 15_000)
  timer.unref()
  return { openProject: (source: string) => service.openProject(source), stop: () => clearInterval(timer) }
}
