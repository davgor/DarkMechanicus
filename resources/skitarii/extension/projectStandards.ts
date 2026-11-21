import type { DmClient } from './dmClient'
import { inertJson, type MailApi } from './messaging'

const TYPE = 'dm-project-delivery-standards'
const PROMPTS = ['planned', 'ticket', 'sprint', 'epic'] as const

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

/** OMP calls context immediately before each model request, including continuations in a running session.
 * The launch descriptor pins get_project to a single grant and repository. Never consult the shell cwd,
 * a peer mailbox, a chat transcript, or an earlier successful read for project authority. */
export function attachProjectStandards(pi: Pick<MailApi, 'on'>, client: Pick<DmClient, 'run'>): void {
  pi.on('context', async event => {
    if (!record(event) || !Array.isArray(event.messages)) return
    const messages = event.messages.filter(message => !(record(message) && message.role === 'custom' && message.customType === TYPE))
    const result = await client.run('get_project', {})
    const guidance = result.ok ? projectGuidance(result.data) : undefined
    if (guidance === undefined) {
      if (result.ok || result.error.code === 'not_initialized') {
        return messages.length === event.messages.length ? undefined : { messages }
      }
      return { messages: [...messages, {
        role: 'custom', customType: TYPE, display: false, attribution: 'agent', timestamp: 0,
        content: 'Dark Mechanicus could not read the current Delivery Standards for this chat. Read get_project successfully before planning or delivering project work.'
      }] }
    }
    return { messages: [...messages, {
      role: 'custom', customType: TYPE, display: false, attribution: 'agent', timestamp: 0, content: guidance
    }] }
  })
}
