import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { chatIdSchema } from '../../shared/agents/chat'
import { agentIdSchema } from '../../shared/desktop/agentKinds'

const operation = z.strictObject({
  id: z.uuid(),
  agent: agentIdSchema.nullable(),
  agentSignature: z.string().nullable(),
  chatId: chatIdSchema.nullable(),
  delivery: z.enum(['pending', 'attempted', 'submitted', 'failed']),
  message: z.string().nullable()
})
const execution = operation.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), checkout: z.string().min(1) })
const record = z.strictObject({
  id: z.uuid(), member: z.string().min(1), repository: z.string().min(1), identity: z.string().min(1),
  onboarding: operation, execution: execution.optional()
})
const journal = z.strictObject({ version: z.literal(1), records: z.array(record).max(2000) })

export type SetupDelivery = z.infer<typeof operation>
export type SetupExecution = z.infer<typeof execution>
export type SetupIntent = z.infer<typeof record>

function load(file: string): Map<string, SetupIntent> {
  let source: string
  try { source = readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  try {
    const parsed = journal.parse(JSON.parse(source))
    const records = new Map(parsed.records.map(entry => [entry.identity, entry]))
    if (records.size === parsed.records.length) return records
  } catch { /* Existing unusable state cannot become permission for a new launch. */ }
  throw new Error('The local Forge setup journal cannot be read. Preserve it before continuing.')
}

function replace(file: string, records: Map<string, SetupIntent>): void {
  const value = journal.parse({ version: 1, records: [...records.values()] })
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID()
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}

export class ForgeSetupJournal {
  private records: Map<string, SetupIntent> | undefined
  constructor(private readonly file: string) {}

  get(identity: string): SetupIntent | undefined {
    return (this.records ??= load(this.file)).get(identity)
  }

  save(intent: SetupIntent): void {
    const next = new Map(this.records ?? load(this.file))
    next.set(intent.identity, structuredClone(intent))
    replace(this.file, next)
    this.records = next
  }
}
