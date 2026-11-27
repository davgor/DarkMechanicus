/** Structured CLI chat transport. Main owns launch details, identity and all pending prompts. */
import { z } from 'zod'
import type { CommandResult } from '../desktop/api'
import { CHAT_IMAGE_MAX_BYTES, chatIdSchema, chatImageIdSchema, chatImageRefSchema, chatItemSchema, type ChatImageRef } from './chat'
import { callsignSchema } from './callsign'

export { CHAT_IMAGE_MAX_BYTES, chatImageIdSchema, chatImageRefSchema }

export const GUI_PROTOCOL_KINDS = ['omp', 'claude'] as const
export const TODO_TOOL_NAMES = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'todo'] as const
export const AGENT_CHAT_CHANNELS = {
  start: 'agentChat:start', send: 'agentChat:send', interrupt: 'agentChat:interrupt',
  answer: 'agentChat:answer', setSurface: 'agentChat:setSurface', snapshot: 'agentChat:snapshot', event: 'agentChat:event',
  attention: 'agentChat:attention', stageImage: 'agentChat:stageImage', attachEvidence: 'agentChat:attachEvidence'
} as const

/** The most images one message may carry. */
export const CHAT_IMAGES_PER_MESSAGE = 4

const chatRef = { folder: z.string().nullable(), chatId: chatIdSchema }
const surfaceSchema = z.enum(['gui', 'terminal'])
const statusSchema = z.enum(['starting', 'idle', 'busy', 'exited', 'signed_out', 'failed'])
export const agentChatStartSchema = z.strictObject(chatRef)
/**
 * Images cross `send` only as the ids of images main already holds for the chat (`stageImage`); a message may be
 * images alone, but never empty.
 */
export const agentChatSendSchema = z.strictObject({
  ...chatRef, text: z.string().max(20_000), imageIds: z.array(chatImageIdSchema).max(CHAT_IMAGES_PER_MESSAGE).optional()
}).refine(request => request.text.length > 0 || (request.imageIds?.length ?? 0) > 0, { message: 'A message needs text or an image', path: ['text'] })
export const agentChatInterruptSchema = z.strictObject(chatRef)
export const agentChatAnswerSchema = z.strictObject({
  ...chatRef, promptId: z.string().min(1), optionId: z.string().min(1), text: z.string().max(20_000).optional()
})
export const agentChatSetSurfaceSchema = z.strictObject({ ...chatRef, surface: surfaceSchema })
export const agentChatSnapshotRequestSchema = z.strictObject(chatRef)
export const agentChatAttentionSchema = z.strictObject({ folder: z.string().nullable() })
/** The one channel image bytes cross: plain base64, validated as `uploadAttachment` validates it; main measures and keeps it. */
export const agentChatStageImageSchema = z.strictObject({
  ...chatRef,
  data: z.string().min(1).max(Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'data must be plain base64 with no data: prefix')
})
/** Attaches a chat image to a ticket or epic as evidence; only a chat of a tracked folder has a project to attach to. */
export const agentChatAttachEvidenceSchema = z.strictObject({
  folder: z.string(), chatId: chatIdSchema, imageId: chatImageIdSchema, epicId: z.string().min(1), ticketId: z.string().min(1).optional()
})

const promptFields = {
  id: z.string().min(1), title: z.string(), detail: z.string(),
  threadId: z.string().nullable(), callsign: callsignSchema.nullable(),
  /** False when a running worker may own the request but no thread correlation is known. */
  attributed: z.boolean(),
  arbitration: z.strictObject({ state: z.enum(['off', 'deciding', 'escalated']), reason: z.string().max(500).nullable() }),
  tool: z.strictObject({ name: z.string().min(1), input: z.record(z.string(), z.json()) }).optional()
}
export const pendingPromptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...promptFields, kind: z.literal('approval'), options: z.array(z.strictObject({ id: z.enum(['allow_once', 'allow_chat', 'deny']), label: z.string() })) }),
  z.strictObject({ ...promptFields, kind: z.literal('question'), options: z.array(z.strictObject({ id: z.string().min(1), label: z.string() })) })
])
export type PendingPrompt = z.infer<typeof pendingPromptSchema>

export const agentTodoTaskSchema = z.strictObject({
  id: z.string().max(64).nullable(), content: z.string().min(1).max(500), activeForm: z.string().max(500).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'abandoned']), blocker: z.string().max(500).optional()
})
export const agentTodoPhaseSchema = z.strictObject({ name: z.string().max(200), tasks: z.array(agentTodoTaskSchema).max(100) })
export type AgentTodoTask = z.infer<typeof agentTodoTaskSchema>
export type AgentTodoPhase = z.infer<typeof agentTodoPhaseSchema>
const threadTodos = { threadId: z.string().nullable(), phases: z.array(agentTodoPhaseSchema).max(20) }
/**
 * One prompt of a live GUI chat that waits on the person or the Magos: never tool input. `shown` marks the head of the
 * chat's queue (the prompt its card shows); prompts behind it keep the translator's `off` until they reach the head.
 */
export const attentionItemSchema = z.strictObject({
  chatId: chatIdSchema, promptId: z.string().min(1), kind: z.enum(['approval', 'question']),
  threadId: z.string().nullable(), callsign: callsignSchema.nullable(), arbitration: z.enum(['off', 'deciding', 'escalated']),
  title: z.string().max(200), shown: z.boolean()
})
export type AttentionItem = z.infer<typeof attentionItemSchema>

/** Item pushes upsert by item.id; deltas and per-thread to-dos are ephemeral. */
export const agentChatEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...chatRef, type: z.literal('item'), item: chatItemSchema }),
  z.strictObject({ ...chatRef, type: z.literal('delta'), itemId: z.string().min(1), kind: z.enum(['text', 'thinking']), text: z.string() }),
  z.strictObject({ ...chatRef, type: z.literal('stream_end'), itemId: z.string().min(1) }),
  z.strictObject({ ...chatRef, type: z.literal('status'), status: statusSchema, detail: z.string().optional() }),
  z.strictObject({ ...chatRef, type: z.literal('pending'), prompt: pendingPromptSchema.nullable() }),
  z.strictObject({ ...chatRef, type: z.literal('queued'), count: z.number().int().nonnegative() }),
  z.strictObject({ ...chatRef, type: z.literal('todos'), ...threadTodos }),
  /** The chat's whole attention list, on every queue or arbitration change; `[]` once it empties or the chat exits. */
  z.strictObject({ ...chatRef, type: z.literal('attention'), items: z.array(attentionItemSchema) })
])
export type AgentChatEvent = z.infer<typeof agentChatEventSchema>
export const agentChatSnapshotSchema = z.strictObject({
  items: z.array(chatItemSchema), status: statusSchema, pending: pendingPromptSchema.nullable(),
  queued: z.number().int().nonnegative(), surface: surfaceSchema, todos: z.array(z.strictObject(threadTodos))
})
export type AgentChatSnapshot = z.infer<typeof agentChatSnapshotSchema>

/** One invoke per request; subscriptions validate pushes before delivering them to the renderer. */
export interface AgentChatApi {
  start(request: z.infer<typeof agentChatStartSchema>): Promise<CommandResult<AgentChatSnapshot>>
  send(request: z.infer<typeof agentChatSendSchema>): Promise<CommandResult<null>>
  interrupt(request: z.infer<typeof agentChatInterruptSchema>): Promise<CommandResult<null>>
  answer(request: z.infer<typeof agentChatAnswerSchema>): Promise<CommandResult<null>>
  setSurface(request: z.infer<typeof agentChatSetSurfaceSchema>): Promise<CommandResult<AgentChatSnapshot>>
  snapshot(request: z.infer<typeof agentChatSnapshotRequestSchema>): Promise<CommandResult<AgentChatSnapshot>>
  onEvent(listener: (event: AgentChatEvent) => void): () => void
  /** Every waiting or deciding prompt of the folder's live GUI chats (null: project-less chats). */
  attention(request: z.infer<typeof agentChatAttentionSchema>): Promise<CommandResult<AttentionItem[]>>
  /** Hands main one image's bytes for the chat; main validates them and answers with the ref `send` may name. */
  stageImage(request: z.infer<typeof agentChatStageImageSchema>): Promise<CommandResult<{ image: ChatImageRef }>>
  attachEvidence(request: z.infer<typeof agentChatAttachEvidenceSchema>): Promise<CommandResult<{ commentId: string; attachmentId: string }>>
}
