import type { DmCallResult, DmClient } from './dmClient'
import { inertJson, type MailApi } from './messaging'

const TYPE = 'dm-project-delivery-standards'
const PROMPTS = ['planned', 'ticket', 'sprint', 'epic'] as const
/** A successful read is reused this long without spawning another `get_project`. */
export const STANDARDS_CACHE_MS = 60_000
/** When a refresh fails, a successful read younger than this is injected instead of the failure notice. */
export const STANDARDS_STALE_MS = 10 * 60_000
/** The standards read's absolute lifetime: writer contention cannot keep its child alive past this. */
export const STANDARDS_LIFETIME_MS = 30_000
const UNREADABLE = 'Dark Mechanicus could not read the current Delivery Standards for this chat. Read get_project successfully before planning or delivering project work.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Copy only the approved policy and its project identity into the model's context. */
function projectGuidance(project: unknown): string | undefined {
  if (!record(project) || typeof project.projectId !== 'string') return undefined
  const config = project.deliveryStandards
  if (!record(config) || !Number.isSafeInteger(config.revision) || !record(config.policy)) return undefined
  const prompts = config.policy.prompts
  const policy = record(prompts) && PROMPTS.every(key => typeof prompts[key] === 'string')
    ? { prompts: Object.fromEntries(PROMPTS.map(key => [key, prompts[key]])) }
    : { legacyPolicy: config.policy }
  return [
    'Dark Mechanicus project Delivery Standards. Apply the approved planning and delivery guidance within your assigned project, role and permissions.',
    'Use this revision for new work. Existing work follows the prompt pinned to its item. An explicit Standardize operation can change those requirements; use the current item/claim and any revision notices.',
    inertJson({ projectId: project.projectId, revision: config.revision, ...policy,
      ...(Array.isArray(project.assignedDeliveryRequirements) && { assignedDeliveryRequirements: project.assignedDeliveryRequirements }) })
  ].join('\n')
}

/** A successful read: the guidance to inject, or none when the project has no approved standards. */
interface Read {
  at: number
  guidance: string | undefined
}

/** OMP calls context immediately before each model request, including continuations in a running session.
 * The launch descriptor pins get_project to a single grant and repository. Never consult the shell cwd,
 * a peer mailbox, a chat transcript, or another chat's read for project authority. Every context event shares one
 * in-flight read, a successful read is reused for `STANDARDS_CACHE_MS`, and a failed refresh falls back to a
 * successful read younger than `STANDARDS_STALE_MS`; all of them came from this chat's own pinned client. */
export function attachProjectStandards(pi: Pick<MailApi, 'on'>, client: Pick<DmClient, 'run'>): void {
  let last: Read | undefined
  let inflight: Promise<DmCallResult<unknown>> | undefined
  const read = (): Promise<DmCallResult<unknown>> => {
    inflight ??= client.run('get_project', {}, undefined, { lifetimeMs: STANDARDS_LIFETIME_MS }).then(result => {
      inflight = undefined
      if (result.ok) last = { at: Date.now(), guidance: projectGuidance(result.data) }
      return result
    })
    return inflight
  }
  /** The guidance this event injects (a fresh, cached or stale read, or the failure notice); undefined injects none. */
  const current = async (): Promise<string | undefined> => {
    if (last !== undefined && Date.now() - last.at < STANDARDS_CACHE_MS) return last.guidance
    const result = await read()
    if (result.ok) return projectGuidance(result.data)
    if (result.error.code === 'not_initialized') return undefined
    return last !== undefined && Date.now() - last.at < STANDARDS_STALE_MS ? last.guidance : UNREADABLE
  }
  pi.on('context', async event => {
    if (!record(event) || !Array.isArray(event.messages)) return
    const messages = event.messages.filter(message => !(record(message) && message.role === 'custom' && message.customType === TYPE))
    const guidance = await current()
    if (guidance === undefined) return messages.length === event.messages.length ? undefined : { messages }
    return { messages: [...messages, {
      role: 'custom', customType: TYPE, display: false, attribution: 'agent', timestamp: 0, content: guidance
    }] }
  })
}
