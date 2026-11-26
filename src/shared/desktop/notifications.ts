/**
 * OS notifications. Main raises them (`src/main/notify/notifier.ts`) and, when the person clicks one, pushes where the
 * renderer should land on `notifications:navigate`. The renderer may only ask main to raise the two run events it
 * observes on `notifications:raise`, by ids: main reads every title itself, so no renderer text reaches a notification.
 */
import { z } from 'zod'
import { chatIdSchema } from '../agents/chat'
import type { CommandResult } from './api'

export const NOTIFICATION_CHANNELS = {
  /** Push (main → renderer): a `NavigateTarget` after the person clicks a notification. */
  navigate: 'notifications:navigate',
  /** Invoke (renderer → main): a `notificationRaiseSchema` request. */
  raise: 'notifications:raise'
} as const

const epicIdSchema = z.string().regex(/^ep_[0-9a-hjkmnp-tv-z]{26}$/)
const runIdSchema = z.string().regex(/^rn_[0-9a-hjkmnp-tv-z]{26}$/)
const folderSchema = z.string().min(1)

/** Where a clicked notification lands: a chat (optionally at a thread or prompt), an epic's checkpoint, or an epic. */
export const navigateTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('chat'),
    folder: folderSchema.nullable(),
    chatId: chatIdSchema,
    threadId: z.string().min(1).optional(),
    promptId: z.string().min(1).optional()
  }),
  z.strictObject({ kind: z.literal('checkpoint'), folder: folderSchema, epicId: epicIdSchema }),
  z.strictObject({ kind: z.literal('epic'), folder: folderSchema, epicId: epicIdSchema })
])

export type NavigateTarget = z.infer<typeof navigateTargetSchema>

export const notificationRaiseSchema = z.strictObject({
  folder: folderSchema,
  kind: z.enum(['checkpoint_ready', 'run_failed']),
  epicId: epicIdSchema,
  runId: runIdSchema
})

type NotificationRaiseRequest = z.infer<typeof notificationRaiseSchema>

/**
 * `window.dm.notifications`: `raise` asks main to notify a run event the renderer observed (main validates it and
 * reads the epic title itself); `onNavigate` receives where a clicked notification lands, each push validated and an
 * invalid one dropped. Returns its unsubscribe.
 */
export interface NotificationsApi {
  raise(request: NotificationRaiseRequest): Promise<CommandResult<null>>
  onNavigate(listener: (target: NavigateTarget) => void): () => void
}
