/**
 * Raises OS notifications for attention events in main. The "Notifications & approvals" settings gate each event and
 * whether to notify while the app is focused; a key shows once per 10 minutes. Clicking one brings the window forward
 * and pushes its `NavigateTarget` on `notifications:navigate`.
 *
 * Electron's `Notification` and windows arrive as dependencies, so tests drive the whole lifecycle with fakes.
 */
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'
import type { ChatWindow } from '../agents/chatIpc'
import type { NotificationSettings } from '../../shared/desktop/notificationSettings'
import { NOTIFICATION_CHANNELS, type NavigateTarget } from '../../shared/desktop/notifications'

type NotificationKind = keyof NotificationSettings['events']

type NotificationDecision = { action: 'show' } | { action: 'skip'; reason: 'event_off' | 'focused' }

export function notificationDecision(
  event: { kind: NotificationKind },
  settings: NotificationSettings,
  focused: boolean
): NotificationDecision {
  if (!settings.events[event.kind]) return { action: 'skip', reason: 'event_off' }
  if (focused && settings.whenFocused === 'skip') return { action: 'skip', reason: 'focused' }
  return { action: 'show' }
}

/** What the notifier needs of Electron's `Notification` instance. */
interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

/** What the notifier needs of Electron's `Notification` class. */
interface NotificationClass {
  new (options: { title: string; body: string; silent: boolean }): NativeNotification
  isSupported(): boolean
}

/** What the notifier needs of a `BrowserWindow`. */
export interface NotifierWindow extends ChatWindow {
  isFocused(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface NotifierDeps {
  Notification: NotificationClass
  windows: () => readonly NotifierWindow[]
  /** Read at every event; main's stored settings, never a renderer copy. */
  settings: () => NotificationSettings
  /** `sendToWindows` from `chatIpc.ts`. */
  push: (windows: readonly ChatWindow[], channel: string, event: unknown) => void
  logger: { info(message: string): void }
  /** Milliseconds; Date.now in the app. */
  now: () => number
}

export interface NotificationEvent {
  kind: NotificationKind
  /** Dedupe key: a key that showed less than 10 minutes ago does not show again. */
  key: string
  title: string
  body: string
  target: NavigateTarget
}

const DEDUPE_MS = 10 * 60_000
const DEDUPE_LIMIT = 500
const TITLE_LIMIT = 64
const BODY_LIMIT = 180
// oxlint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g

/** Strips control characters (before masking, so removing one cannot join a token), masks secrets, then clips. */
function cleanText(text: string, limit: number): string {
  const masked = maskAgentChatSecretsDeep(text.replace(CONTROL_CHARACTERS, ' ').trim())
  const characters = Array.from(masked)
  return characters.length <= limit ? masked : `${characters.slice(0, limit - 1).join('')}…`
}

/** Answers true for a key that first showed less than 10 minutes ago; otherwise records it. Holds at most 500 keys. */
function createDedupe(): { seen(key: string, at: number): boolean; clear(): void } {
  /** Key → when it showed, oldest first. */
  const shown = new Map<string, number>()
  return {
    seen(key, at) {
      for (const [oldKey, shownAt] of shown) {
        if (at - shownAt < DEDUPE_MS) break
        shown.delete(oldKey)
      }
      if (shown.has(key)) return true
      shown.set(key, at)
      if (shown.size > DEDUPE_LIMIT) shown.delete(shown.keys().next().value as string)
      return false
    },
    clear: () => shown.clear()
  }
}

/** Brings the first open window forward and tells its page where to land. */
function land(deps: Pick<NotifierDeps, 'windows' | 'push'>, target: NavigateTarget): void {
  const window = deps.windows().find(candidate => !candidate.isDestroyed())
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  deps.push([window], NOTIFICATION_CHANNELS.navigate, target)
}

interface Notifier {
  notify(event: NotificationEvent): void
  /** How many shown notifications are still held, awaiting their click, close or failure. */
  held(): number
  dispose(): void
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const dedupe = createDedupe()
  /** Held until click, close or failure: on Windows an unreferenced notification can be collected before its click arrives. */
  const live = new Set<NativeNotification>()
  let loggedUnsupported = false
  let disposed = false

  const show = (event: NotificationEvent, sound: boolean): void => {
    const notification = new deps.Notification({
      title: cleanText(event.title, TITLE_LIMIT),
      body: cleanText(event.body, BODY_LIMIT),
      silent: !sound
    })
    live.add(notification)
    const release = (): void => { live.delete(notification) }
    notification.on('click', () => {
      release()
      if (!disposed) land(deps, event.target)
    })
    notification.on('close', release)
    notification.on('failed', release)
    notification.show()
  }

  return {
    notify(event) {
      if (disposed) return
      const settings = deps.settings()
      const focused = deps.windows().some(window => !window.isDestroyed() && window.isFocused())
      if (notificationDecision(event, settings, focused).action === 'skip') return
      if (!deps.Notification.isSupported()) {
        if (!loggedUnsupported) deps.logger.info('OS notifications are not supported on this system; skipping them.')
        loggedUnsupported = true
        return
      }
      if (!dedupe.seen(event.key, deps.now())) show(event, settings.sound)
    },
    held: () => live.size,
    dispose() {
      disposed = true
      live.clear()
      dedupe.clear()
    }
  }
}
