import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { toolingRecoveryInputSchema } from '../../shared/agents/toolingRecovery'

const message = z.object({ id: z.string(), text: z.string(), recipient: z.enum(['caller', 'repair']) })
const incidentSchema = z.object({
  id: z.string(), callerIncidentId: z.string(), caller: z.object({ folder: z.string().nullable(), id: z.string() }),
  callerGeneration: z.string(), version: z.string(), diagnostic: toolingRecoveryInputSchema.options[0].shape.diagnostic,
  blocked: z.boolean(), held: z.boolean(), sourceFolder: z.string().nullable(), sourceIdentity: z.string().nullable(), cardId: z.string().nullable(),
  repairChatId: z.string().nullable(), startup: z.enum(['not_started', 'running', 'failed']),
  // Set before issuing a startup: a crash may have spawned a process, so never blindly replay it.
  startAttempted: z.boolean(), problem: z.string().nullable(),
  messages: z.array(message), available: z.object({ version: z.string(), evidence: z.string() }).nullable()
})
export type RecoveryIncident = z.infer<typeof incidentSchema>
export interface RecoveryStore {
  get(id: string): RecoveryIncident | null
  put(incident: RecoveryIncident): void
}
/** Single desktop writer, private machine-local state. Corrupt/unreadable state fails closed, never becomes an empty journal. */
export function createRecoveryStore(options: { userData: string }): RecoveryStore {
  const file = join(options.userData, 'agents', 'tooling-recovery.json')
  let records: RecoveryIncident[]
  try { records = z.array(incidentSchema).parse(JSON.parse(readFileSync(file, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    records = []
  }
  return {
    get: id => { const record = records.find(item => item.id === id); return record === undefined ? null : structuredClone(record) },
    put: incident => {
      const validated = incidentSchema.parse(incident)
      const next = records.filter(item => item.id !== validated.id).concat(validated)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 })
      renameSync(file + '.tmp', file)
      records = next
    }
  }
}
