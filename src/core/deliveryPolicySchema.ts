export { baselineDeliveryPolicy } from '../shared/domain/standardsPrompts'
import { z } from 'zod'

const rule = z.string().trim().min(1).max(4000)
const prompt = z.string().max(65536).refine(value => value.trim().length > 0, 'Enter a nonempty prompt.')
const ticket = z.strictObject({ verification: rule, acceptance: rule, integration: rule, delivery: rule })
const closeout = z.strictObject({ push: z.boolean(), verifyRemote: z.boolean(), cleanTemporaryFiles: z.boolean(), removeWorktree: z.boolean() })
export const deliveryPolicy = z.strictObject({
  kanban: ticket, epicTicket: ticket, sprint: rule,
  kanbanCloseout: closeout, epicCloseout: closeout,
  prompts: z.strictObject({ planned: prompt, ticket: prompt, sprint: prompt, epic: prompt }).optional(),
  setupDecision: z.enum(['defaults', 'agent', 'edited']).optional()
})
export const storedDeliveryPolicy = z.strictObject({ revision: z.number().int().positive(), policy: deliveryPolicy })
