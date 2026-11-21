import type { DeliveryPolicy } from '../shared/domain/deliveryPolicy'
import { z } from 'zod'

const rule = z.string().trim().min(1).max(4000)
const ticket = z.strictObject({ verification: rule, acceptance: rule, integration: rule, delivery: rule })
const closeout = z.strictObject({ push: z.boolean(), verifyRemote: z.boolean(), cleanTemporaryFiles: z.boolean(), removeWorktree: z.boolean() })
export const deliveryPolicy = z.strictObject({
  kanban: ticket, epicTicket: ticket, sprint: rule,
  kanbanCloseout: closeout, epicCloseout: closeout
})
export const storedDeliveryPolicy = z.strictObject({ revision: z.number().int().positive(), policy: deliveryPolicy })


const checks = {
  verification: 'Plan ticket-specific checks and expected passing evidence. Run them in the source checkout at the submitted revision.',
  acceptance: 'Inspect the submitted behavior and evidence against each acceptance criterion. Respect required approvals and retry grants.',
  integration: 'Integrate only accepted changes. Remove clean task-owned worktrees after confirming integration.',
  delivery: 'Verify the accepted revision reached its configured destination within existing delivery authority.'
}
const cleanup = { push: true, verifyRemote: true, cleanTemporaryFiles: true, removeWorktree: true }
export const baselineDeliveryPolicy: DeliveryPolicy = {
  kanban: { ...checks }, epicTicket: { ...checks, integration: 'Integrate the accepted revision into the epic worktree and verify it before cleaning the ticket worktree.' },
  sprint: 'Deliver one observable result per sprint. Verify PR checks, merge with required approvals and confirm delivery of that revision before advancing.',
  kanbanCloseout: { ...cleanup }, epicCloseout: { ...cleanup }
}
