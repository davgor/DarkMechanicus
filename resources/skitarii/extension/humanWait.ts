import { randomUUID } from 'node:crypto'
import type { DmCallResult, DmClient } from './dmClient'
import { inertJson, mailSupport, type MailApi, type MailContext, type ToolResult } from './messaging'
import { openHumanWait } from './humanWaitLease'

const TEN_MINUTES = 600_000
const STATUS = 'dark-mechanicus-human-wait'
const WAIT_TOOL = 'wait_for_human'
const CONTACT_TOOL = 'contact_waiting_human'

type ContactClient = Pick<DmClient, 'run'>
interface Request { question: string; why: string; client: ContactClient | undefined }
interface Wait extends Request {
  id: string
  expired: boolean
  wakeRequested: boolean
  contactUsed: boolean
  release?: () => void
}

interface ContactRoutes {
  home: string | undefined
  client?: ContactClient
  projects?: readonly { project: string; client: ContactClient }[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const main = (ctx: MailContext | undefined): ctx is MailContext => ctx?.agent?.kind === 'main' && ctx.hasUI
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max
const answer = (message: string, isError?: true): ToolResult => ({ content: [{ type: 'text', text: message }], isError })

function continuing(event: unknown): boolean {
  return record(event) && (event.willContinue === true || event.awaitingAsyncWork === true)
}

function completed(event: unknown): boolean {
  if (!record(event) || !Array.isArray(event.messages)) return false
  const last: unknown = event.messages.at(-1)
  return record(last) && last.role === 'assistant' && last.stopReason === 'stop'
}

const stale = 'This human wait is stale, not authorized in this chat, or already handled. Do not send or repeat a reminder.'
const unavailable = 'External human contact was refused or unavailable. No external message was sent.'
const unconfirmed = 'External human contact could not be confirmed. Do not claim delivery or retry.'
const contactRefusals = ['unauthorized', 'operation_unavailable', 'no_grant', 'descriptor_missing', 'descriptor_invalid', 'descriptor_stale']

function queued(result: DmCallResult<unknown>, id: string): boolean {
  return result.ok && record(result.data) && result.data.questionId === id && result.data.state === 'queued'
}

function canContact(wait: Wait | undefined, params: unknown): wait is Wait {
  return wait?.wakeRequested === true && !wait.contactUsed && record(params) && params.waitId === wait.id &&
    Object.keys(params).length === 1
}

function selectRoute(routes: ContactRoutes, requested: unknown): ContactClient | undefined | false {
  const { projects } = routes
  if (requested !== undefined) return projects?.find(item => item.project === requested)?.client ?? false
  if (projects === undefined) return routes.client
  if (projects.length > 1) return false
  return projects[0]?.client
}

class HumanWait {
  #context: MailContext | undefined
  #running = false
  #candidate: Request | undefined
  #wait: Wait | undefined
  #timer: NodeJS.Timeout | undefined

  constructor(private readonly send: NonNullable<MailApi['sendUserMessage']>, private readonly routes: ContactRoutes) {}

  clear(): void {
    this.#candidate = undefined
    clearTimeout(this.#timer)
    this.#timer = undefined
    const current = this.#wait
    this.#wait = undefined
    current?.release?.()
    if (current) this.#status(undefined)
  }

  reset(ctx: MailContext): void {
    this.clear()
    this.#running = false
    this.#context = ctx
  }

  start(ctx: MailContext): void {
    this.#context = ctx
    this.#running = true
  }

  end(event: unknown): void {
    if (!this.#running || continuing(event)) return
    this.#running = false
    const request = this.#candidate
    this.#candidate = undefined
    const current = this.#wait
    if (current) {
      // Let the host finish its end hook before attempting an idle aside.
      if (current.expired && !current.wakeRequested) this.#timer = setTimeout(() => this.#wake(current), 0)
    } else if (request && completed(event)) this.#arm(request)
  }

  #status(status: string | undefined): void {
    this.#context?.ui.setStatus?.(STATUS, status)
  }

  #arm(request: Request): void {
    const current: Wait = { ...request, id: randomUUID(), expired: false, wakeRequested: false, contactUsed: false }
    this.#wait = current
    this.#status('Waiting for human reply')
    this.#timer = setTimeout(() => {
      if (this.#wait !== current || current.expired) return
      current.expired = true
      this.#status('Human disengaged · reply outstanding')
      this.#wake(current)
    }, TEN_MINUTES)
  }

  #wake(current: Wait): void {
    if (this.#wait !== current || this.#running || !current.expired || current.wakeRequested) return
    current.wakeRequested = true
    const request = inertJson({ question: current.question, reason: current.why })
    const prompt = `Dark Mechanicus: this conversation has an unanswered human request after ten minutes.\n${request}\n` +
      `Use ${CONTACT_TOOL} once with waitId ${current.id} to check whether the request is still outstanding and use the authorized contact path. ` +
      'If stale, do not repeat it. If contact is unavailable, leave this specific request and why it blocks progress in the conversation, and say no external message was sent. ' +
      'If queued, report that it was queued, not sent. Finish this turn still blocked; do not poll or take any further action now. ' +
      'On a later turn, use get_human_answer with the returned questionId to check for a reply. Do not re-arm this same wait. ' +
      'This is not human input, consent, checkpoint approval or permission to proceed.'
    void this.send(prompt, { deliverAs: 'aside', attribution: 'agent' }).catch(() => {
      if (this.#wait === current) this.#status('Human disengaged · wake unavailable; the request remains in chat')
    })
  }

  declare(params: unknown): ToolResult {
    if (!this.#running) return answer('Only an active main chat can record a human wait.', true)
    if (this.#wait) return answer('This conversation already has an outstanding human request. Do not re-arm it.', true)
    if (!record(params) || !text(params.question, 1500) || !text(params.why, 1500)) {
      return answer('Provide the exact question or action and why progress is blocked.', true)
    }
    const client = selectRoute(this.routes, params.project)
    if (client === false) return answer('Select an available authorized Forge World project route before recording the wait.', true)
    this.#candidate = { question: params.question.trim(), why: params.why.trim(), client }
    return answer(`Finish this turn with the request visible in chat: ${this.#candidate.question}\n\nWhy this blocks progress: ${this.#candidate.why}\n\nDo not contact the human externally while they are engaged.`)
  }

  async contact(params: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const current = this.#wait
    if (!canContact(current, params)) return answer(stale, true)
    current.contactUsed = true
    const { home } = this.routes
    if (!home || !current.client) return this.#notQueued(unavailable)
    try {
      current.release = openHumanWait(home, current.id, () => { if (this.#wait === current) this.clear() })
    } catch {
      return this.#notQueued(unavailable)
    }
    const result = await current.client.run('ask_human', {
      question: `${current.question}\n\nWhy this is blocking progress: ${current.why}`,
      responseRequired: true, humanEngaged: false, waitId: current.id
    }, signal)
    if (this.#wait !== current) return answer(stale, true)
    if (queued(result, current.id)) {
      return answer(`Request queued (not confirmed sent). Finish this turn still blocked; do not poll now. On a later turn, use get_human_answer with questionId ${current.id}. Consent and approval are still required.`)
    }
    current.release()
    current.release = undefined
    return this.#notQueued(!result.ok && contactRefusals.includes(result.error.code) ? unavailable : unconfirmed)
  }

  #notQueued(message: string): ToolResult {
    this.#status('Human disengaged · external contact unavailable or unconfirmed')
    return answer(message, true)
  }
}

/** Attach once per interactive OMP conversation, even if it has multiple project routes. */
export function attachHumanWait(pi: MailApi, routes: ContactRoutes): void {
  const support = mailSupport(pi)
  if (!support.ok || !pi.sendUserMessage || !pi.registerTool) return
  const wait = new HumanWait(pi.sendUserMessage.bind(pi), routes)
  for (const event of ['session_start', 'session_switch', 'session_clear', 'session_branch', 'session_tree', 'session_shutdown']) {
    pi.on(event, (_event, ctx) => { if (main(ctx)) wait.reset(ctx) })
  }
  pi.on('input', (event, ctx) => {
    if (main(ctx) && record(event) && (event.source === 'interactive' || event.source === 'rpc')) wait.clear()
  })
  pi.on('agent_start', (_event, ctx) => { if (main(ctx)) wait.start(ctx) })
  pi.on('agent_end', (event, ctx) => { if (main(ctx)) wait.end(event) })
  const { type } = support
  pi.registerTool({
    name: WAIT_TOOL,
    label: 'Wait for a human reply',
    description: 'Use only when you cannot proceed without a specific reply, decision, approval or action from the human. Record the exact request and why, then ask in your final chat response and finish the turn. Not for idle, tools, workers or a request already pending.',
    parameters: type.Object({
      question: type.String({ minLength: 1, maxLength: 1500, description: 'What exact input or action do you need?' }),
      why: type.String({ minLength: 1, maxLength: 1500, description: 'Why is it blocking progress?' }),
      ...(routes.projects === undefined ? {} : { project: type.Optional(type.String({ minLength: 1, maxLength: 256, description: 'Authorized Forge World project. Required when multiple project routes exist.' })) })
    }, { additionalProperties: false }),
    approval: 'read',
    loadMode: 'essential',
    execute: async (_id, params, ...[signal, , ctx]) => main(ctx) && !signal?.aborted ? wait.declare(params) : answer('Only an active main chat can record a human wait.', true)
  })
  pi.registerTool({
    name: CONTACT_TOOL,
    label: 'Contact the human about an expired wait',
    description: 'Only for a current Dark Mechanicus human-wait wake. Attempts one authorized Telegram request using the original question and reason. Does not grant approval or allow progress.',
    parameters: type.Object({ waitId: type.String({ minLength: 36, maxLength: 36 }) }, { additionalProperties: false }),
    approval: 'write',
    loadMode: 'essential',
    execute: async (_id, params, ...[signal, , ctx]) => main(ctx) && !signal?.aborted ? wait.contact(params, signal) : answer(stale, true)
  })
}
