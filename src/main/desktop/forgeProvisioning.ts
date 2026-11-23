import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { forgeSetupId } from '../../core/repo/forgeSetupFormat'
import type { ForgeProvisionRequest, ForgeProvisionResult, ForgeProvisionStatus } from '../../shared/desktop/forgeSetup'
import { projectName } from './forgeManifest'
import {
  ForgeCreationRefused, forgeProvisionAccount, forgePublishedRepository, sameForgeAccount,
  type ForgeProvisionAccount, type ForgePublishedRepository, type ForgeRepositoryPublisher
} from './forgePublish'

const slug = z.string().max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(name => {
  try { return projectName(name) === name && !/\.git$/i.test(name) } catch { return false }
})
const requestSchema = z.strictObject({
  world: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('new'), name: slug }),
    z.strictObject({ kind: z.literal('existing'), folder: z.string().min(1).max(4096) })
  ]),
  code: z.strictObject({ name: slug, visibility: z.enum(['private', 'public']), recipeId: forgeSetupId }).optional(),
  agent: z.string().min(1).max(128).optional()
})
const phaseSchema = z.enum(['checking', 'world-remote', 'world-checkout', 'code-remote', 'code-checkout', 'member', 'publish', 'complete'])
const receiptSchema = z.strictObject({ path: z.string().min(1), identity: z.string().min(1) })
const checkoutSchema = receiptSchema.extend({ commit: z.string().regex(/^[a-f0-9]{40}$/) })
const destinationSchema = z.strictObject({
  parent: z.string().min(1).optional(),
  parentIdentity: z.string().optional(),
  existingWorld: receiptSchema.extend({ url: z.string(), addedAt: z.string(), remoteId: z.number().int().positive() }).optional(),
  recipeHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
})
const remoteSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('requested') }),
  z.strictObject({ state: z.literal('confirmed'), value: forgePublishedRepository })
])
const intentSchema = z.strictObject({
  id: z.uuid(), request: requestSchema, account: forgeProvisionAccount,
  destination: destinationSchema,
  phase: phaseSchema,
  state: z.enum(['running', 'needs-attention', 'complete']),
  message: z.string().nullable(),
  worldRemote: remoteSchema.optional(), codeRemote: remoteSchema.optional(),
  world: receiptSchema.optional(), checkout: checkoutSchema.optional(), member: receiptSchema.optional()
})
const journalSchema = z.strictObject({ version: z.literal(1), entries: z.array(intentSchema).max(2000) })
type Phase = ForgeProvisionStatus['phase']
type Location = z.infer<typeof receiptSchema>
type CodeCheckout = z.infer<typeof checkoutSchema>
export type ProvisionDestination = z.infer<typeof destinationSchema>
export type ForgeProvisionIntent = z.infer<typeof intentSchema>
type RemoteKey = 'worldRemote' | 'codeRemote'

export interface ForgeProvisioningWork extends ForgeRepositoryPublisher {
  currentLogin(): string | null
  prepare(request: ForgeProvisionRequest, account: ForgeProvisionAccount): Promise<ProvisionDestination | null>
  assertCurrent(intent: ForgeProvisionIntent): Promise<void>
  world(intent: ForgeProvisionIntent, remote: ForgePublishedRepository | undefined): Promise<Location>
  code(intent: ForgeProvisionIntent, remote: ForgePublishedRepository): Promise<CodeCheckout>
  member(intent: ForgeProvisionIntent, remote: ForgePublishedRepository): Promise<Location>
  publish(intent: ForgeProvisionIntent): Promise<void>
}

export interface ForgeProvisioning {
  provision(input: unknown, operationId: unknown): Promise<ForgeProvisionResult>
  provisioning(): Promise<ForgeProvisionStatus[]>
  resumeProvision(id: unknown): Promise<ForgeProvisionStatus>
  assertWorldPublished(root: string): void
  stop(): Promise<void>
}

function readJournal(file: string): Map<string, ForgeProvisionIntent> {
  let source: string
  try { source = readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  try {
    const { entries } = journalSchema.parse(JSON.parse(source))
    const records = new Map(entries.map(entry => [entry.id, entry]))
    if (entries.length !== records.size) throw new Error('Repeated provisioning operation ID.')
    return records
  } catch {
    throw new Error('The Forge creation journal could not be read. Preserve it before continuing.')
  }
}

function writeJournal(file: string, entries: Map<string, ForgeProvisionIntent>): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID()
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, entries: [...entries.values()] }) + '\n', { flag: 'wx', flush: true, mode: 0o600 })
    renameSync(temp, file)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function repositoryTargets(request: ForgeProvisionRequest): string[] {
  return [
    ...(request.world.kind === 'new' ? [request.world.name.toLowerCase()] : []),
    ...(request.code === undefined ? [] : [request.code.name.toLowerCase()])
  ]
}

function userRequest(input: unknown): ForgeProvisionRequest {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new Error('Choose valid GitHub repository names and a Forge recipe.')
  const request = parsed.data
  if (request.world.kind === 'existing' && request.code === undefined) throw new Error('Choose a new code repository for the existing Forge World.')
  if (new Set(repositoryTargets(request)).size !== repositoryTargets(request).length) {
    throw new Error('Choose separate repository names for the code and ticket store.')
  }
  return request
}

function report(intent: ForgeProvisionIntent, active: boolean): ForgeProvisionStatus {
  const interrupted = intent.state === 'running' && !active
  return {
    id: intent.id, request: intent.request, phase: intent.phase,
    state: interrupted ? 'needs-attention' : intent.state,
    message: interrupted ? 'Forge creation was interrupted. Resume to verify which steps finished.' : intent.message,
    world: intent.world?.path, member: intent.member?.path, checkout: intent.checkout?.path
  }
}

function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Forge creation could not continue.'
  return message.replace(/[\p{Cc}]/gu, ' ').slice(0, 500)
}

type RemoteTarget = Omit<Parameters<ForgeRepositoryPublisher['createRemote']>[0], 'account'>

function correlate(intent: ForgeProvisionIntent, target: RemoteTarget, repo: ForgePublishedRepository, id?: number) {
  const account = intent.account
  const { name, visibility, provenance } = target
  const canonicalUrl = 'https://github.com/' + account.login + '/' + name + '.git'
  if (repo.owner.toLowerCase() !== account.login.toLowerCase() || repo.ownerId !== account.id ||
    repo.name.toLowerCase() !== name.toLowerCase() || repo.url.toLowerCase() !== canonicalUrl.toLowerCase() ||
    repo.visibility !== visibility || repo.provenance !== provenance || (id !== undefined && repo.id !== id)) {
    throw new Error('A different GitHub repository now has this name. No existing repository was adopted.')
  }
}

class Provisioning implements ForgeProvisioning {
  private records: Map<string, ForgeProvisionIntent> | undefined
  private readonly active = new Map<string, Promise<ForgeProvisionStatus>>()
  private stopped = false

  constructor(private readonly file: string, private readonly work: ForgeProvisioningWork) {}

  private journal() { return (this.records ??= readJournal(this.file)) }

  private save(intent: ForgeProvisionIntent): void {
    const next = new Map(this.journal())
    next.set(intent.id, intent)
    writeJournal(this.file, next)
    this.records = next
  }

  private available(): void {
    if (this.stopped) throw new Error('Forge creation is stopping.')
  }

  private existingRequest(id: string, account: ForgeProvisionAccount, request: ForgeProvisionRequest): ForgeProvisionResult | undefined {
    const current = this.journal().get(id)
    if (current !== undefined) {
      return sameForgeAccount(current.account, account) && JSON.stringify(current.request) === JSON.stringify(request)
        ? report(current, this.active.has(id))
        : { state: 'refused', message: 'This Forge creation operation belongs to another account or request.' }
    }
    const names = new Set(repositoryTargets(request))
    if ([...this.journal().values()].some(intent => sameForgeAccount(account, intent.account) &&
      repositoryTargets(intent.request).some(name => names.has(name)))) {
      return { state: 'refused', message: 'A Forge creation already uses one of these repository names. Open or resume that operation.' }
    }
  }

  private async preflight(input: unknown, intent: unknown) {
    this.available()
    const request = userRequest(input)
    const operation = z.uuid().safeParse(intent)
    if (!operation.success) throw new Error('This Forge creation operation has an invalid identifier.')
    const account = await this.work.account()
    return { request, account, id: operation.data }
  }

  async provision(input: unknown, operation: unknown): Promise<ForgeProvisionResult> {
    const prepared = await this.preflight(input, operation).catch((error: unknown) => ({ state: 'refused' as const, message: publicMessage(error) }))
    if ('state' in prepared) return prepared
    // Journal read/write failures remain exceptional. They cannot be mistaken for user input refusal.
    const { request, account, id } = prepared
    const previous = this.existingRequest(id, account, request)
    if (previous !== undefined) return previous
    const destination = await this.work.prepare(request, account).catch((error: unknown) => ({ state: 'refused' as const, message: publicMessage(error) }))
    if (destination === null || 'state' in destination) return destination
    this.available()
    const raced = this.existingRequest(id, account, request)
    if (raced !== undefined) return raced
    const intent: ForgeProvisionIntent = {
      ...prepared, destination, phase: 'checking', state: 'running', message: null
    }
    this.save(intent)
    return this.run(intent)
  }

  async provisioning(): Promise<ForgeProvisionStatus[]> {
    const login = this.work.currentLogin()?.toLowerCase()
    if (login === undefined) return []
    return [...this.journal().values()].reverse().filter(intent => intent.account.login.toLowerCase() === login)
      .map(intent => report(intent, this.active.has(intent.id)))
  }

  assertWorldPublished(root: string): void {
    const file = join(root, '.git', 'forge-provisioning')
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 37) throw new Error('The Forge creation receipt cannot be verified.')
    const id = readFileSync(file, 'utf8').trim()
    const intent = this.journal().get(id)
    if (intent === undefined || intent.request.world.kind !== 'new') throw new Error('The Forge creation receipt cannot be verified.')
    if (intent.state !== 'complete') throw new Error('Resume Forge World creation before syncing this repository.')
    if (intent.world?.path !== root) throw new Error('The published Forge World checkout changed.')
  }

  async resumeProvision(raw: unknown): Promise<ForgeProvisionStatus> {
    this.available()
    const parsed = z.uuid().safeParse(raw)
    const intent = parsed.success ? this.journal().get(parsed.data) : undefined
    if (!intent) throw new Error('This Forge creation operation no longer exists.')
    const account = await this.work.account()
    if (!sameForgeAccount(account, intent.account)) return {
      id: intent.id, request: intent.request, phase: intent.phase, state: 'needs-attention',
      message: 'Sign back into the GitHub account that started this operation.'
    }
    if (intent.state === 'complete') return report(intent, false)
    return this.run(intent)
  }

  private run(intent: ForgeProvisionIntent): Promise<ForgeProvisionStatus> {
    const active = this.active.get(intent.id)
    if (active) return active
    const progress = { ...intent, state: 'running' as const, message: null }
    this.save(progress)
    const work = this.advance(progress).finally(() => this.active.delete(intent.id))
    this.active.set(intent.id, work)
    return work
  }

  private async phase(intent: ForgeProvisionIntent, phase: Phase): Promise<void> {
    this.available()
    intent.phase = phase
    this.save({ ...intent })
    await this.work.assertCurrent(intent)
  }

  private async advance(intent: ForgeProvisionIntent): Promise<ForgeProvisionStatus> {
    try {
      if (!sameForgeAccount(intent.account, await this.work.account())) throw new Error('Sign back into the GitHub account that started this operation.')
      await this.advanceWorld(intent)
      if (intent.request.code !== undefined) await this.advanceCode(intent, intent.request.code)
      await this.phase(intent, 'publish')
      await this.work.publish(intent)
      intent.phase = 'complete'
      intent.state = 'complete'
    } catch (error: unknown) {
      intent.state = 'needs-attention'
      intent.message = publicMessage(error)
    }
    this.save({ ...intent })
    return report(intent, true)
  }

  private async advanceWorld(intent: ForgeProvisionIntent): Promise<void> {
    let remote: ForgePublishedRepository | undefined
    if (intent.request.world.kind === 'new') {
      await this.phase(intent, 'world-remote')
      remote = await this.remote(intent, 'worldRemote', intent.request.world.name, 'private')
    }
    if (intent.world === undefined) {
      await this.phase(intent, 'world-checkout')
      intent.world = await this.work.world(intent, remote)
      this.save({ ...intent })
    }
  }

  private async advanceCode(intent: ForgeProvisionIntent, code: NonNullable<ForgeProvisionRequest['code']>): Promise<void> {
    await this.phase(intent, 'code-remote')
    const remote = await this.remote(intent, 'codeRemote', code.name, code.visibility)
    if (intent.checkout === undefined) {
      await this.phase(intent, 'code-checkout')
      intent.checkout = await this.work.code(intent, remote)
      this.save({ ...intent })
    }
    if (intent.member === undefined) {
      await this.phase(intent, 'member')
      intent.member = await this.work.member(intent, remote)
      this.save({ ...intent })
    }
  }

  private async remote(intent: ForgeProvisionIntent, key: RemoteKey, name: string, visibility: 'private' | 'public'): Promise<ForgePublishedRepository> {
    const target = { name, visibility, provenance: 'Created by Dark Mechanicus (' + intent.id + ')' }
    const previous = intent[key]
    const existing = await this.work.findRemote(intent.account, name)
    if (previous !== undefined) {
      if (existing === null) throw new Error('GitHub has not confirmed repository creation. Resume to check again without creating another repository.')
      correlate(intent, target, existing, previous.state === 'confirmed' ? previous.value.id : undefined)
      return this.recordRemote(intent, key, existing)
    }
    if (existing !== null) throw new Error('That GitHub repository already exists. Choose a new repository name.')
    await this.work.assertCurrent(intent)
    this.available()
    intent[key] = { state: 'requested' }
    this.save({ ...intent })
    let created: ForgePublishedRepository
    try {
      created = await this.work.createRemote({ ...target, account: intent.account })
    } catch (error: unknown) {
      if (error instanceof ForgeCreationRefused) {
        delete intent[key]
        throw error
      }
      throw new Error('GitHub has not confirmed repository creation. Resume to check for the result.')
    }
    correlate(intent, target, created)
    return this.recordRemote(intent, key, created)
  }

  private recordRemote(intent: ForgeProvisionIntent, key: RemoteKey, value: ForgePublishedRepository): ForgePublishedRepository {
    intent[key] = { state: 'confirmed', value }
    this.save({ ...intent })
    return value
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.active.values())
  }
}

export function createForgeProvisioning(file: string, work: ForgeProvisioningWork): ForgeProvisioning {
  return new Provisioning(file, work)
}
