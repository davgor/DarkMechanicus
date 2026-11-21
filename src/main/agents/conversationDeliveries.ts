import { dirname, join } from 'node:path'
import { z } from 'zod'
import { nodeChatStoreFs, type ChatStoreFs } from './chatStore'

const deliverySchema = z.object({
  messageId: z.string().min(1),
  folder: z.string().min(1),
  chatId: z.string().min(1).nullable(),
  state: z.enum(['pending', 'delivered', 'failed', 'opened']),
  problem: z.string().nullable(),
  at: z.string().min(1),
  source: z.enum(['peer', 'board', 'recovery']).optional(),
  text: z.string().optional(),
  bodyHash: z.string().optional(),
  entryId: z.string().optional(),
  /** Physical input was attempted, not proven inserted; never automatically replay it without a host receipt. */
  inputUncertain: z.boolean().optional()
})

export type ConversationDelivery = z.infer<typeof deliverySchema>

export interface ConversationDeliveries {
  record(entry: ConversationDelivery): void
  forMessages(folder: string, ids: readonly string[]): Map<string, ConversationDelivery>
  /** Durable board bodies not yet proven in host context, oldest accepted first. */
  pending(): ConversationDelivery[]
  /** Observed proof is bound to source, recipient, folder and message identity. */
  proof(folder: string, chatId: string, source: 'peer' | 'board' | 'recovery', messageId: string): ConversationDelivery | undefined
}

interface Context {
  file: string
  fs: ChatStoreFs
  onChanged(folder: string, chatId: string): void
  entries: Map<string, ConversationDelivery> | null
  checkedTail: boolean
  separator: string
}

function keyOf(folder: string, messageId: string, source: 'peer' | 'board' | 'recovery' = 'board', chatId: string | null = null): string {
  return source === 'board' ? `${folder}\u0000board\u0000${messageId}` : `${folder}\u0000${source}\u0000${chatId}\u0000${messageId}`
}

function load(context: Context): Map<string, ConversationDelivery> {
  if (context.entries !== null) return context.entries
  const entries = new Map<string, ConversationDelivery>()
  let text: string
  try {
    text = context.fs.readFile(context.file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    context.entries = entries
    return entries
  }
  context.separator = text !== '' && !text.endsWith('\n') ? '\n' : ''
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = deliverySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.set(keyOf(parsed.data.folder, parsed.data.messageId, parsed.data.source, parsed.data.chatId), parsed.data)
    } catch {
      // A malformed line, including a torn final append, has no delivery to apply.
    }
  }
  context.entries = entries
  return entries
}

function record(context: Context, entry: ConversationDelivery): void {
  const validated = deliverySchema.parse(entry)
  const entries = load(context)
  const key = keyOf(validated.folder, validated.messageId, validated.source, validated.chatId)
  const prior = entries.get(key)
  if (!context.checkedTail) context.fs.mkdirp(dirname(context.file))
  context.fs.appendFile(context.file, `${context.separator}${JSON.stringify(validated)}\n`)
  context.checkedTail = true
  context.separator = ''
  entries.set(key, validated)
  if (validated.source !== 'peer' && validated.chatId !== null &&
      (prior === undefined || prior.chatId !== validated.chatId || prior.state !== validated.state ||
       prior.problem !== validated.problem || prior.inputUncertain !== validated.inputUncertain)) {
    context.onChanged(validated.folder, validated.chatId)
  }
}

/** Creates the machine-local delivery ledger under userData/agents/conversation-deliveries.jsonl. */
export function createConversationDeliveries(options: {
  userData: string
  fs?: ChatStoreFs
  onChanged(folder: string, chatId: string): void
}): ConversationDeliveries {
  const context: Context = {
    file: join(options.userData, 'agents', 'conversation-deliveries.jsonl'),
    fs: options.fs ?? nodeChatStoreFs,
    onChanged: options.onChanged,
    entries: null,
    checkedTail: false,
    separator: ''
  }
  return {
    record: (entry) => record(context, entry),
    forMessages: (folder, ids) => {
      const entries = load(context)
      const found = new Map<string, ConversationDelivery>()
      for (const id of ids) {
        const entry = entries.get(keyOf(folder, id))
        if (entry !== undefined) found.set(id, { ...entry })
      }
      return found
    },
    pending: () => [...load(context).values()].filter((entry) => entry.source !== 'peer' && entry.state === 'pending'),
    proof: (folder, chatId, source, messageId) => {
      const entry = load(context).get(keyOf(folder, messageId, source, chatId))
      return entry?.chatId === chatId && (entry.source ?? 'board') === source ? entry : undefined
    }
  }
}
