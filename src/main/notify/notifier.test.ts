import type { BrowserWindow, Notification as ElectronNotification } from 'electron'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_EVENTS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import type { NavigateTarget } from '../../shared/desktop/notifications'
import { sendToWindows } from '../agents/chatIpc'
import { createNotifier, notificationDecision, type NotificationEvent, type NotifierDeps, type NotifierWindow } from './notifier'

class FakeNotification {
  static supported = true
  static instances: FakeNotification[] = []
  static isSupported(): boolean { return FakeNotification.supported }
  readonly listeners = new Map<string, Array<() => void>>()
  shown = false
  constructor(readonly options: { title: string; body: string; silent: boolean }) { FakeNotification.instances.push(this) }
  on(event: 'click' | 'close' | 'failed', listener: () => void): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
    return this
  }
  show(): void { this.shown = true }
  emit(event: 'click' | 'close' | 'failed'): void { for (const listener of this.listeners.get(event) ?? []) listener() }
}

function fakeWindow(state: { focused?: boolean; minimized?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  const window = {
    calls,
    send: vi.fn(),
    isDestroyed: () => state.destroyed ?? false,
    isFocused: () => state.focused ?? false,
    isMinimized: () => state.minimized ?? false,
    restore: () => { calls.push('restore') },
    show: () => { calls.push('show') },
    focus: () => { calls.push('focus') },
    webContents: { isDestroyed: () => false, send: (channel: string, ...args: unknown[]) => { calls.push('send'); window.send(channel, ...args) } }
  }
  return window
}

const target: NavigateTarget = { kind: 'chat', folder: 'C:\\work\\repo', chatId: 'chat-1', threadId: 'thread-1', promptId: 'prompt-1' }

function harness(options: { settings?: Partial<NotificationSettings>; windows?: NotifierWindow[] } = {}) {
  FakeNotification.supported = true
  FakeNotification.instances = []
  let clock = 1_000_000
  const settings: NotificationSettings = { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...options.settings }
  const windows = options.windows ?? [fakeWindow()]
  const deps: NotifierDeps = {
    Notification: FakeNotification,
    windows: () => windows,
    settings: () => settings,
    push: vi.fn(sendToWindows),
    logger: { info: vi.fn() },
    now: () => clock
  }
  return { deps, settings, notifier: createNotifier(deps), advance: (ms: number) => { clock += ms } }
}

const event = (overrides: Partial<NotificationEvent> = {}): NotificationEvent =>
  ({ kind: 'approval_needed', key: 'prompt:prompt-1', title: 'Acolyte:DM-1 needs you', body: 'wants to run: npm test', target, ...overrides })

describe('notificationDecision', () => {
  it('gates each kind by its own event toggle', () => {
    for (const kind of NOTIFICATION_EVENTS) {
      const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
      settings.events[kind] = false
      expect(notificationDecision({ kind }, settings, false)).toEqual({ action: 'skip', reason: 'event_off' })
      for (const other of NOTIFICATION_EVENTS.filter(candidate => candidate !== kind)) {
        expect(notificationDecision({ kind: other }, settings, false)).toEqual({ action: 'show' })
      }
    }
  })

  it('skips while focused only when whenFocused is skip', () => {
    const skip = { ...DEFAULT_NOTIFICATION_SETTINGS, whenFocused: 'skip' as const }
    const notify = { ...DEFAULT_NOTIFICATION_SETTINGS, whenFocused: 'notify' as const }
    expect(notificationDecision({ kind: 'question' }, skip, true)).toEqual({ action: 'skip', reason: 'focused' })
    expect(notificationDecision({ kind: 'question' }, skip, false)).toEqual({ action: 'show' })
    expect(notificationDecision({ kind: 'question' }, notify, true)).toEqual({ action: 'show' })
  })
})

describe('createNotifier gates', () => {
  it('shows nothing for a kind whose toggle is off and shows the others', () => {
    const h = harness({ settings: { events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, run_failed: false } } })
    h.notifier.notify(event({ kind: 'run_failed', key: 'run_failed:rn_1' }))
    expect(FakeNotification.instances).toEqual([])
    h.notifier.notify(event({ kind: 'checkpoint_ready', key: 'checkpoint_ready:rn_1' }))
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.shown).toBe(true)
  })

  it('shows nothing while a window is focused with skip, and shows with notify', () => {
    const focused = fakeWindow({ focused: true })
    const h = harness({ windows: [fakeWindow({ destroyed: true }), focused] })
    h.notifier.notify(event())
    expect(FakeNotification.instances).toEqual([])
    h.settings.whenFocused = 'notify'
    h.notifier.notify(event())
    expect(FakeNotification.instances).toHaveLength(1)
  })

  it('treats a destroyed focused window as unfocused', () => {
    harness({ windows: [fakeWindow({ focused: true, destroyed: true })] }).notifier.notify(event())
    expect(FakeNotification.instances).toHaveLength(1)
  })

  it('shows a key once within 10 minutes and again after', () => {
    const h = harness()
    h.notifier.notify(event())
    h.advance(10 * 60_000 - 1)
    h.notifier.notify(event())
    expect(FakeNotification.instances).toHaveLength(1)
    h.notifier.notify(event({ key: 'prompt:prompt-2' }))
    expect(FakeNotification.instances).toHaveLength(2)
    h.advance(1)
    h.notifier.notify(event())
    expect(FakeNotification.instances).toHaveLength(3)
  })
})

describe('createNotifier dedupe bound, sound and text', () => {
  it('holds at most 500 keys, forgetting the oldest first', () => {
    const h = harness()
    for (let index = 0; index <= 500; index += 1) h.notifier.notify(event({ key: `key:${index}` }))
    expect(FakeNotification.instances).toHaveLength(501)
    h.notifier.notify(event({ key: 'key:500' }))
    expect(FakeNotification.instances).toHaveLength(501)
    h.notifier.notify(event({ key: 'key:0' }))
    expect(FakeNotification.instances).toHaveLength(502)
  })

  it('sets silent from the sound setting', () => {
    const h = harness({ settings: { sound: true } })
    h.notifier.notify(event({ key: 'a' }))
    h.settings.sound = false
    h.notifier.notify(event({ key: 'b' }))
    expect(FakeNotification.instances.map(notification => notification.options.silent)).toEqual([false, true])
  })

  it('masks a planted grant token, drops control characters and clips title and body', () => {
    const grant = `dmg_${'a1'.repeat(16)}`
    harness().notifier.notify(event({ title: `${'T'.repeat(70)}\u0007`, body: `key\u0000 ${grant}\r\nnext ${'b'.repeat(300)}` }))
    const [shown] = FakeNotification.instances
    expect(shown?.options.title).toBe(`${'T'.repeat(63)}…`)
    expect(shown?.options.body).not.toContain('dmg_')
    expect(shown?.options.body).toContain('[grant token masked]')
    expect(shown?.options.body).not.toMatch(/\p{Cc}/u)
    expect(shown?.options.body.startsWith('key  [grant token masked] next bbb')).toBe(true)
    expect(Array.from(shown?.options.body ?? '')).toHaveLength(180)
    expect(shown?.options.body.endsWith('…')).toBe(true)
  })
})

describe('createNotifier click', () => {
  it('on click restores the minimized window, shows and focuses it, then pushes the exact target to it', () => {
    const closed = fakeWindow({ destroyed: true })
    const window = fakeWindow({ minimized: true })
    const other = fakeWindow()
    const h = harness({ windows: [closed, window, other] })
    h.notifier.notify(event())
    FakeNotification.instances[0]?.emit('click')
    expect(window.calls).toEqual(['restore', 'show', 'focus', 'send'])
    expect(window.send).toHaveBeenCalledExactlyOnceWith('notifications:navigate', target)
    expect(closed.calls).toEqual([])
    expect(other.calls).toEqual([])
  })

  it('does not restore a window that is not minimized', () => {
    const window = fakeWindow()
    harness({ windows: [window] }).notifier.notify(event())
    FakeNotification.instances[0]?.emit('click')
    expect(window.calls).toEqual(['show', 'focus', 'send'])
  })
})

describe('createNotifier lifetime', () => {
  it('holds each live notification until its click, close or failure', () => {
    const h = harness()
    h.notifier.notify(event({ key: 'a' }))
    h.notifier.notify(event({ key: 'b' }))
    h.notifier.notify(event({ key: 'c' }))
    expect(h.notifier.held()).toBe(3)
    const [a, b, c] = FakeNotification.instances
    a?.emit('close')
    expect(h.notifier.held()).toBe(2)
    b?.emit('click')
    expect(h.notifier.held()).toBe(1)
    c?.emit('failed')
    expect(h.notifier.held()).toBe(0)
  })

  it('shows nothing on an unsupported platform and logs it once', () => {
    const h = harness()
    FakeNotification.supported = false
    h.notifier.notify(event({ key: 'a' }))
    h.notifier.notify(event({ key: 'b' }))
    expect(FakeNotification.instances).toEqual([])
    expect(h.deps.logger.info).toHaveBeenCalledOnce()
  })

  it('after dispose shows nothing, releases everything and ignores a late click', () => {
    const window = fakeWindow()
    const h = harness({ windows: [window] })
    h.notifier.notify(event())
    h.notifier.dispose()
    expect(h.notifier.held()).toBe(0)
    FakeNotification.instances[0]?.emit('click')
    h.notifier.notify(event({ key: 'other' }))
    expect(window.calls).toEqual([])
    expect(FakeNotification.instances).toHaveLength(1)
  })
})

describe('Electron seams', () => {
  it("accepts Electron's Notification class and BrowserWindow", () => {
    expectTypeOf<typeof ElectronNotification>().toExtend<NotifierDeps['Notification']>()
    expectTypeOf<BrowserWindow>().toExtend<NotifierWindow>()
  })
})
