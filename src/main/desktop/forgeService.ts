import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { IpcMain } from 'electron'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ForgeMemberStatus } from '../../shared/desktop/forgeWorld'
import type { GitRunner } from '../git/runner'
import type { CredentialSession } from '../git/credentials'
import { DomainError } from '../../core/errors'
import { assertForgeTransferIdle, assertForgeWorldSyncAllowed, bindForge, boundForgeRoot, FORGE_POINTER, pendingForgeForce, pendingForgeTransfer, withForgeTransfer } from '../../core/repo/forgeBinding'
import { forgeCodeCheckout } from '../../core/repo/forgeCheckout'
import { retireSqlitePolicy } from '../../core/repo/deliveryPolicy'
import { readForgeRecipebook, readForgeSetupWorkflow, refreshForgeSetupWorkflow, writeForgeRecipebook } from '../../core/repo/forgeSetupStorage'
import { gitCheckoutStamp } from '../../core/repo/git'
import { readProject } from '../../core/repo/initialize'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { dbProjectDir, SQLITE_STANDARDS_FILE } from '../../core/repo/storageMode'
import { ensureForgeConfig, FORGE_CONFIG, readForgeReference } from '../../core/repo/forgeReference'
import { requireTracked } from './handlers'
import { readForgeCheckout } from './forgeCheckout'
import { FORGE_FILE, createForge, githubRemote, parseForge, projectName, updateForge } from './forgeManifest'
import { ForgeGit, type WorldCheckout } from './forgeGit'
import { createForgeProvisioning, type ForgeProvisioning } from './forgeProvisioning'
import { bundledRecipebookFile, createForgeProvisioningWork } from './forgeProvisioningWork'
import { bundledForgeRecipes, verifyForgeScaffold } from './forgeScaffold'
import { createForgeSetupOnboarding, type ForgeSetupMember, type ForgeSetupOnboardingOptions } from './forgeSetupOnboarding'
import { ensureForgeWorld } from './forgeHealth'
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
  onConflict(root: string, assertCurrent: () => void): Promise<void>
  onSynced(root: string): Promise<void>
  onFoldersChanged?(): void
  provisioning?: Pick<Parameters<typeof createForgeProvisioningWork>[0], 'publisher' | 'discover'> & { journal: string }
  onImported?(member: string, agent?: string): Promise<void>
  setup?: Omit<ForgeSetupOnboardingOptions, 'resolveMember' | 'discover' | 'resolveCheckout' | 'mutate' | 'sync'>
}
interface MemberIdentity { key: string; identity: string }
interface MemberPreparation { key: string | undefined; promise: Promise<void> }
interface ForgeMove { root: string; member: string; source: string; folder: string; repository: string }
function ensureReconciled(result: import('../../shared/domain/views').ReconcileResultView): void {
  if (result.rejected.length || result.conflicts.length || result.profileConflicts.length || result.kanbanConflicts.length) throw new Error('Ticket records need reconciliation.')
}

function localForgeBinding(home: string, source: string): string | undefined {
  try {
    const member = boundForgeRoot(nodeFs, home, source)
    return member === source ? undefined : member
  }
  catch (error: unknown) {
    if ((error instanceof DomainError && error.code === 'conflict') || error instanceof SyntaxError) return undefined
    throw error
  }
}

class ForgeService {
  private readonly git: ForgeGit
  private readonly setup?: ReturnType<typeof createForgeSetupOnboarding>
  private provisioning?: ForgeProvisioning
  private stopped = false
  private readonly resolving = new Set<string>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly prepared = new Map<string, MemberIdentity>()
  private readonly preparing = new Map<string, MemberPreparation>()
  private readonly preparationErrors = new Map<string, MemberIdentity & { message: string }>()
  private readonly rootKeys = new Map<string, string>()
  private readonly validated = new Map<string, string>()
  private readonly notified = new Map<string, string>()
  private readonly polling = new Set<string>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly transferring = new Set<string>()
  private readonly provisioningWorlds = new Set<string>()
  private readonly relatedMutations = new Map<string, number>()
  private readonly last = new Map<string, number>()
  private readonly next = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly checking = new Map<string, Promise<WorldCheckout>>()

  constructor(private readonly deps: Services) {
    this.git = new ForgeGit(deps.session, deps.runner)
    if (deps.setup !== undefined && deps.provisioning !== undefined) {
      this.setup = createForgeSetupOnboarding({
        ...deps.setup, resolveMember: input => this.setupMember(input), discover: deps.provisioning.discover,
        resolveCheckout: target => forgeCodeCheckout(target.member, deps.home, undefined),
        mutate: (root, work) => this.withProvisioningWorld(root, work),
        sync: root => { void this.sync(root, true).catch(() => undefined) }
      })
    }
  }
  private setupMember(input: unknown): ForgeSetupMember {
    const member = this.rootOf(input)
    const tracked = this.deps.registry.list().find(folder => folder.path === member)
    const root = tracked?.forgeParent
    const identity = tracked?.projectIdentity
    if (!root || !identity || tracked.storageMode !== 'repo') throw new Error('Open a tracked and initialized Forge World project.')
    const key = this.rootKey(root)
    const repository = this.memberRepository(root, member)
    const assertCurrent = () => {
      this.assertSyncTarget(root, key)
      assertForgeTransferIdle(nodeFs, this.deps.home, member)
      if (this.identityOf(root, member) !== identity || this.memberRepository(root, member) !== repository) {
        throw new Error('The Forge World member or its code mapping changed.')
      }
    }
    assertCurrent()
    return { member, root, repository, identity, assertCurrent }
  }
  private memberRepository(root: string, member: string): string {
    const project = this.worldAt(root).projects.find(record => record.folder === basename(member))
    if (project === undefined) throw new Error('The Forge World no longer maps this ticket project.')
    return project.repository
  }
  /** The full Forge World check; `checked` is what the running sync has just established, reused instead of asking git again. */
  ensure(root: string, checked?: WorldCheckout): Promise<WorldCheckout> {
    try { assertForgeWorldSyncAllowed(nodeFs, this.deps.home, root) }
    catch (error) { return Promise.reject(error) }
    const pending = this.checking.get(root)
    if (pending) return pending
    const key = this.rootKey(root)
    const work = this.git.ensureMain(root).then(() => ensureForgeWorld(root, { git: this.git, home: this.deps.home, checked })).then(checkout => {
      if (key !== undefined && this.rootKey(root) === key) {
        this.validated.set(root, key)
        this.notifyMembers(root)
      }
      return checkout
    }).finally(() => this.checking.delete(root))
    this.checking.set(root, work)
    return work
  }
  async checkTracked(): Promise<void> {
    for (const folder of this.deps.registry.list().filter(entry => entry.forgeWorld || entry.forgeIssue)) {
      try { await this.ensure(folder.path); this.errors.delete(folder.path) }
      catch (error) { this.errors.set(folder.path, error instanceof Error ? error.message : String(error)) }
    }
  }
  async openWorld(folder: string): Promise<string> {
    const root = realpathSync.native(folder)
    await this.ensure(root)
    return root
  }
  rootOf(input: unknown) {
    const root = requireTracked(this.deps.registry, input)
    if (realpathSync.native(root) !== root) throw new DomainError('conflict', 'The tracked folder moved.')
    return root
  }
  worldAt(root: string) {
    const file = join(root, FORGE_FILE)
    if (lstatSync(file).isSymbolicLink()) throw new Error('Invalid Forge World manifest.')
    return parseForge(readFileSync(file, 'utf8'))
  }
  private assertNotProvisioning(root: string): void {
    if (this.provisioningWorlds.has(root)) throw new Error('Wait for the current Forge World creation step.')
  }
  async withProvisioningWorld<T>(root: string, change: () => Promise<T>): Promise<T> {
    this.assertNotProvisioning(root)
    if (this.stopped || this.relatedMutations.has(root) || this.transferring.has(root)) {
      throw new Error('Wait for the current Forge World operation before continuing.')
    }
    this.provisioningWorlds.add(root)
    const key = this.rootKey(root)
    try {
      await Promise.allSettled([this.active.get(root), this.pending.get(root), this.checking.get(root)])
      this.assertSyncTarget(root, key)
      return await change()
    } finally { this.provisioningWorlds.delete(root) }
  }
  private async relatedMutation<T>(root: string, change: () => Promise<T>): Promise<T> {
    this.assertNotProvisioning(root)
    this.provisioning?.assertWorldPublished(root)
    this.relatedMutations.set(root, (this.relatedMutations.get(root) ?? 0) + 1)
    try { return await change() }
    finally {
      const remaining = this.relatedMutations.get(root)! - 1
      if (remaining === 0) this.relatedMutations.delete(root)
      else this.relatedMutations.set(root, remaining)
    }
  }
  private assertSyncAdmission(root: string, transfer: boolean, guarded: boolean): void {
    if (this.stopped) throw new Error('Forge sync is stopping.')
    assertForgeWorldSyncAllowed(nodeFs, this.deps.home, root)
    if (!guarded) {
      this.assertNotProvisioning(root)
      this.provisioning?.assertWorldPublished(root)
    }
    if (this.transferring.has(root) && !transfer) throw new Error('Resume the pending Forge World conversion before syncing.')
  }
  sync(root: string, afterMutation = false, transfer = false, provisionCurrent?: () => void): Promise<void> {
    try { this.assertSyncAdmission(root, transfer, provisionCurrent !== undefined) }
    catch (error) { return Promise.reject(error) }
    const pending = this.active.get(root)
    if (pending) {
      if (!afterMutation) return pending
      const existing = this.pending.get(root)
      if (existing) return existing
      const follow = pending.then(() => this.sync(root, true, transfer, provisionCurrent)).finally(() => this.pending.delete(root))
      this.pending.set(root, follow)
      return follow
    }
    const attachmentKey = this.rootKey(root, 'repair')
    const work = this.syncWorld(root, attachmentKey, provisionCurrent).finally(() => {
      this.active.delete(root)
      if (attachmentKey !== undefined && this.rootKey(root, 'repair') === attachmentKey) {
        const minutes = this.deps.registry.list().find(folder => folder.path === root)?.forgeWorld?.syncMinutes ?? 5
        this.next.set(root, Date.now() + minutes * 60_000)
      }
    })
    this.active.set(root, work)
    return work
  }
  private async syncWorld(root: string, attachmentKey: string | undefined, current?: () => void): Promise<void> {
    let pendingMerge = false
    try {
      this.assertSyncTarget(root, attachmentKey, 'repair')
      pendingMerge = await this.hasPendingMerge(root)
      if (pendingMerge) throw new Error('Finish the Forge World merge commit before syncing.')
      const checked = await this.ensure(root)
      this.assertSyncTarget(root, attachmentKey)
      await this.git.sync(root, async merged => {
        this.assertSyncTarget(root, attachmentKey)
        await this.ensure(root, merged)
        for (const project of this.worldAt(root).projects) {
          const member = join(root, project.folder)
          if (this.deps.registry.resolve(member) && existsSync(join(member, '.darkmechanicus/project.json'))) {
            await this.pendingMember(member, attachmentKey)?.promise.catch(() => undefined)
            this.assertSyncTarget(root, attachmentKey)
            await this.prepareMember(root, member, attachmentKey)
          }
        }
      }, () => { this.assertSyncTarget(root, attachmentKey); current?.() }, checked)
      this.assertSyncTarget(root, attachmentKey)
      await this.deps.onSynced(root)
      this.assertSyncTarget(root, attachmentKey)
      this.notifyMembers(root)
      this.resolving.delete(root)
      this.errors.delete(root)
      this.last.set(root, Date.now())
    } catch (error) {
      if (this.stopped || attachmentKey === undefined || this.rootKey(root, 'repair') !== attachmentKey) throw error
      this.errors.set(root, error instanceof Error ? error.message : String(error))
      if (pendingMerge || await this.hasPendingMerge(root)) {
        this.assertSyncTarget(root, attachmentKey, 'repair')
        this.resolving.add(root)
        await this.startResolver(root, attachmentKey)
      }
      throw error
    }
  }

  private rootKey(root: string, mode?: 'repair'): string | undefined {
    const folder = this.deps.registry.list().find(entry => entry.path === root)
    // Keep the attachment while a cold manifest conflict looks unavailable, but admit it only for repair.
    const key = folder?.available || folder?.forgeIssue ? folder.attachmentKey : undefined
    if (key !== this.rootKeys.get(root)) {
      this.forgetRoot(root)
      if (key !== undefined) this.rootKeys.set(root, key)
    }
    return folder?.available || mode === 'repair' ? key : undefined
  }

  private assertSyncTarget(root: string, key: string | undefined, mode?: 'repair'): void {
    if (this.stopped || key === undefined || this.rootKey(root, mode) !== key) throw new Error('The Forge World was untracked while it was syncing.')
  }

  private notifyMembers(root: string): void {
    const members = this.deps.registry.list().filter(folder => folder.forgeParent === root)
    const fingerprint = JSON.stringify([this.validated.has(root), members.map(folder => [folder.path, folder.projectIdentity, this.prepared.get(folder.path)?.identity, folder.available])])
    if (this.notified.get(root) !== fingerprint) {
      this.notified.set(root, fingerprint)
      this.deps.onFoldersChanged?.()
    }
  }

  private async hasPendingMerge(root: string): Promise<boolean> {
    return (await this.git.run(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], undefined, { acceptExitCodes: [0, 1] })).code === 0
  }

  private async startResolver(root: string, key: string | undefined): Promise<void> {
    const assertCurrent = () => {
      this.assertSyncTarget(root, key, 'repair')
      assertForgeWorldSyncAllowed(nodeFs, this.deps.home, root)
    }
    assertCurrent()
    const gitRoot = (await this.git.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (realpathSync.native(gitRoot) !== root) throw new Error('The Forge World must be the root of its ticket repository.')
    // Inspect the checked-out tree, merge parent and every index stage before trusting HEAD for grant scope.
    await Promise.all([this.git.inspectCheckout(root), this.git.inspectTree(root, 'MERGE_HEAD')])
    const head = parseForge((await this.git.run(root, ['show', 'HEAD:' + FORGE_FILE])).stdout)
    assertCurrent()
    this.deps.registry.cacheForge?.(root, head)
    try { await this.deps.onConflict(root, assertCurrent) }
    catch (error) {
      if (!this.stopped && this.rootKey(root, 'repair') === key) this.errors.set(root, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async pollResolution(root: string, key: string | undefined): Promise<void> {
    this.polling.add(root)
    try {
      if (await this.hasPendingMerge(root)) await this.startResolver(root, key)
      else {
        this.assertSyncTarget(root, key, 'repair')
        await this.sync(root)
      }
    } catch (error) {
      if (!this.stopped && this.rootKey(root, 'repair') === key) this.errors.set(root, error instanceof Error ? error.message : String(error))
    } finally { this.polling.delete(root) }
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
      await this.convert(dirname(pending), source, pendingForgeForce(this.deps.home, source))
      return pending
    }
    const reference = readForgeReference(nodeFs, source)
    if (!reference) return this.openUnlinked(source)
    const bound = this.deps.registry.list().filter(f => f.forgeWorld)
    for (const candidate of bound) {
      const member = join(candidate.path, reference.projectFolder)
      const target = pendingForgeTransfer(this.deps.home, member)
      if (target === source + '/repo' || target === source + '/db') {
        return this.restore(candidate.path, member, source, target.endsWith('/db') ? 'db' : 'repo')
      }
    }
    const local = await this.openBoundProject(source, reference)
    if (local !== undefined) return local
    const root = await this.checkout(reference.worldRepository, false)
    const project = this.worldAt(root).projects.find(p => p.folder === reference.projectFolder)
    if (!project) throw new Error('The Forge World does not contain this project.')
    return this.linkProject(source, root, project)
  }
  /** A verified local link can be opened offline. Only a missing or different link needs retrieval. */
  private async openBoundProject(source: string, reference: NonNullable<ReturnType<typeof readForgeReference>>): Promise<string | undefined> {
    const { home } = this.deps
    const member = localForgeBinding(home, source)
    if (member === undefined || basename(member) !== reference.projectFolder) return undefined
    const root = dirname(member)
    if (this.rootKey(root) === undefined || this.identityOf(root, member) === undefined || readForgeCheckout(member) !== source) return undefined
    const project = this.worldAt(root).projects.find(item => item.folder === reference.projectFolder)
    if (project === undefined) return undefined
    const association = this.localLinkVersion(source, member)
    const origin = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    if (origin.toLowerCase() !== reference.worldRepository.toLowerCase()) return undefined
    const codeOrigin = githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim())
    if (codeOrigin.toLowerCase() !== project.repository.toLowerCase()) throw new Error('Choose the linked code repository; its origin does not match this Forge World project.')
    await this.ensure(root)
    // Local health checks the manifest, Git index and linked source origin. Fence the chosen
    // association again after those asynchronous checks before returning it to the picker.
    if (this.localLinkVersion(source, member) !== association) {
      throw new DomainError('conflict', 'The Forge World project or its linked checkout changed while opening.')
    }
    return member
  }
  private localLinkVersion(source: string, member: string): string {
    const { home } = this.deps
    const root = dirname(member)
    assertForgeTransferIdle(nodeFs, home, source)
    assertForgeTransferIdle(nodeFs, home, member)
    return JSON.stringify([
      this.rootKey(root), this.identityOf(root, member),
      this.worldAt(root).projects.find(item => item.folder === basename(member)),
      readForgeReference(nodeFs, source), localForgeBinding(home, source), readForgeCheckout(member),
      gitCheckoutStamp(root, false), gitCheckoutStamp(source, false)
    ])
  }
  async linkProject(source: string, root: string, project: { folder: string; repository: string }): Promise<string> {
    const origin = githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim())
    if (origin.toLowerCase() !== project.repository.toLowerCase()) throw new Error('Choose the linked code repository; its origin does not match this Forge World project.')
    const member = join(root, project.folder)
    if (this.deps.registry.resolve(member) !== member || !existsSync(join(member, '.darkmechanicus/project.json'))) throw new Error('The Forge World project has no available ticket folder.')
    const worldRepository = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    ensureForgeConfig(source, { version: 1, worldRepository, projectFolder: project.folder })
    const note = join(source, POINTER)
    bindForge(this.deps.home, source, member, existsSync(note) ? readFileSync(note, 'utf8') : '')
    return member
  }
  async add(root: string, repository: string, name: string) {
    const member = await this.relatedMutation(root, () => this.addProject(root, repository, name))
    await this.imported(member)
    await this.sync(root, true)
  }
  private async addProject(root: string, repository: string, name: string) {
    const world = this.worldAt(root)
    const folder = projectName(name)
    const url = githubRemote(repository)
    const member = join(root, folder)
    if (world.projects.some(p => p.folder.toLowerCase() === folder.toLowerCase() || p.repository.toLowerCase() === url.toLowerCase())) throw new Error('This repository or folder is already tracked.')
    if (!existsSync(member)) mkdirSync(member)
    else throw new Error('The project folder already exists in this Forge World.')
    await this.deps.pool.get(member).initializeRepository({ name: folder, mode: 'repo' })
    updateForge(root, w => w.projects.push({ folder, repository: url }))
    return member
  }
  async convert(root: string, source: string, force = false) {
    await this.relatedMutation(root, () => this.convertProject(root, source, force))
    await this.imported(join(root, projectName(basename(source))))
  }
  private async imported(member: string, agent?: string): Promise<void> {
    await this.setup?.imported(member, agent)
    await this.deps.onImported?.(member, agent)
  }
  private async convertProject(root: string, source: string, force: boolean) {
    this.worldAt(root)
    if (root === source || this.deps.registry.list().some(f => f.path === source && (f.forgeWorld || f.forgeParent))) throw new Error('Select a source code project.')
    const folder = projectName(basename(source))
    const repository = githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim())
    const remote = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    const member = join(root, folder)
    if (force && this.transferring.has(root)) throw new Error('This Forge World conversion is already running.')
    if (force) this.transferring.add(root)
    try {
    if (force) await this.active.get(root)
    await withForgeTransfer(this.deps.home, source, { target: member, force }, async (phase, advance) => {
      const note = join(source, POINTER)
      const body = [
        '# Ticket source control', '', 'Forge World: ' + remote, 'Project folder: ' + folder, '',
        'Clone or pull the Forge World above, then open the named folder for tickets.',
        'The root forge-world.json contains all linked project folders and their repository URLs.', ''
      ].join('\n')
      const move = { root, member, source, folder, repository }
      if (force) await this.forceMove(move, phase, advance)
      else {
        if (phase === 0) { await this.checkSource(move); advance(1) }
        if (phase < 2) { await this.exportSource(move); advance(2) }
        if (phase < 3) { await this.sync(root, true); advance(3) }
        if (phase < 4) { await this.retireSource(source, member); advance(4) }
      }
      this.deps.cleanup(source)
      if (!existsSync(note)) writeFileSync(note, body, { flag: 'wx' })
      if (readFileSync(note, 'utf8') !== body) throw new Error('The source pointer changed during conversion.')
      ensureForgeConfig(source, { version: 1, worldRepository: remote, projectFolder: folder })
      bindForge(this.deps.home, source, member, body)
      this.deps.registry.untrack(source)
    })
    } finally { if (force) this.transferring.delete(root) }
  }

  async forceMove(move: ForgeMove, phase: number, advance: (n: number) => void) {
    assertForgeWorldSyncAllowed(nodeFs, this.deps.home, move.root)
    let freshExport = false
    let publicationStarted = phase >= 2
    try {
      if (phase === 0) {
        await this.checkSource(move, true)
        advance(1)
        try { mkdirSync(move.member) }
        catch (error) { advance(0); throw error }
        freshExport = true
      }
      if (phase < 2) await this.resumeForceExport(move, () => { freshExport = false })
      if (phase < 3) {
        // Sync can commit before it reaches the network. Once begun, keep both stores fenced
        // until reconciliation succeeds; rolling back only the worktree would leave publishable history.
        advance(2)
        publicationStarted = true
        await this.sync(move.root, true, true)
        advance(3)
      }
      if (phase < 4) { await this.retireForcedSource(move); advance(4) }
    } catch (error) {
      if (freshExport) {
        await this.rollbackForceExport(move)
        advance(0)
      }
      if (publicationStarted) throw new Error(`${error instanceof Error ? error.message : String(error)} Conversion remains pending; resume Force migrate to reconcile both stores safely.`)
      throw error
    }
  }

  async resumeForceExport(move: ForgeMove, beforeVerify: () => void) {
    if (!existsSync(move.member)) mkdirSync(move.member)
    if (realpathSync.native(move.member) !== move.member) throw new Error('The reserved export folder moved; the source was kept.')
    if (readdirSync(move.member).some(name => name !== '.darkmechanicus' && name !== '.darkmechanicus.preparing')) throw new Error('The reserved folder contains unrelated files; they were kept for inspection.')
    const preparing = join(move.member, '.darkmechanicus.preparing')
    if (existsSync(preparing)) {
      if (realpathSync.native(move.member) !== move.member || realpathSync.native(preparing) !== preparing) throw new Error('The reserved export folder moved; the source was kept.')
      const original = this.deps.pool.get(move.source)
      await original.call('verifyForge', move.member, true)
      rmSync(preparing, { recursive: true })
    }
    await this.exportSource(move, true, beforeVerify)
  }

  async rollbackForceExport(move: ForgeMove) {
    await this.deps.pool.close(move.member)
    // The durable reservation follows an exclusive mkdir of a previously vacant member.
    if (existsSync(move.member)) {
      if (realpathSync.native(move.member) !== move.member || dirname(move.member) !== move.root) throw new Error('The reserved export folder moved; the source was kept.')
      rmSync(move.member, { recursive: true })
    }
    updateForge(move.root, world => { world.projects = world.projects.filter(project => project.folder !== move.folder || project.repository !== move.repository) })
  }

  async retireForcedSource({ source, member }: ForgeMove) {
    const original = this.deps.pool.get(source)
    const mode = await original.call('initialized') ? (await original.getStorageStatus()).storage.mode : undefined
    if (mode === 'forge') throw new Error('The source is already a Forge World member.')
    if (mode) await original.call('checkStorageIdle', true)
    await this.deps.pool.close(source)
    await this.deps.pool.get(member).call('retireForcedForge', source, member, mode)
    if (existsSync(join(source, SQLITE_STANDARDS_FILE))) {
      const exported = readProject(resolveLayout(member), nodeFs)
      retireSqlitePolicy({ layout: resolveLayout(source), fs: nodeFs }, exported?.deliveryStandards)
    }
  }
  restore(root: string, member: string, source: string, mode: 'db' | 'repo') {
    return this.relatedMutation(root, () => this.restoreProject(root, member, source, mode))
  }
  private async restoreProject(root: string, member: string, source: string, mode: 'db' | 'repo') {
    const note = join(source, POINTER)
    const remote = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
    const reference = readForgeReference(nodeFs, source)
    const linked = this.worldAt(root).projects.find(p => p.folder === basename(member))
    if (!reference && (!linked || githubRemote((await this.git.run(source, ['remote', 'get-url', 'origin'])).stdout.trim()).toLowerCase() !== linked.repository.toLowerCase())) throw new Error('Select the linked code repository.')
    if (reference && (reference.worldRepository.toLowerCase() !== remote.toLowerCase() || reference.projectFolder !== basename(member))) throw new Error('Choose the code checkout linked to this project.')
    await withForgeTransfer(this.deps.home, member, source + '/' + mode, async (phase, advance) => {
      if (phase === 0) {
        await this.deps.pool.get(member).call('checkStorageIdle', false)
        await this.sync(root)
        await this.deps.pool.get(member).flushPortableState()
        await this.deps.pool.close(source)
        await this.deps.pool.get(member).call('archiveRetiredForge', source, member)
        if (existsSync(join(source, '.darkmechanicus')) || existsSync(dbProjectDir(source, this.deps.home))) throw new Error('The destination already contains a ticket store.')
        advance(1)
      }
      if (phase < 2) {
        const dest = mode === 'repo' ? join(source, '.darkmechanicus') : dbProjectDir(source, this.deps.home)
        if (!existsSync(join(dest, 'project.json'))) await this.deps.pool.get(member).call('exportForge', source, mode)
        advance(2)
      }
      if (phase < 3) {
        await this.archiveStore(root, member)
        advance(3)
      }
      await this.sync(root, true)
      if (existsSync(note)) unlinkSync(note)
      const config = join(source, FORGE_CONFIG)
      if (existsSync(config)) unlinkSync(config)
      this.deps.registry.track(source)
    })
    return source
  }
  registerProvisioning(ipc: Pick<IpcMain, 'handle'>): ForgeProvisioning | undefined {
    const options = this.deps.provisioning
    if (options === undefined) return undefined
    const { journal, ...adapter } = options
    const { home, registry, pool, session, pickDirectory } = this.deps
    const provisioning = createForgeProvisioning(journal, createForgeProvisioningWork({
      ...adapter, home, registry, pool, session, pickDirectory, git: this.git,
      withWorld: (root, change) => this.withProvisioningWorld(root, change),
      synchronize: (root, current) => this.sync(root, true, false, current),
      onProject: (member, agent) => this.imported(member, agent)
    }))
    this.provisioning = provisioning
    ipc.handle('forgeSetup:provision', (_event, request, operationId) => provisioning.provision(request, operationId))
    ipc.handle('forgeSetup:provisioning', () => provisioning.provisioning())
    ipc.handle('forgeSetup:resumeProvision', (_event, id) => provisioning.resumeProvision(id))
    ipc.handle('forgeSetup:recipebook', (_event, folder) => {
      if (folder === undefined) return bundledRecipebookFile()
      const root = this.rootOf(folder)
      this.worldAt(root)
      return readForgeRecipebook(root)
    })
    ipc.handle('forgeSetup:saveRecipebook', (_event, folder, edit) => this.saveRecipebook(folder, edit))
    this.registerSetup(ipc)
    return provisioning
  }
  private registerSetup(ipc: Pick<IpcMain, 'handle'>): void {
    const setup = this.setup
    if (setup === undefined) return
    ipc.handle('forgeSetup:project', (_event, member) => setup.project(member))
    ipc.handle('forgeSetup:saveWorkflow', (_event, member, edit) => setup.saveWorkflow(member, edit))
    ipc.handle('forgeSetup:refresh', (_event, member) => setup.refresh(member))
    ipc.handle('forgeSetup:prepare', (_event, member, agent) => setup.prepare(member, agent))
    ipc.handle('forgeSetup:run', (_event, member, sha, checkout) => setup.run(member, sha, checkout))
  }
  assertSetupLaunch(chat: ChatRecord, authorization?: symbol): string {
    if (this.setup === undefined) throw new Error('Forge setup launch authority is unavailable.')
    return this.setup.assertLaunch(chat, authorization)
  }
  private async saveRecipebook(folder: unknown, edit: import('../../shared/desktop/forgeSetup').ForgeRecipebookEdit) {
    const root = this.rootOf(folder)
    this.worldAt(root)
    this.provisioning?.assertWorldPublished(root)
    const saved = await this.withProvisioningWorld(root, async () => {
      const key = this.rootKey(root)
      const current = () => this.assertSyncTarget(root, key)
      if (edit === null || typeof edit !== 'object' || !('expectedSha256' in edit) || !('value' in edit)) throw new Error('Supply the current Forge recipe book revision.')
      current()
      for (const recipe of edit.value?.recipes ?? []) if (recipe.kind !== 'world') verifyForgeScaffold(recipe)
      return writeForgeRecipebook(root, edit.expectedSha256, edit.value)
    })
    void this.sync(root, true).catch(() => undefined)
    return saved
  }
  register(ipc: Pick<IpcMain, 'handle'>) {
    ipc.handle('forge:create', async (_e, folder) => {
      const root = this.rootOf(folder)
      this.assertNotProvisioning(root)
      const url = githubRemote((await this.git.run(root, ['remote', 'get-url', 'origin'])).stdout.trim())
      if (resolve((await this.git.run(root, ['rev-parse', '--show-toplevel'])).stdout.trim()) !== root) throw new Error('Select a Git repository root.')
      if (await this.deps.pool.get(root).call('initialized')) throw new Error('Choose a dedicated ticket repository for the Forge World.')
      createForge(root, new URL(url).pathname.split('/')[1])
      if (this.deps.provisioning !== undefined) writeForgeRecipebook(root, null, bundledForgeRecipes())
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
    ipc.handle('forge:convert', (_e, world, source, options) => {
      if (options !== undefined && (options === null || typeof options !== 'object' || options.force !== true || Object.keys(options).some(key => key !== 'force'))) throw new Error('Choose a valid Forge migration option.')
      return this.convert(this.rootOf(world), this.rootOf(source), options?.force === true)
    })
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
    ipc.handle('forge:interval', (_e, folder, minutes) => { const root = this.rootOf(folder); this.assertNotProvisioning(root); updateForge(root, world => { world.syncMinutes = minutes }); this.next.set(root, Date.now() + minutes * 60_000) })
    ipc.handle('forge:sync', (_e, folder) => this.sync(this.rootOf(folder)))
    ipc.handle('forge:memberStatus', (_e, folder, member: unknown) => this.memberStatus(folder, member))
    ipc.handle('forge:status', (_e, folder) => { const root = this.rootOf(folder); return { last: this.last.get(root) ?? null, error: this.errors.get(root) ?? null } })
  }
  private memberStatus(folder: unknown, member: unknown): ForgeMemberStatus {
    const root = this.memberRoot(folder)
    if (root === undefined) return { readiness: 'removed', syncing: false, error: null }
    const tracked = this.deps.registry.list().find(entry => entry.path === member && entry.forgeParent === root)
    if (!tracked) return { readiness: 'removed', syncing: false, error: this.errorFor(root) }
    const manifest = lstatSync(join(root, FORGE_FILE), { throwIfNoEntry: false })
    const key = this.rootKey(root)
    const trusted = key !== undefined && this.validated.get(root) === key && manifest?.isFile() === true
    if (!trusted) this.checkReadiness(root)
    const ready = trusted && this.memberPrepared(root, key, tracked)
    return { readiness: ready ? 'ready' : 'preparing',
      syncing: this.isSyncing(root) || this.pendingMember(tracked.path, key) !== undefined,
      error: this.memberError(root, key, tracked.path, tracked.projectIdentity) }
  }

  private memberRoot(folder: unknown): string | undefined {
    try { return this.rootOf(folder) }
    catch (error) {
      if (error instanceof DomainError && (error.code === 'unauthorized' || error.code === 'conflict')) return undefined
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private pendingMember(path: string, key: string | undefined): MemberPreparation | undefined {
    const pending = this.preparing.get(path)
    return pending?.key === key ? pending : undefined
  }

  private memberError(root: string, key: string | undefined, path: string, identity: string | undefined): string | null {
    const local = this.preparationErrors.get(path)
    return local?.key === key && local?.identity === identity && local !== undefined ? local.message : this.errorFor(root)
  }

  private memberPrepared(root: string, key: string, member: { path: string; available: boolean; projectIdentity?: string }): boolean {
    const identity = member.projectIdentity
    if (!member.available || identity === undefined) return false
    if (this.matches(this.prepared.get(member.path), key, identity)) return true
    if (!this.pendingMember(member.path, key) && !this.matches(this.preparationErrors.get(member.path), key, identity)) {
      void this.prepareMember(root, member.path, key).catch(() => undefined)
    }
    return false
  }

  private matches(member: MemberIdentity | undefined, key: string, identity: string): boolean {
    return member?.key === key && member.identity === identity
  }

  private prepareMember(root: string, path: string, key: string | undefined): Promise<void> {
    const existing = this.pendingMember(path, key)
    if (existing) return existing.promise
    const identity = this.identityOf(root, path)
    const current = (): MemberIdentity | undefined =>
      key !== undefined && identity !== undefined && this.rootKey(root) === key && this.identityOf(root, path) === identity
        ? { key, identity } : undefined
    const work = this.deps.pool.reconcile(path).then(({ result, hasLocalCache }) => {
      this.assertSyncTarget(root, key)
      const ready = current()
      if (hasLocalCache && ready !== undefined) this.prepared.set(path, ready)
      ensureReconciled(result)
      if (ready !== undefined) {
        this.prepared.set(path, ready)
        this.preparationErrors.delete(path)
        this.notifyMembers(root)
      }
    }).catch((error: unknown) => {
      const failed = current()
      if (failed !== undefined) this.preparationErrors.set(path, { ...failed, message: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => {
      if (this.preparing.get(path)?.promise === work) this.preparing.delete(path)
    })
    this.preparing.set(path, { key, promise: work })
    return work
  }

  private identityOf(root: string, path: string): string | undefined {
    return this.deps.registry.list().find(folder => folder.path === path && folder.forgeParent === root)?.projectIdentity
  }

  private isSyncing(root: string): boolean { return this.checking.has(root) || this.active.has(root) || this.pending.has(root) }
  private errorFor(root: string): string | null { return this.errors.get(root) ?? null }

  private checkReadiness(root: string): void {
    if (this.checking.has(root) || this.errors.has(root)) return
    void this.ensure(root).catch((error: unknown) => { this.errors.set(root, String(error)) })
  }

  pollResolvers() {
    for (const root of this.resolving) {
      const key = this.rootKey(root, 'repair')
      if (key !== undefined && this.resolving.has(root) && !this.active.has(root) && !this.polling.has(root)) void this.pollResolution(root, key)
    }
  }
  private forgetRoot(root: string): void {
    this.rootKeys.delete(root)
    this.next.delete(root)
    this.last.delete(root)
    this.errors.delete(root)
    this.notified.delete(root)
    this.validated.delete(root)
    this.resolving.delete(root)
  }

  private forgetRemovedMembers(): void {
    for (const path of this.prepared.keys()) if (!this.deps.registry.has(path)) this.prepared.delete(path)
    for (const path of this.preparationErrors.keys()) if (!this.deps.registry.has(path)) this.preparationErrors.delete(path)
  }

  stop(): void { this.stopped = true }

  tick() {
    this.pollResolvers()
    const tracked = this.deps.registry.list().filter(folder => folder.forgeWorld || folder.forgeIssue || this.resolving.has(folder.path))
    const roots = new Set(tracked.map(folder => folder.path))
    this.forgetRemovedMembers()
    for (const seen of this.rootKeys.keys()) {
      if (roots.has(seen)) continue
      this.forgetRoot(seen)
    }
    for (const folder of tracked) {
      if (this.resolving.has(folder.path) || this.active.has(folder.path) || this.pending.has(folder.path)
        || Date.now() < (this.next.get(folder.path) ?? 0)) continue
      void this.sync(folder.path).catch(() => {
        // Back off an admission refusal without overwriting the active sync's schedule or a new attachment.
        if (this.rootKey(folder.path, 'repair') === folder.attachmentKey && Date.now() >= (this.next.get(folder.path) ?? 0)) {
          this.next.set(folder.path, Date.now() + (folder.forgeWorld?.syncMinutes ?? 5) * 60_000)
        }
      })
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
      await this.ensure(source)
      void this.sync(source).catch(() => undefined)
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
      if (linked) { await this.sync(world.path); return this.linkProject(source, world.path, linked) }
    }
    return source
  }
  async checkSource({ root, member, source, folder, repository }: ForgeMove, force = false) {
    if (existsSync(join(source, POINTER)) || existsSync(join(source, FORGE_CONFIG)) || existsSync(member) || this.worldAt(root).projects.some(p => p.folder.toLowerCase() === folder.toLowerCase() || p.repository.toLowerCase() === repository.toLowerCase())) throw new Error('This Forge World project or pointer already exists.')
    const original = this.deps.pool.get(source)
    if (!await original.call('initialized')) {
      if (force) throw new Error('Use normal migration for an uninitialized project.')
      return
    }
    await original.call('checkStorageIdle', force)
    if (force) return
    const flushed = await original.flushPortableState()
    if (flushed.failed) throw new Error('Flush pending ticket records before converting.')
    await this.validateSource(source)
  }
  async validateSource(source: string) {
    const original = this.deps.pool.get(source)
    ensureReconciled(await original.reconcileRepository())
    if ((await original.getStorageStatus()).storage.mode === 'repo' && (await this.git.run(source, ['status', '--porcelain', '--', '.darkmechanicus'])).stdout.trim()) throw new Error('Commit the current Dark Mechanicus records before converting.')
  }
  async exportSource({ root, member, source, folder, repository }: ForgeMove, force = false, beforeVerify?: () => void) {
    if (!existsSync(member)) mkdirSync(member)
    if (realpathSync.native(member) !== member) throw new Error('The ticket folder moved during conversion.')
    const original = this.deps.pool.get(source)
    if (!existsSync(join(member, '.darkmechanicus/project.json'))) await this.initializeOrExport({ member, source, folder, repository }, force)
    if (force) {
      beforeVerify?.()
      await original.call('verifyForge', member, false)
    }
    if (!this.worldAt(root).projects.some(p => p.folder === folder && p.repository === repository)) updateForge(root, w => w.projects.push({ folder, repository }))
  }
  private async initializeOrExport({ member, source, folder, repository }: Omit<ForgeMove, 'root'>, force: boolean): Promise<void> {
    const detection = this.setup === undefined ? undefined : await this.deps.provisioning?.discover(repository)
    const original = this.deps.pool.get(source)
    const initialized = await original.call('initialized')
    if (detection !== undefined) await this.assertConversionOrigin(source, repository)
    if (initialized) {
      await original.call('exportForge', member, 'repo', force, detection === undefined ? undefined : { repository, detection })
    } else {
      await this.deps.pool.get(member).initializeRepository({ name: folder, mode: 'repo' })
      if (detection !== undefined && readForgeSetupWorkflow(member) === null) refreshForgeSetupWorkflow(member, repository, detection)
    }
  }
  private async assertConversionOrigin(source: string, repository: string): Promise<void> {
    const result = await this.git.run(source, ['remote', 'get-url', 'origin'], undefined, { acceptExitCodes: [0, 2, 128] })
    let current: string | undefined
    try { current = githubRemote(result.stdout.trim()) } catch { /* The origin is missing or no longer points to GitHub. */ }
    if (current?.toLowerCase() !== repository.toLowerCase()) {
      throw new DomainError('conflict', 'The code checkout origin changed during Forge setup discovery.')
    }
  }
  async retireSource(source: string, member: string) {
    const original = this.deps.pool.get(source)
    if (await original.call('initialized') && (await original.getStorageStatus()).storage.mode === 'repo') {
      const result = await original.switchStorageMode({ mode: 'db', confirmed: true })
      if (result.cleanupPending) throw new Error('Reopen the source to finish the storage cleanup.')
    }
    await this.deps.pool.close(source)
    if (existsSync(join(source, SQLITE_STANDARDS_FILE))) {
      const exported = readProject(resolveLayout(member), nodeFs)
      retireSqlitePolicy({ layout: resolveLayout(source), fs: nodeFs }, exported?.deliveryStandards)
    }
    const retained = dbProjectDir(source, this.deps.home)
    if (existsSync(retained)) renameSync(retained, retained + '.pre-forge-' + randomUUID())
  }
  async archiveStore(root: string, member: string) {
    await this.deps.pool.close(member)
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
  const provisioning = service.registerProvisioning(ipc)
  const ready = service.checkTracked()
  const timer = setInterval(() => service.tick(), 15_000)
  timer.unref()
  return { ready, openWorld: (folder: string) => service.openWorld(folder), openProject: (source: string) => service.openProject(source),
    assertSetupLaunch: (chat: ChatRecord, authorization?: symbol) => service.assertSetupLaunch(chat, authorization),
    stop: () => { clearInterval(timer); service.stop(); return provisioning?.stop() } }
}
