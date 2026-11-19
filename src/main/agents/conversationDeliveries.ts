import { dirname, join } from 'node:path'
import { z } from 'zod'
import { nodeChatStoreFs, type ChatStoreFs } from './chatStore'

const deliverySchema = z.object({
  messageId: z.string().min(1),
  folder: z.string().min(1),
  chatId: z.string().min(1).nullable(),
  state: z.enum(['delivered', 'failed', 'opened']),
  problem: z.string().nullable(),
  at: z.string().min(1)
})

export type ConversationDelivery = z.infer<typeof deliverySchema>

export interface ConversationDeliveries {
  record(entry: ConversationDelivery): void
  forMessages(folder: string, ids: readonly string[]): Map<string, ConversationDelivery>
}

interface Context {
  file: string
  fs: ChatStoreFs
  entries: Map<string, ConversationDelivery> | null
  checkedTail: boolean
}

function keyOf(folder: string, messageId: string): string {
  return `${folder}\u0000${messageId}`
}

function load(context: Context): Map<string, ConversationDelivery> {
  if (context.entries !== null) return context.entries
  const entries = new Map<string, ConversationDelivery>()
  let text: string
  try {
    text = context.fs.readFile(context.file)
  } catch {
    context.entries = entries
    return entries
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = deliverySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.set(keyOf(parsed.data.folder, parsed.data.messageId), parsed.data)
    } catch {
      // A malformed line, including a torn final append, has no delivery to apply.
    }
  }
  context.entries = entries
  return entries
}

function record(context: Context, entry: ConversationDelivery): void {
  const validated = deliverySchema.parse(entry)
  let prefix = ''
  if (!context.checkedTail) {
    context.fs.mkdirp(dirname(context.file))
    try {
      const text = context.fs.readFile(context.file)
      prefix = text !== '' && !text.endsWith('\n') ? '\n' : ''
    } catch {
      // A missing ledger starts with its first record.
    }
  }
  context.fs.appendFile(context.file, `${prefix}${JSON.stringify(validated)}\n`)
  context.checkedTail = true
  load(context).set(keyOf(validated.folder, validated.messageId), validated)
}

/** Creates the machine-local delivery ledger under userData/agents/conversation-deliveries.jsonl. */
export function createConversationDeliveries(options: { userData: string; fs?: ChatStoreFs }): ConversationDeliveries {
  const context: Context = {
    file: join(options.userData, 'agents', 'conversation-deliveries.jsonl'),
    fs: options.fs ?? nodeChatStoreFs,
    entries: null,
    checkedTail: false
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
    }
  }
}
