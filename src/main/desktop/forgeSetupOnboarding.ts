import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { resolveLayout } from '../../core/repo/layout'
import { forgeSetupEvidenceHash, forgeSetupWorkflowState, readForgeSetupWorkflow, refreshForgeSetupWorkflow, saveForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentId } from '../../shared/desktop/api'
import { agentIdSchema } from '../../shared/desktop/agentKinds'
import { FORGE_SETUP_DIRECTORY, FORGE_SETUP_WORKFLOW_FILE, type ForgeSetupConversationStatus, type ForgeSetupDetection, type ForgeSetupFile, type ForgeSetupProjectView, type ForgeSetupWorkflow, type ForgeSetupWorkflowEdit } from '../../shared/desktop/forgeSetup'
import type { StoredDeliveryPolicy } from '../../shared/domain/deliveryPolicy'
import { standardsChat } from '../../shared/domain/standardsChat'
import type { ChatRecords } from '../agents/chatRecords'
import type { ChatRef } from '../agents/chatStore'
import type { TerminalStart } from '../terminals/terminalSessions'
import { ForgeSetupJournal, type SetupDelivery, type SetupExecution, type SetupIntent } from './forgeSetupJournal'

export interface ForgeSetupMember {
  member: string
  root: string
  repository: string
  identity: string
  assertCurrent(): void
}

type ChatTag = NonNullable<ChatRecord['forgeSetup']>
type Workflow = ForgeSetupFile<ForgeSetupWorkflow>
interface Checkout {
  root: string
  assertCurrent(): void
}

export interface ForgeSetupOnboardingOptions {
  file: string
  scratch: string
  resolveMember(input: unknown): ForgeSetupMember
  discover(repository: string): Promise<ForgeSetupDetection>
  mutate<T>(root: string, work: () => Promise<T>): Promise<T>
  sync(root: string): void
  preferred(member: ForgeSetupMember): AgentId | null
  agent(id: AgentId): string | null
  resolveCheckout(member: ForgeSetupMember): Checkout
  getStandards(member: string): Promise<StoredDeliveryPolicy | undefined>
  findChat(folder: string, tag: ChatTag): ChatRecord | undefined
  getChat(ref: ChatRef): ChatRecord | null
  createChat(request: Parameters<ChatRecords['createChat']>[0]): Promise<ChatRecord>
  start(chat: ChatRecord, authorization: symbol): Promise<TerminalStart>
  hasInput(chat: ChatRecord, text: string, cwd: string): boolean
  running(chatId: string): boolean
  announce(chat: ChatRecord): void
}

const workflowEdit = z.strictObject({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.strictObject({ state: z.enum(['needs-discovery', 'configured']), steps: z.array(z.unknown()).max(32) }),
  notes: z.string().max(8192).optional()
})

function summary(error: unknown): string {
  return (error instanceof Error ? error.message : 'Forge setup could not continue.').replace(/[\p{Cc}]/gu, ' ').slice(0, 500)
}

function workflowPath(member: ForgeSetupMember): string {
  return join(resolveLayout(member.member).knowledgeDir, FORGE_SETUP_DIRECTORY, FORGE_SETUP_WORKFLOW_FILE)
}

function preparationPrompt(member: ForgeSetupMember, file: Workflow, standards: StoredDeliveryPolicy | undefined): string {
  return [
    'Prepare this Forge project in one conversation with the person.',
    'Managed ticket project: ' + member.member + '\nCode repository: ' + member.repository,
    'Review the detected facts and provenance in ' + workflowPath(member) + '. Ask about any missing environment or validation steps.',
    'Propose an ordered setup workflow, reviewing the existing steps before changing them. Drafting those steps is authorized. With the person’s agreement, you may edit only that workflow.yaml knowledge file in the bound ticket member. Ticket, grant, and configuration records still use their usual tools and approvals.',
    'The reviewed file currently has revision ' + file.value.revision + ' and SHA-256 ' + file.sha256 +
      '. Re-read it before saving and reconcile any change with the person. Preserve the generated repository and detection fields, increment revision, and set workflow.state to configured and workflow.basedOn to ' +
      forgeSetupEvidenceHash(file.value.repository, file.value.detection) + ' for the current evidence. Keep machine paths and credentials out of the file.',
    'Do not run installers or setup steps in this preparation conversation. Read package, test or CI descriptors for planning. Ask before executing the agreed setup from Dark Mechanicus.',
    standardsChat('prepare', standards)
  ].join('\n\n')
}

function executionPrompt(member: ForgeSetupMember, run: SetupExecution): string {
  return [
    'The person explicitly approved executing the current Forge setup workflow for this project.',
    'Code checkout and starting directory: ' + run.checkout,
    'Your Dark Mechanicus CLI remains bound to the ticket project: ' + member.member,
    'Read ' + workflowPath(member) + ' and verify its SHA-256 is ' + run.sha256 + ' before executing any step. If it changed, stop and ask the person to review the new workflow.',
    'Follow the ordered steps for this platform in their specified repository-relative working directories. Use the listed program and argument array as reviewed. Ask before making changes outside the reviewed steps. On failure, identify the step, capture useful redacted output, and diagnose it before proposing another command.',
    'Report which steps completed, which checks ran, and the remaining blockers. Keep local installation and launch observations in this conversation. The portable file records requirements and approved steps.'
  ].join('\n\n')
}

function operation(): SetupDelivery {
  return { id: randomUUID(), agent: null, agentSignature: null, chatId: null, delivery: 'pending', message: null }
}

function belongs(chat: ChatRecord, tag: ChatTag, folder: string): boolean {
  return chat.folder === folder && chat.forgeSetup?.intentId === tag.intentId &&
    chat.forgeSetup.stepId === tag.stepId && chat.forgeSetup.mode === tag.mode && !chat.archived
}

interface AuthorizedLaunch {
  token: symbol
  chatId: string
  authorize(): string
}

class ForgeSetupOnboarding {
  private readonly journal: ForgeSetupJournal
  private readonly active = new Map<string, Promise<ForgeSetupConversationStatus>>()
  private readonly authorizations = new Map<string, AuthorizedLaunch>()

  constructor(private readonly deps: ForgeSetupOnboardingOptions) { this.journal = new ForgeSetupJournal(deps.file) }

  async project(input: unknown): Promise<ForgeSetupProjectView> {
    return this.view(this.deps.resolveMember(input))
  }

  private view(member: ForgeSetupMember): ForgeSetupProjectView {
    const value = this.workflow(member)
    const intent = this.intentFor(member)
    return { member: member.member, repository: member.repository, value, state: forgeSetupWorkflowState(value),
      onboarding: intent === undefined ? null : this.status(intent) }
  }

  private workflow(member: ForgeSetupMember): Workflow | null {
    member.assertCurrent()
    const current = readForgeSetupWorkflow(member.member)
    if (current && current.value.repository.toLowerCase() !== member.repository.toLowerCase()) {
      throw new Error('The workflow belongs to a different code repository.')
    }
    return current
  }

  async saveWorkflow(input: unknown, value: unknown): Promise<ForgeSetupProjectView> {
    const member = this.deps.resolveMember(input)
    const edit = workflowEdit.parse(value) as ForgeSetupWorkflowEdit
    await this.deps.mutate(member.root, async () => {
      this.workflow(member)
      saveForgeSetupWorkflow(member.member, edit)
    })
    this.deps.sync(member.root)
    return this.view(member)
  }

  async refresh(input: unknown): Promise<ForgeSetupProjectView> {
    const member = this.deps.resolveMember(input)
    await this.refreshMember(member)
    this.deps.sync(member.root)
    return this.view(member)
  }

  private async refreshMember(member: ForgeSetupMember): Promise<Workflow> {
    const detected = await this.deps.discover(member.repository)
    return this.deps.mutate(member.root, async () => {
      member.assertCurrent()
      return refreshForgeSetupWorkflow(member.member, member.repository, detected)
    })
  }

  private getIntent(member: ForgeSetupMember): SetupIntent {
    const existing = this.intentFor(member)
    if (existing !== undefined) return existing
    const intent = { id: randomUUID(), member: member.member, repository: member.repository, identity: member.identity, onboarding: operation() }
    this.journal.save(intent)
    return intent
  }

  private intentFor(member: ForgeSetupMember): SetupIntent | undefined {
    const intent = this.journal.get(member.identity)
    if (intent !== undefined && (intent.member !== member.member || intent.repository.toLowerCase() !== member.repository.toLowerCase())) {
      throw new Error('The ticket member or code repository changed. Its earlier Forge setup conversation cannot be reused.')
    }
    return intent
  }

  async imported(input: unknown, agent?: string): Promise<void> {
    const member = this.deps.resolveMember(input)
    // Record the intent even when discovery or launch has to be resumed later.
    const intent = this.getIntent(member)
    this.rememberAgent(intent, member, agent)
    await this.ensureWorkflow(member)
    if (this.available(intent.onboarding)) void this.prepare(member.member).catch(() => undefined)
  }

  private rememberAgent(intent: SetupIntent, member: ForgeSetupMember, chosen?: unknown): void {
    if (intent.onboarding.chatId !== null || intent.onboarding.delivery === 'attempted') return
    const agent = chosen === undefined ? intent.onboarding.agent ?? this.deps.preferred(member) : agentIdSchema.parse(chosen)
    if (agent !== null) {
      intent.onboarding.agent = agent
      intent.onboarding.agentSignature = this.deps.agent(agent)
      this.journal.save(intent)
    }
  }

  private async ensureWorkflow(member: ForgeSetupMember): Promise<Workflow> {
    return this.workflow(member) ?? await this.refreshMember(member)
  }

  async prepare(input: unknown, chosen?: unknown): Promise<ForgeSetupConversationStatus> {
    const member = this.deps.resolveMember(input)
    const active = this.active.get(member.identity)
    if (active !== undefined) return active
    const intent = this.getIntent(member)
    this.rememberAgent(intent, member, chosen)
    return this.track(member.identity, this.prepareMember(member, intent))
  }

  private async prepareMember(member: ForgeSetupMember, intent: SetupIntent): Promise<ForgeSetupConversationStatus> {
    try {
      if (!this.canLaunch(intent, intent.onboarding)) return this.status(intent)
      const file = await this.ensureWorkflow(member)
      if (!this.available(intent.onboarding)) return this.status(intent, 'Choose a connected agent to prepare setup and Delivery Standards.')
      const standards = await this.deps.getStandards(member.member)
      member.assertCurrent()
      const cwd = this.authoringDirectory(intent)
      const prompt = preparationPrompt(member, file, standards)
      await this.dispatch({ member, intent, receipt: intent.onboarding, mode: 'onboarding',
        prompt, authorize: () => { member.assertCurrent(); return this.authoringDirectory(intent) }, cwd })
    } catch (error) { this.rememberFailure(intent, intent.onboarding, error) }
    return this.status(intent)
  }

  async run(input: unknown, expectedSha256: unknown, expectedCheckout: unknown): Promise<ForgeSetupConversationStatus> {
    const member = this.deps.resolveMember(input)
    const file = this.checkedWorkflow(member, expectedSha256)
    const code = this.deps.resolveCheckout(member)
    if (code.root !== expectedCheckout) throw new Error('The verified code checkout changed. Review and confirm its location before starting setup.')
    const intent = this.getIntent(member)
    if (this.active.has(member.identity)) return this.status(intent, 'Wait for the existing Forge setup request to settle.')
    return this.track(member.identity, this.runWorkflow(member, intent, file, code))
  }

  private async runWorkflow(member: ForgeSetupMember, intent: SetupIntent, file: Workflow, code: Checkout) {
    if (this.status(intent).state !== 'opened' || !this.available(intent.onboarding)) {
      return this.status(intent, 'Finish opening the existing onboarding conversation before asking its agent to execute the workflow.')
    }
    const previous = intent.execution
    if (previous !== undefined && this.keepExecution(intent, previous, file.sha256)) {
      const earlier = previous.sha256 !== file.sha256 ? 'An earlier setup execution is still active or unconfirmed. Review its conversation before starting a different workflow.' : undefined
      return this.status(intent, earlier)
    }
    const receipt: SetupExecution = previous?.sha256 === file.sha256 ? previous : {
      ...operation(), agent: intent.onboarding.agent, agentSignature: intent.onboarding.agentSignature,
      sha256: file.sha256, checkout: code.root
    }
    if (receipt.checkout !== code.root) throw new Error('This setup execution is already pinned to another checkout.')
    const authorize = () => {
      code.assertCurrent()
      this.checkedWorkflow(member, receipt.sha256)
      return code.root
    }
    authorize()
    intent.execution = receipt
    this.journal.save(intent)
    try { await this.dispatch({ member, intent, receipt, mode: 'execution', prompt: executionPrompt(member, receipt), authorize, cwd: code.root }) }
    catch (error) { this.rememberFailure(intent, receipt, error) }
    return this.status(intent)
  }

  private keepExecution(intent: SetupIntent, run: SetupExecution, sha256: string): boolean {
    const delivery = this.delivery(intent, run, 'execution')
    if (run.chatId !== null && this.deps.running(run.chatId)) return true
    if (delivery === 'attempted') return true
    return run.sha256 === sha256 && (delivery === 'submitted' || this.authorizations.has(run.id))
  }

  private checkedWorkflow(member: ForgeSetupMember, expectedSha256: unknown): Workflow {
    const file = this.workflow(member)
    if (!file || file.sha256 !== expectedSha256) throw new Error('The setup workflow changed. Reload and review the current revision before setup.')
    if (forgeSetupWorkflowState(file) !== 'configured') throw new Error('Configure the workflow against the current detected facts before setup.')
    return file
  }

  private track(identity: string, pending: Promise<ForgeSetupConversationStatus>): Promise<ForgeSetupConversationStatus> {
    const work = pending.finally(() => this.active.delete(identity))
    this.active.set(identity, work)
    return work
  }

  private available(receipt: SetupDelivery): boolean {
    return receipt.agent !== null && receipt.agentSignature !== null && this.deps.agent(receipt.agent) === receipt.agentSignature
  }

  private canLaunch(intent: SetupIntent, receipt: SetupDelivery): boolean {
    const delivery = this.delivery(intent, receipt, 'onboarding')
    return delivery === 'pending' || delivery === 'failed'
  }

  private authoringDirectory(intent: SetupIntent): string {
    const path = join(this.deps.scratch, intent.id)
    mkdirSync(path, { recursive: true })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== resolve(path)) throw new Error('The managed onboarding directory changed.')
    return path
  }

  private tag(intent: SetupIntent, receipt: SetupDelivery, mode: ChatTag['mode']): ChatTag {
    return { intentId: intent.id, stepId: receipt.id, mode }
  }

  private find(intent: SetupIntent, receipt: SetupDelivery, mode: ChatTag['mode']): ChatRecord | undefined {
    const tag = this.tag(intent, receipt, mode)
    const chat = receipt.chatId === null ? this.deps.findChat(intent.member, tag)
      : this.deps.getChat({ folder: intent.member, id: receipt.chatId })
    return chat && belongs(chat, tag, intent.member) ? chat : undefined
  }

  private async ensureChat(work: Dispatch): Promise<ChatRecord> {
    const { intent, receipt, mode, member, prompt } = work
    const prior = this.find(intent, receipt, mode)
    if (prior !== undefined) return prior
    if (receipt.chatId !== null) throw new Error('The original conversation is unavailable. A replacement was not created.')
    member.assertCurrent()
    return this.deps.createChat({
      folder: member.member, agent: receipt.agent!, role: 'planner', allowSave: mode === 'onboarding',
      title: mode === 'onboarding' ? 'Prepare Forge setup and Delivery Standards' : 'Set up Forge environment',
      firstPrompt: prompt, forgeSetup: this.tag(intent, receipt, mode)
    })
  }

  private async dispatch(work: Dispatch): Promise<void> {
    const { intent, receipt, mode, authorize } = work
    const chat = await this.ensureChat(work)
    this.checkChatAuthority(chat, receipt, mode)
    if (receipt.chatId === null) {
      receipt.chatId = chat.id
      this.journal.save(intent)
      this.deps.announce(chat)
    }
    const path = authorize()
    if (path !== work.cwd) throw new Error('The authorized launch directory changed.')
    receipt.delivery = 'attempted'
    receipt.message = null
    this.journal.save(intent)
    const token = Symbol('Forge setup launch')
    this.authorizations.set(receipt.id, { token, chatId: chat.id, authorize })
    try {
      const started = await this.deps.start(chat, token)
      if (started.state === 'running') this.observe(intent, receipt, mode)
      else if (started.state === 'refused' || started.state === 'signed_out') {
        receipt.delivery = 'failed'
        receipt.message = started.message
        this.journal.save(intent)
      } else this.rememberFailure(intent, receipt, new Error(started.message))
    } finally {
      this.authorizations.delete(receipt.id)
      this.deps.announce(chat)
    }
  }

  private checkChatAuthority(chat: ChatRecord, receipt: SetupDelivery, mode: ChatTag['mode']): void {
    if (!this.available(receipt) || chat.agent !== receipt.agent || chat.role !== 'planner' || chat.allowSave !== (mode === 'onboarding')) {
      throw new Error('The configured agent or conversation authority changed. Reconnect it before continuing.')
    }
  }

  private rememberFailure(intent: SetupIntent, receipt: SetupDelivery, error: unknown): void {
    if (receipt.delivery !== 'attempted') receipt.delivery = 'failed'
    receipt.message = summary(error)
    this.journal.save(intent)
  }

  private observe(intent: SetupIntent, receipt: SetupDelivery, mode: ChatTag['mode']): void {
    if (this.delivery(intent, receipt, mode) !== 'submitted' || receipt.delivery === 'submitted') return
    receipt.delivery = 'submitted'
    receipt.message = null
    this.journal.save(intent)
  }

  private delivery(intent: SetupIntent, receipt: SetupDelivery, mode: ChatTag['mode']): SetupDelivery['delivery'] {
    if (receipt.delivery !== 'attempted') return receipt.delivery
    const chat = this.find(intent, receipt, mode)
    if (chat?.firstPrompt === undefined) return 'attempted'
    const cwd = mode === 'onboarding' ? join(this.deps.scratch, intent.id) : intent.execution!.checkout
    return chat.firstPromptDelivery === 'submitted' || this.deps.hasInput(chat, chat.firstPrompt, cwd) ? 'submitted' : 'attempted'
  }

  private status(intent: SetupIntent, override?: string): ForgeSetupConversationStatus {
    const author = intent.onboarding
    const delivery = this.delivery(intent, author, 'onboarding')
    const pending = this.isPending(author)
    const chat = this.find(intent, author, 'onboarding')
    const state = delivery === 'submitted' && chat !== undefined ? 'opened' : pending ? 'preparing'
      : delivery === 'attempted' ? 'uncertain' : 'needs-attention'
    return { state, chatId: chat?.id ?? author.chatId, run: this.runStatus(intent),
      message: override ?? author.message ?? intent.execution?.message ?? this.authoringMessage(state, author) }
  }

  private authoringMessage(state: ForgeSetupConversationStatus['state'], author: SetupDelivery): string | null {
    if (state === 'uncertain') return 'Onboarding delivery is unconfirmed. Check its existing conversation before proceeding.'
    if (state === 'needs-attention') return author.agent === null ? 'Choose a connected agent for setup preparation.' : 'Open onboarding to check the existing conversation and configured agent.'
    return null
  }

  private isPending(receipt: SetupDelivery): boolean {
    return this.authorizations.has(receipt.id) || (receipt.chatId !== null && this.deps.running(receipt.chatId))
  }

  private runStatus(intent: SetupIntent): ForgeSetupConversationStatus['run'] {
    const role = intent.execution
    if (role === undefined) return null
    const delivery = this.delivery(intent, role, 'execution')
    const state = delivery === 'attempted' ? this.isPending(role) ? 'pending' : 'uncertain' : delivery
    return { state, workflowSha256: role.sha256, chatId: role.chatId }
  }

  assertLaunch(chat: ChatRecord, authorization?: symbol): string {
    const tag = chat.forgeSetup
    if (tag === undefined) throw new Error('Forge setup launch authority is unavailable.')
    if (tag.mode === 'execution' && authorization === undefined) throw new Error('This installer conversation starts only from the explicit setup action.')
    const member = this.deps.resolveMember(chat.folder)
    const intent = this.intentFor(member)
    if (intent?.id !== tag.intentId) throw new Error('The Forge setup intent no longer belongs to this ticket project.')
    const receipt = tag.mode === 'onboarding' ? intent.onboarding : intent.execution
    if (!receipt || receipt.id !== tag.stepId || receipt.chatId !== chat.id) throw new Error('The Forge setup conversation changed.')
    this.checkChatAuthority(chat, receipt, tag.mode)
    const active = this.authorizations.get(receipt.id)
    if (active !== undefined && active.token === authorization && active.chatId === chat.id) return active.authorize()
    if (tag.mode === 'onboarding' && authorization === undefined && this.delivery(intent, receipt, tag.mode) === 'submitted') {
      member.assertCurrent()
      return this.authoringDirectory(intent)
    }
    throw new Error('Open the Forge setup controls to review this existing conversation. Its prompt was not replayed.')
  }
}

interface Dispatch {
  member: ForgeSetupMember
  intent: SetupIntent
  receipt: SetupDelivery
  mode: ChatTag['mode']
  prompt: string
  cwd: string
  authorize(): string
}

export function createForgeSetupOnboarding(options: ForgeSetupOnboardingOptions) {
  return new ForgeSetupOnboarding(options)
}
