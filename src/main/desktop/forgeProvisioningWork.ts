import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertForgeTransferIdle, bindForge, boundForgeRoot, forgeBindingEpoch, FORGE_POINTER } from '../../core/repo/forgeBinding'
import { gitCheckoutStamp, gitOriginExecutionStamp, readLocalGitOrigin } from '../../core/repo/git'
import { LocalGitOriginConfigCache } from '../../core/repo/gitOriginConfig'
import { readProject } from '../../core/repo/initialize'
import { nodeFs } from '../../core/repo/nodeFs'
import { resolveLayout } from '../../core/repo/layout'
import { FORGE_CONFIG } from '../../core/repo/forgeReference'
import { encodeForgeRecipebook } from '../../core/repo/forgeSetupFormat'
import { readForgeRecipebook, readForgeSetupWorkflow, refreshForgeSetupWorkflow, writeForgeRecipebook } from '../../core/repo/forgeSetupStorage'
import type { ForgeProvisionRequest, ForgeRecipe, ForgeSetupDetection } from '../../shared/desktop/forgeSetup'
import type { ForgeWorld } from '../../shared/desktop/forgeWorld'
import type { CredentialSession } from '../git/credentials'
import type { FolderRegistry } from './folderRegistry'
import type { ForgeGit } from './forgeGit'
import { createForge, FORGE_FILE, githubRemote, parseForge, updateForge } from './forgeManifest'
import type { createForgeRepositoryPublisher, ForgeProvisionAccount, ForgePublishedRepository } from './forgePublish'
import type { ForgeProvisionIntent, ForgeProvisioningWork, ProvisionDestination } from './forgeProvisioning'
import { bundledForgeRecipes, materializeForgeScaffold, verifyForgeScaffold } from './forgeScaffold'
import { commitForgeScaffold } from './forgeScaffoldCommit'
import type { WorkspacePool } from './workspacePool'

interface ProvisioningOptions {
  home: string
  registry: FolderRegistry
  pool: Pick<WorkspacePool, 'get' | 'close'>
  git: Pick<ForgeGit, 'run'>
  session: CredentialSession
  publisher: ReturnType<typeof createForgeRepositoryPublisher>
  discover(repository: string): Promise<ForgeSetupDetection>
  pickDirectory(): Promise<string | null>
  withWorld<T>(root: string, change: () => Promise<T>): Promise<T>
  synchronize(root: string, assertCurrent: () => void): Promise<void>
  onProject?(member: string, agent?: string): Promise<void>
  /** Told the code of each busy manifest rename that is asked again (the main process logs it). */
  onManifestRetry?(code: string): void
}

type Receipt = { path: string; identity: string }
type ProjectMapping = ForgeWorld['projects'][number]
type OriginProof = { stamp: string; url: string }

function vacantMapping(projects: ProjectMapping[], candidate: ProjectMapping, owned = false): boolean {
  const { folder, repository } = candidate
  const existing = projects.filter(project => project.folder.toLowerCase() === folder.toLowerCase() ||
    project.repository.toLowerCase() === repository.toLowerCase())
  if (existing.length === 0) return true
  if (owned && existing.length === 1 && existing[0].folder === folder && existing[0].repository === repository) return false
  throw new Error('The Forge World already maps this folder or repository.')
}

function checkMapping(root: string, mapping: ProjectMapping, owned = false): boolean {
  const file = join(root, FORGE_FILE)
  if (!lstatSync(file).isFile()) throw new Error('The Forge World manifest must be an ordinary file.')
  return vacantMapping(parseForge(readFileSync(file, 'utf8')).projects, mapping, owned)
}

function dirStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== resolve(path)) {
    throw new Error('The selected folder moved or is not an ordinary directory.')
  }
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

function checkDirectory(receipt: Receipt): void {
  if (dirStamp(receipt.path) !== receipt.identity) throw new Error('The folder changed since Forge creation started.')
}

function managedChild(parent: string, child: string): string {
  dirStamp(parent)
  const path = join(parent, child)
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path)
  dirStamp(path)
  return path
}

function ensureManagedHome(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    ensureManagedHome(dirname(path))
    mkdirSync(path)
  }
  dirStamp(path)
}

function origin(path: string, cache?: LocalGitOriginConfigCache): string | null {
  const current = cache === undefined ? readLocalGitOrigin(path) : readLocalGitOrigin(path, cache)
  return current === null ? null : githubRemote(current)
}

function discoveryDirectoryStamp(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (stat?.isDirectory() !== true) return null
  try { accessSync(path, constants.X_OK) } catch { return null }
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid].join(':')
}

/** Reuse origin proof only for an ordinary checkout with entirely local discovery metadata. */
function originStamp(path: string): string | null {
  const git = join(path, '.git')
  const directory = discoveryDirectoryStamp(git)
  if (directory === null) return null
  const discovery = [path, join(git, 'objects'), join(git, 'refs')].map(discoveryDirectoryStamp)
  if (discovery.includes(null)) return null
  const head = nodeFs.fileStamp(join(git, 'HEAD'))
  if (head === null || nodeFs.fileStamp(join(git, 'config')) === null) return null
  if (['commondir', 'config.worktree'].some(name => lstatSync(join(git, name), { throwIfNoEntry: false }) !== undefined)) return null
  return JSON.stringify([gitCheckoutStamp(path, false), directory, discovery, head, gitOriginExecutionStamp()])
}

function inner(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

function recipeHash(recipe: ForgeRecipe): string {
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex')
}

function exactFile(path: string, text: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) writeFileSync(path, text, { flag: 'wx', flush: true })
  else if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(text) || readFileSync(path, 'utf8') !== text) {
    throw new Error('The interrupted creation contains a different ' + basename(path) + '.')
  }
}

type TreeKind = 'git' | 'member'

function markerDirectory(path: string, kind: TreeKind): string {
  return kind === 'git' ? join(path, '.git') : join(path, '.darkmechanicus', 'local')
}

function hasMarker(path: string, intent: ForgeProvisionIntent, kind: TreeKind): boolean {
  try {
    dirStamp(path)
    const directory = markerDirectory(path, kind)
    dirStamp(directory)
    const marker = join(directory, 'forge-provisioning')
    const stat = lstatSync(marker)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === intent.id.length + 1 &&
      readFileSync(marker, 'utf8') === intent.id + '\n'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function createMarkerDirectories(path: string, parts: string[]): void {
  const entries = readdirSync(path)
  if (parts.length === 0 && entries.length === 0) return
  const [part, ...rest] = parts
  if (part === undefined || entries.some(entry => entry !== part)) throw new Error('The Forge creation target already contains unrelated files.')
  const node = join(path, part)
  if (!lstatSync(node, { throwIfNoEntry: false })) mkdirSync(node)
  dirStamp(node)
  createMarkerDirectories(node, rest)
}

function claimDirectory(path: string, intent: ForgeProvisionIntent, kind: TreeKind): Receipt {
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path)
  const identity = dirStamp(path)
  if (hasMarker(path, intent, kind)) return { path, identity }
  createMarkerDirectories(path, kind === 'git' ? ['.git'] : ['.darkmechanicus', 'local'])
  exactFile(join(markerDirectory(path, kind), 'forge-provisioning'), intent.id + '\n')
  return { path, identity }
}

function worldUrl(intent: ForgeProvisionIntent): string {
  if (intent.destination.existingWorld) return intent.destination.existingWorld.url
  if (intent.worldRemote?.state !== 'confirmed') throw new Error('The Forge World repository is not confirmed.')
  return intent.worldRemote.value.url
}

function codeRemote(intent: ForgeProvisionIntent): ForgePublishedRepository | undefined {
  return intent.codeRemote?.state === 'confirmed' ? intent.codeRemote.value : undefined
}

function assertRemote(receipt: ForgePublishedRepository | null, url: string, id: number): ForgePublishedRepository {
  if (!receipt || receipt.id !== id || receipt.url.toLowerCase() !== url.toLowerCase()) throw new Error('The confirmed GitHub repository changed.')
  return receipt
}

const branch = 'refs/heads/main'

class ProvisioningWork implements ForgeProvisioningWork {
  private readonly originProofs = new WeakMap<ForgeProvisionIntent, Map<string, OriginProof>>()
  private readonly originConfigs = new WeakMap<ForgeProvisionIntent, LocalGitOriginConfigCache>()

  constructor(private readonly deps: ProvisioningOptions) {}

  account() { return this.deps.publisher.account() }
  currentLogin() { return this.deps.session.getAccount()?.login ?? null }
  findRemote(...args: Parameters<ForgeProvisioningWork['findRemote']>) { return this.deps.publisher.findRemote(...args) }
  createRemote(...args: Parameters<ForgeProvisioningWork['createRemote']>) { return this.deps.publisher.createRemote(...args) }

  private trackedWorld(root: string) {
    const tracked = this.deps.registry.list().find(folder => folder.path === root && folder.available && folder.forgeWorld)
    if (tracked === undefined) throw new Error('Open the existing Forge World before creating its code repository.')
    assertForgeTransferIdle(nodeFs, this.deps.home, root)
    return tracked
  }

  private selectedRecipe(root: string | undefined, id: string): ForgeRecipe {
    const book = root === undefined ? bundledForgeRecipes() : readForgeRecipebook(root)?.value ?? bundledForgeRecipes()
    const recipe = book.recipes.find(candidate => candidate.id === id)
    if (recipe === undefined) throw new Error('Choose a recipe in the Forge World recipe book.')
    return verifyForgeScaffold(recipe)
  }

  async prepare(request: ForgeProvisionRequest, account: ForgeProvisionAccount): Promise<ProvisionDestination | null> {
    const existingWorld = request.world.kind === 'existing' ? await this.prepareExistingWorld(request.world.folder, account) : undefined
    if (request.world.kind === 'new' && lstatSync(join(this.deps.home, 'forge-worlds', account.login, request.world.name), { throwIfNoEntry: false })) {
      throw new Error('That Forge World checkout folder already exists locally. Choose a different name.')
    }
    if (request.code === undefined) return { existingWorld }
    const recipe = this.selectedRecipe(existingWorld?.path, request.code.recipeId)
    const picked = await this.deps.pickDirectory()
    if (picked === null) return null
    const tickets = existingWorld?.path ?? join(this.deps.home, 'forge-worlds', account.login)
    const parent = this.checkoutParent(picked, request.code.name, tickets)
    const parentIdentity = dirStamp(parent)
    if (existingWorld !== undefined) {
      this.checkWorld(existingWorld)
      checkMapping(existingWorld.path, {
        folder: request.code.name, repository: 'https://github.com/' + account.login + '/' + request.code.name + '.git'
      })
    }
    return { parent, parentIdentity, existingWorld, recipeHash: recipeHash(recipe) }
  }

  private async prepareExistingWorld(path: string, account: ForgeProvisionAccount): Promise<NonNullable<ProvisionDestination['existingWorld']>> {
    const tracked = this.trackedWorld(path)
    const url = this.currentOrigin(path)
    const identity = dirStamp(path)
    const remote = await this.deps.publisher.inspectRemote(account, url)
    if (remote === null) throw new Error('GitHub could not confirm the selected Forge World.')
    const existingWorld = { path, identity, url, remoteId: remote.id, addedAt: tracked.addedAt }
    this.checkWorld(existingWorld)
    return existingWorld
  }

  private checkoutParent(picked: string, name: string, tickets: string): string {
    if (!isAbsolute(picked)) throw new Error('Choose a local parent folder for the new code checkout.')
    const parent = resolve(picked)
    const checkout = join(parent, name)
    if (lstatSync(checkout, { throwIfNoEntry: false })) throw new Error('The selected code checkout folder already exists. Choose a different parent folder.')
    if (inner(tickets, checkout) || inner(checkout, tickets) ||
        this.deps.registry.list().some(folder => inner(folder.path, checkout) || inner(checkout, folder.path))) {
      throw new Error('Choose a code checkout outside all tracked ticket and project folders.')
    }
    return parent
  }

  private currentOrigin(path: string, intent?: ForgeProvisionIntent): string {
    const url = this.readOrigin(path, intent)
    if (url === null) throw new Error('The checkout has no GitHub origin.')
    return url
  }

  private readOrigin(path: string, intent?: ForgeProvisionIntent): string | null {
    if (intent === undefined) return origin(path)
    const stamp = originStamp(path)
    if (stamp === null) return origin(path)
    const proved = this.originProofs.get(intent) ?? new Map<string, OriginProof>()
    const prior = proved.get(path)
    if (prior?.stamp === stamp) return prior.url
    const config = this.originConfigs.get(intent) ?? new LocalGitOriginConfigCache(githubRemote)
    this.originConfigs.set(intent, config)
    const url = origin(path, config)
    if (originStamp(path) !== stamp) throw new Error('The checkout Git metadata changed while verifying its origin.')
    if (url !== null) {
      proved.set(path, { stamp, url })
      this.originProofs.set(intent, proved)
    }
    return url
  }

  private checkWorld(world: NonNullable<ProvisionDestination['existingWorld']>, intent?: ForgeProvisionIntent): void {
    const receipt = intent?.world ?? world
    if (receipt.path !== world.path || receipt.identity !== world.identity) {
      throw new Error('The existing Forge World checkout receipt changed.')
    }
    checkDirectory(world)
    if (this.trackedWorld(world.path).addedAt !== world.addedAt || this.currentOrigin(world.path, intent).toLowerCase() !== world.url.toLowerCase()) {
      throw new Error('The selected Forge World was untracked or its origin changed.')
    }
  }

  private localFence(intent: ForgeProvisionIntent): void {
    const destination = intent.destination
    if (destination.parent !== undefined && dirStamp(destination.parent) !== destination.parentIdentity) {
      throw new Error('The selected parent folder changed during Forge creation.')
    }
    if (destination.existingWorld !== undefined) this.checkWorld(destination.existingWorld, intent)
    else if (intent.world !== undefined) {
      checkDirectory(intent.world)
      this.trackedWorld(intent.world.path)
      if (this.currentOrigin(intent.world.path, intent).toLowerCase() !== worldUrl(intent).toLowerCase()) throw new Error('The Forge World origin changed.')
    }
    if (intent.checkout !== undefined) {
      checkDirectory(intent.checkout)
      if (this.currentOrigin(intent.checkout.path, intent).toLowerCase() !== codeRemote(intent)?.url.toLowerCase()) throw new Error('The code checkout origin changed.')
    }
    if (intent.member !== undefined) this.checkMemberReceipt(intent, intent.member)
  }

  async assertCurrent(intent: ForgeProvisionIntent): Promise<void> {
    // Phase and external publication admissions use Git's live discovery/ownership policy.
    this.originProofs.delete(intent)
    this.localFence(intent)
    if (this.deps.session.getAccount()?.login.toLowerCase() !== intent.account.login.toLowerCase()) {
      throw new Error('Sign back into the GitHub account that started this operation.')
    }
  }

  private networkFence(intent: ForgeProvisionIntent, receipt: Receipt, expectedOrigin?: string): () => void {
    const token = this.deps.session.getToken()
    return () => {
      this.localFence(intent)
      checkDirectory(receipt)
      if (expectedOrigin !== undefined && this.currentOrigin(receipt.path, intent).toLowerCase() !== expectedOrigin.toLowerCase()) {
        throw new Error('The code checkout origin changed.')
      }
      if (this.deps.session.getAccount()?.login.toLowerCase() !== intent.account.login.toLowerCase() ||
        this.deps.session.getToken() !== token) throw new Error('The GitHub account changed during Forge creation.')
    }
  }

  private async initializeGit(intent: ForgeProvisionIntent, checkout: Receipt, repository: string): Promise<void> {
    const { git } = this.deps
    const current = this.networkFence(intent, checkout)
    const gitConfig = join(checkout.path, '.git', 'config')
    if (!lstatSync(gitConfig, { throwIfNoEntry: false })) {
      await git.run(checkout.path, ['init', '--template=', '--object-format=sha1', '--initial-branch=main'], undefined, { beforeStart: current })
    }
    if (this.readOrigin(checkout.path, intent) === null) {
      await git.run(checkout.path, ['remote', 'add', 'origin', repository], undefined, { beforeStart: current })
    }
    current()
    if (this.currentOrigin(checkout.path, intent).toLowerCase() !== repository.toLowerCase()) throw new Error('The provisioning checkout origin changed.')
  }

  async world(intent: ForgeProvisionIntent, remote: ForgePublishedRepository | undefined): Promise<Receipt> {
    if (intent.destination.existingWorld !== undefined) {
      const world = intent.destination.existingWorld
      assertRemote(await this.deps.publisher.inspectRemote(intent.account, world.url), world.url, world.remoteId)
      this.checkWorld(world, intent)
      return { path: world.path, identity: world.identity }
    }
    if (intent.request.world.kind !== 'new' || remote === undefined) throw new Error('The new Forge World is not confirmed.')
    ensureManagedHome(this.deps.home)
    const worlds = managedChild(this.deps.home, 'forge-worlds')
    const parent = managedChild(worlds, intent.account.login)
    const world = claimDirectory(join(parent, intent.request.world.name), intent, 'git')
    await this.initializeGit(intent, world, remote.url)
    const manifest = join(world.path, 'forge-world.json')
    if (!lstatSync(manifest, { throwIfNoEntry: false })) createForge(world.path, intent.account.login)
    if (readForgeRecipebook(world.path) === null) writeForgeRecipebook(world.path, null, bundledForgeRecipes())
    this.deps.registry.track(world.path)
    return world
  }

  async code(intent: ForgeProvisionIntent, remote: ForgePublishedRepository) {
    const requested = intent.request.code
    const root = intent.world?.path
    if (requested === undefined || root === undefined || intent.destination.parent === undefined) throw new Error('The code checkout location is missing.')
    const bookRoot = intent.destination.existingWorld?.path
    const selected = this.selectedRecipe(bookRoot, requested.recipeId)
    if (recipeHash(selected) !== intent.destination.recipeHash) throw new Error('The selected recipe changed during Forge creation.')
    this.localFence(intent)
    const checkout = claimDirectory(join(intent.destination.parent, requested.name), intent, 'git')
    await this.initializeGit(intent, checkout, remote.url)
    const current = this.networkFence(intent, checkout, remote.url)
    const files = await materializeForgeScaffold(checkout.path, selected, { name: requested.name, repository: remote.url }, () => {
      this.originProofs.delete(intent)
      current()
    })
    current()
    const tickets = worldUrl(intent)
    const pointer = JSON.stringify({ version: 1, worldRepository: tickets, projectFolder: requested.name }, null, 2) + '\n'
    exactFile(join(checkout.path, FORGE_CONFIG), pointer)
    const note = pointerNote(tickets, requested.name)
    exactFile(join(checkout.path, FORGE_POINTER), note)
    files.push({ path: FORGE_POINTER, content: note }, { path: FORGE_CONFIG, content: pointer })
    const commit = await commitForgeScaffold(this.deps.git, { root: checkout.path, files, author: intent.account.login, assertCurrent: current })
    const latest = await this.deps.publisher.inspectRemote(intent.account, remote.url)
    this.checkPublishedRemote(latest, remote)
    current()
    await this.publishCode(checkout.path, remote.url, commit, current)
    await this.deps.git.run(checkout.path, ['update-ref', 'refs/remotes/origin/main', commit], undefined, { beforeStart: current })
    await this.deps.git.run(checkout.path, ['branch', '--set-upstream-to=origin/main', 'main'], undefined, { beforeStart: current })
    return { ...checkout, commit }
  }

  private async publishCode(path: string, url: string, commit: string, current: () => void): Promise<void> {
    const { git } = this.deps
    const expected = commit + '\t' + branch
    const published = async () => (await git.run(path, ['ls-remote', '--refs', url], url, { beforeStart: current })).stdout.trim()
    const refs = await published()
    if (refs === expected) return
    if (refs !== '') throw new Error('The GitHub code repository already contains different work. No code was overwritten.')
    try { await git.run(path, ['push', url, commit + ':' + branch], url, { beforeStart: current }) }
    catch {
      if (await published() !== expected) throw new Error('GitHub has not confirmed the code push. Resume to check the exact commit.')
      return
    }
    if (await published() !== expected) throw new Error('The published code commit could not be verified.')
  }

  private checkMember(member: Receipt): void {
    const project = readProject(resolveLayout(member.path), nodeFs)
    if (project === null || project.projectId !== member.identity) throw new Error('The prepared ticket project changed.')
  }

  private checkMemberReceipt(intent: ForgeProvisionIntent, member: Receipt): void {
    const root = intent.world?.path
    const folder = intent.request.code?.name
    const repository = codeRemote(intent)?.url
    if (root === undefined || folder === undefined || repository === undefined || member.path !== join(root, folder)) {
      throw new Error('The prepared ticket project receipt changed.')
    }
    this.checkMember(member)
    if (checkMapping(root, { folder, repository }, true)) {
      throw new Error('The Forge World no longer maps the confirmed code repository to this ticket project.')
    }
  }

  private checkPublishedRemote(actual: ForgePublishedRepository | null, expected: ForgePublishedRepository): void {
    const remote = assertRemote(actual, expected.url, expected.id)
    if (remote.ownerId !== expected.ownerId || remote.visibility !== expected.visibility || remote.provenance !== expected.provenance) {
      throw new Error('The confirmed GitHub repository owner, visibility or creation receipt changed.')
    }
  }

  private async seedMember(intent: ForgeProvisionIntent, member: string, mapping: ProjectMapping): Promise<Receipt> {
    const code = intent.request.code!
    const temporary = join(dirname(dirname(member)), '.forge-member-' + intent.id)
    const staged = claimDirectory(temporary, intent, 'member')
    const layout = resolveLayout(temporary)
    let project = readProject(layout, nodeFs)
    if (project === null) {
      try { await this.deps.pool.get(temporary).initializeRepository({ name: code.name, mode: 'repo' }) }
      finally { await this.deps.pool.close(temporary) }
      this.originProofs.delete(intent)
      project = readProject(layout, nodeFs)
    }
    if (project === null) throw new Error('The ticket project could not be initialized.')
    const recipe = this.selectedRecipe(intent.destination.existingWorld?.path, code.recipeId)
    if (recipeHash(recipe) !== intent.destination.recipeHash) throw new Error('The selected recipe changed during Forge creation.')
    let detection: ForgeSetupDetection | undefined
    if (readForgeSetupWorkflow(temporary) === null) {
      detection = await this.deps.discover(mapping.repository)
      this.originProofs.delete(intent)
    }
    const current = this.networkFence(intent, staged)
    current()
    mkdirSync(layout.localDir, { recursive: true })
    dirStamp(layout.localDir)
    exactFile(join(layout.localDir, 'source-checkout.json'), JSON.stringify({ checkout: intent.checkout?.path }) + '\n')
    if (detection !== undefined) {
      refreshForgeSetupWorkflow(temporary, mapping.repository, detection, { recipeId: recipe.id, steps: recipe.steps })
    }
    // Keep a staged project out of the live world if an editor changed its manifest during discovery.
    checkMapping(dirname(member), mapping)
    renameSync(temporary, member)
    return { path: member, identity: project.projectId }
  }

  private existingMember(intent: ForgeProvisionIntent, path: string): Receipt | undefined {
    if (!lstatSync(path, { throwIfNoEntry: false })) return undefined
    dirStamp(path)
    const layout = resolveLayout(path)
    dirStamp(layout.localDir)
    exactExistingMemberMarker(join(layout.localDir, 'forge-provisioning'), intent.id)
    const project = readProject(layout, nodeFs)
    if (project === null) throw new Error('The ticket project could not be verified.')
    return { path, identity: project.projectId }
  }

  async member(intent: ForgeProvisionIntent, remote: ForgePublishedRepository): Promise<Receipt> {
    const root = intent.world!.path
    const checkout = intent.checkout!.path
    return this.deps.withWorld(root, async () => {
      this.localFence(intent)
      const folder = intent.request.code!.name
      const path = join(root, folder)
      const mapping = { folder, repository: remote.url }
      const ownedMember = this.existingMember(intent, path)
      checkMapping(root, mapping, ownedMember !== undefined)
      const member = ownedMember ?? await this.seedMember(intent, path, mapping)
      this.localFence(intent)
      this.checkMember(member)
      updateForge(root, world => {
        if (vacantMapping(world.projects, mapping, true)) world.projects.push(mapping)
      }, this.deps.onManifestRetry)
      const { home } = this.deps
      const epoch = forgeBindingEpoch(nodeFs, home, checkout)
      if (epoch === null) bindForge(home, checkout, path, pointerNote(worldUrl(intent), folder))
      else if (boundForgeRoot(nodeFs, home, checkout) !== path) throw new Error('The code checkout is already bound to a different ticket folder.')
      return member
    })
  }

  async publish(intent: ForgeProvisionIntent): Promise<void> {
    const world = intent.world!
    const url = worldUrl(intent)
    const remote = await this.deps.publisher.inspectRemote(intent.account, url)
    if (intent.worldRemote?.state === 'confirmed') this.checkPublishedRemote(remote, intent.worldRemote.value)
    else assertRemote(remote, url, intent.destination.existingWorld!.remoteId)
    const current = this.networkFence(intent, world)
    await this.deps.withWorld(world.path, async () => {
      current()
      await this.deps.synchronize(world.path, current)
      current()
      const head = await this.deps.git.run(world.path, ['rev-parse', 'HEAD'], undefined, { beforeStart: current })
      const remote = await this.deps.git.run(world.path, ['ls-remote', '--heads', url, branch], url, { beforeStart: current })
      if (remote.stdout.trim() !== head.stdout.trim() + '\t' + branch) throw new Error('GitHub has not confirmed the published Forge World commit.')
      current()
    })
    if (intent.member !== undefined) await this.deps.onProject?.(intent.member.path, intent.request.agent)
  }
}

function pointerNote(world: string, folder: string): string {
  return '# Ticket source control\n\nForge World: ' + world + '\nProject folder: ' + folder +
    '\n\nClone or pull the Forge World above, then open the named folder for tickets.\nThe root forge-world.json contains all linked project folders and their repository URLs.\n'
}

function exactExistingMemberMarker(file: string, operation: string): void {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== operation.length + 1 || readFileSync(file, 'utf8') !== operation + '\n') {
    throw new Error('The existing ticket folder belongs to a different operation.')
  }
}

export function createForgeProvisioningWork(options: ProvisioningOptions): ForgeProvisioningWork {
  return new ProvisioningWork(options)
}

export function bundledRecipebookFile() {
  const value = bundledForgeRecipes()
  const sha256 = createHash('sha256').update(encodeForgeRecipebook(value)).digest('hex')
  return { value, sha256 }
}
