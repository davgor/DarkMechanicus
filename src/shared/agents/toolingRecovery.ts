import { z } from 'zod'

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const text = z.string().trim().min(1).max(4000)
const toolingDiagnosticSchema = z.strictObject({
  command: z.string().min(1).max(120), code: z.string().max(120), message: text,
  reproduction: text, expected: text,
  // Deliberately flat and bounded: never attach transcripts, files, environment or grant descriptors.
  arguments: z.record(z.string().max(80), z.union([z.string().max(256), z.number(), z.boolean(), z.null()])).refine(value => Object.keys(value).length <= 20).optional()
})
export const toolingRecoveryInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('escalate'), incidentId: identity, diagnostic: toolingDiagnosticSchema }),
  z.strictObject({ action: z.literal('status'), incidentId: identity }),
  z.strictObject({ action: z.literal('message'), incidentId: identity, messageId: identity, text }),
  z.strictObject({ action: z.literal('available'), incidentId: identity, version: z.string().min(1).max(80), evidence: text }),
  z.strictObject({ action: z.literal('resume'), incidentId: identity })
])
export type ToolingRecoveryInput = z.infer<typeof toolingRecoveryInputSchema>
export const toolingRecoveryResultSchema = z.strictObject({
  incidentId: identity, blocked: z.boolean(), cardId: z.string().nullable(), repairChatId: z.string().nullable(),
  sourceFolder: z.string().nullable(), callerAddress: z.string(), repairAddress: z.string().nullable(),
  startup: z.enum(['not_started', 'running', 'failed']), prompt: z.enum(['pending', 'uncertain', 'delivered']),
  connection: z.enum(['unavailable', 'pending', 'connected']), messageDelivery: z.enum(['pending', 'delivered']).optional(),
  problem: z.string().max(4000).nullable()
})
export type ToolingRecoveryResult = z.infer<typeof toolingRecoveryResultSchema>
