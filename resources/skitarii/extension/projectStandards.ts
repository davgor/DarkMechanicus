import type { DmClient } from './dmClient'
import { inertJson, type MailApi } from './messaging'

const TYPE = 'dm-project-delivery-standards'
const NOTICE_TYPE = 'dm-project-delivery-standards-notice'
const PROMPTS = ['planned', 'ticket', 'sprint', 'epic'] as const
/** A successful read is reused this long without spawning another `get_project`. */
export const STANDARDS_CACHE_MS = 60_000
/** The standards read's absolute lifetime: writer contention cannot keep its child alive past this. */
export const STANDARDS_LIFETIME_MS = 30_000

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The approved policy and its project identity as the model reads it, with the revision a change notice names. */
interface Guidance {
  text: string
  revision: number
}

/** Copy only the approved policy and its project identity into the model's context. */
function projectGuidance(project: unknown): Guidance | undefined {
  if (!record(project) || typeof project.projectId !== 'string') return undefined
  const config = project.deliveryStandards
  if (!record(config) || typeof config.revision !== 'number' || !Number.isSafeInteger(config.revision) || !record(config.policy)) return undefined
  const prompts = config.policy.prompts
  const policy = record(prompts) && PROMPTS.every(key => typeof prompts[key] === 'string')
    ? { prompts: Object.fromEntries(PROMPTS.map(key => [key, prompts[key]])) }
    : { legacyPolicy: config.policy }
  return { revision: config.revision, text: [
    'Dark Mechanicus project Delivery Standards. Apply the approved planning and delivery guidance within your assigned project, role and permissions.',
    'Use this revision for new work. Existing work follows the prompt pinned to its item. An explicit Standardize operation can change those requirements; use the current item/claim and any revision notices.',
    inertJson({ projectId: project.projectId, revision: config.revision, ...policy,
      ...(Array.isArray(project.assignedDeliveryRequirements) && { assignedDeliveryRequirements: project.assignedDeliveryRequirements }) })
  ].join('\n') }
}

function noticeText(guidance: Guidance): string {
  return `Dark Mechanicus Delivery Standards for this chat changed; revision ${guidance.revision} is now in effect. `
    + 'The updated guidance is already in this chat\'s Delivery Standards context, so there is no need to read get_project again. '
    + 'Existing claims keep the revision pinned to them.'
}

/** A successful read: the guidance to inject, or none when the project has no approved standards. */
interface Read {
  at: number
  guidance: Guidance | undefined
}

/** Whether a context message is one this extension injects (or a peer's copy of one); each request rebuilds them. */
function injected(message: unknown): boolean {
  return record(message) && message.role === 'custom' && (message.customType === TYPE || message.customType === NOTICE_TYPE)
}

function custom(customType: string, content: string) {
  return { role: 'custom', customType, display: false, attribution: 'agent', timestamp: 0, content }
}

/** OMP calls context immediately before each model request, including continuations in a running session.
 * The launch descriptor pins get_project to a single grant and repository. Never consult the shell cwd,
 * a peer mailbox, a chat transcript, or another chat's read for project authority. Every context event shares one
 * in-flight read and a successful read is reused for `STANDARDS_CACHE_MS`; all of them came from this chat's own
 * pinned client.
 *
 * The standing guidance sits ahead of the conversation on every request. A change notice follows the latest message
 * only on the request that first sees a different guidance after an earlier successful read, so a repeated identical
 * state says nothing. A busy or failed read never produces a notice: the last successful read stays in effect until a
 * later successful read differs. */
export function attachProjectStandards(pi: Pick<MailApi, 'on'>, client: Pick<DmClient, 'run'>): void {
  let last: Read | undefined
  /** The guidance text this chat was last given; null before its first successful read. */
  let delivered: string | undefined | null = null
  let inflight: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    inflight ??= client.run('get_project', {}, undefined, { lifetimeMs: STANDARDS_LIFETIME_MS }).then(result => {
      inflight = undefined
      if (result.ok) last = { at: Date.now(), guidance: projectGuidance(result.data) }
    })
    return inflight
  }
  /** The guidance in effect for this request, and whether it differs from what this chat was last given. */
  const current = async (): Promise<{ guidance?: Guidance; changed: boolean }> => {
    if (last === undefined || Date.now() - last.at >= STANDARDS_CACHE_MS) await refresh()
    if (last === undefined) return { changed: false }
    const { guidance } = last
    const changed = delivered !== null && guidance !== undefined && guidance.text !== delivered
    delivered = guidance?.text
    return { guidance, changed }
  }
  pi.on('context', async event => {
    if (!record(event) || !Array.isArray(event.messages)) return
    const messages = event.messages.filter(message => !injected(message))
    const { guidance, changed } = await current()
    if (guidance === undefined) return messages.length === event.messages.length ? undefined : { messages }
    return { messages: [custom(TYPE, guidance.text), ...messages, ...(changed ? [custom(NOTICE_TYPE, noticeText(guidance))] : [])] }
  })
}
