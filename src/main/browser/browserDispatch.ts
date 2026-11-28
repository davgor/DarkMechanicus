/**
 * Runs each agent op the browser pipe admitted on the calling chat's agent tab. The pipe has already checked the live
 * grant and `browser.drive`; this adds the browser's own rules:
 *
 * - `browser_status` reads `{enabled, owner, tab, pendingOrigin}` with no transition and never creates a tab; the
 *   Sign-in tab and its prompt never appear (red-team Fix 47).
 * - Every other op is refused with `browser_disabled` while the browser is off and `no_tab` with no window to hold
 *   the view (Fix 46), then admitted by ownership (`paused_by_person`/`stopped` pass through). It runs in one scope:
 *   the pipe's cancel, the ownership lease and a 20 s deadline. Each op waits for the tab's first paint inside that
 *   scope (`whenReady` has no deadline of its own), so a view that never paints fails with `timeout` (R19-7).
 * - `browser_screenshot` refuses a view not shown on the window (`view_hidden`, DM-851); the PNG is kept as a chat
 *   image and one 0600 copy is written for the CLI to stage (`browserShots.ts`).
 * - `browser_read` fits its reply in 60 KiB of JSON, cutting at a code point (`truncated: true`, R19-5).
 * - Replies mask grant and claim tokens; the owner badge comes from the chat record and its bound tickets (R19-2).
 */
import type { Capability } from '../../core/authz'
import type { ChatImageRef } from '../../shared/agents/chat'
import {
  BrowserControlError, type BrowserArgs, type BrowserErrorCode, type BrowserOperation, type BrowserReadResult,
  type BrowserStatusResult
} from '../../shared/browser/browserControl'
import type { BrowserState } from '../../shared/browser/browserApi'
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'
import type { ControlBinding, ControlDispatcher, ControlOperationContext } from '../control/controlServer'
import { OP_DEADLINE_MS, type BrowserDriver } from './browserDriver'
import type { AgentTab, BrowserChatRef, BrowserHost } from './browserHost'
import { ownerLabel, type BrowserOwnership, type OwnerLabelChat } from './browserOwnership'
import type { BrowserShots } from './browserShots'

/** A live chat grant's binding; `verifyAuthority` asks the grant's own workspace (`verifyChatGrant`). */
export interface BrowserControlBinding extends ControlBinding {
  verifyAuthority?(capability: Capability): Promise<void>
}

type Owner = BrowserState['owner']

interface BrowserDispatchDeps {
  host: Pick<BrowserHost, 'ensureAgentTab' | 'agentTab' | 'agentPendingOrigin' | 'navigate' | 'isShown' | 'refresh'>
  ownership: Pick<BrowserOwnership, 'owner' | 'beginAgentOp'>
  driverFor(tab: AgentTab): BrowserDriver
  settings: { enabled(): boolean }
  shots: Pick<BrowserShots, 'write'>
  images: { put(ref: BrowserChatRef, bytes: Uint8Array): Promise<ChatImageRef> }
  /** Whether a main window exists to hold the views. */
  hasWindow(): boolean
  /** The chat record (the chat store), or null once it is gone. */
  chatFor(ref: BrowserChatRef): OwnerLabelChat | null
  /** The ticket keys of the attempts bound to the chat's threads. */
  boundTicketKeys(ref: BrowserChatRef): Promise<ReadonlySet<string>>
}

export interface BrowserDispatcher {
  dispatch: ControlDispatcher<BrowserOperation, BrowserControlBinding>
  /** The host's `ownerLabel`: the badge for the chat from its record, the agent's last `as` and its bound tickets. */
  ownerLabel(ref: BrowserChatRef, owner: Owner): string | null
}

/** The JSON-encoded `browser_read` reply's budget, below the pipe's 64 KiB reply limit. */
const READ_REPLY_BYTES = 61_440
const READ_CONTENT_CHARS = 48_000
/** What the reply adds around `data`, measured with the longest request id. */
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, requestId: 'x'.repeat(128), ok: true, data: null })) - 'null'.length

type ScopeCode = Extract<BrowserErrorCode, 'stopped' | 'paused_by_person' | 'timeout' | 'cancelled'>

function scopeCode(reason: unknown): ScopeCode {
  return reason === 'stopped' || reason === 'paused_by_person' || reason === 'timeout' ? reason : 'cancelled'
}

class OpScope {
  private readonly controller = new AbortController()
  private readonly timer: NodeJS.Timeout
  private readonly onAbort = (event: Event): void => { this.controller.abort(scopeCode((event.target as AbortSignal).reason)) }

  constructor(private readonly signals: readonly AbortSignal[]) {
    for (const signal of signals) {
      if (signal.aborted) this.controller.abort(scopeCode(signal.reason))
      else signal.addEventListener('abort', this.onAbort, { once: true })
    }
    this.timer = setTimeout(() => this.controller.abort('timeout'), OP_DEADLINE_MS)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** `step`, or the scope's code once it aborts: at once, and in place of whatever `step` rejected with. */
  async guard<T>(step: Promise<T>): Promise<T> {
    const signal = this.controller.signal
    let onAbort = (): void => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new BrowserControlError(scopeCode(signal.reason)))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([step, aborted])
    } catch (error) {
      if (signal.aborted) throw new BrowserControlError(scopeCode(signal.reason))
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    for (const signal of this.signals) signal.removeEventListener('abort', this.onAbort)
  }
}

/** `text`'s first `length` UTF-16 units, never ending inside a surrogate pair. */
function cut(text: string, length: number): string {
  const clipped = text.slice(0, length)
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped
}

/** The read result whose reply fits `READ_REPLY_BYTES`: the longest `content` prefix that does, marked truncated. */
function fitRead(result: BrowserReadResult): BrowserReadResult {
  const budget = READ_REPLY_BYTES - ENVELOPE_BYTES
  const bytes = (value: BrowserReadResult): number => Buffer.byteLength(JSON.stringify(value))
  if (result.content.length <= READ_CONTENT_CHARS && bytes(result) <= budget) return result
  let low = 0
  let high = Math.min(result.content.length, READ_CONTENT_CHARS)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes({ ...result, content: cut(result.content, mid), truncated: true }) <= budget) low = mid
    else high = mid - 1
  }
  return { ...result, content: cut(result.content, low), truncated: true }
}

interface Op<Name extends keyof BrowserArgsMap> {
  ref: BrowserChatRef
  args: BrowserArgsMap[Name]
  tab: AgentTab
  scope: OpScope
}
type BrowserArgsMap = { [Name in BrowserOperation['op']]: BrowserArgs<Name> }
type AgentOpName = Exclude<BrowserOperation['op'], 'browser_status'>

class Dispatcher {
  /** Each chat's last `as` and bound ticket keys, for its owner badge. */
  private readonly callers = new Map<string, { as: string | undefined; keys: ReadonlySet<string> }>()

  constructor(private readonly deps: BrowserDispatchDeps) {}

  ownerLabel(ref: BrowserChatRef, owner: Owner): string | null {
    const chat = this.deps.chatFor(ref)
    if (chat === null) return owner === 'person' ? 'You' : null
    const caller = this.callers.get(ref.chatId)
    return ownerLabel({ owner, chat, as: caller?.as, boundTicketKeys: caller?.keys ?? new Set() })
  }

  async dispatch(operation: BrowserOperation, context: ControlOperationContext<BrowserControlBinding>): Promise<unknown> {
    const ref: BrowserChatRef = { folder: context.binding.folder, chatId: context.binding.chatId }
    if (operation.op === 'browser_status') return this.status(ref)
    return maskAgentChatSecretsDeep(await this.agentOp(ref, operation, context.signal))
  }

  private status(ref: BrowserChatRef): BrowserStatusResult {
    const { host, ownership, settings } = this.deps
    return maskAgentChatSecretsDeep({
      enabled: settings.enabled(), owner: ownership.owner(ref.chatId), tab: host.agentTab(ref)?.state() ?? null,
      pendingOrigin: host.agentPendingOrigin(ref)
    })
  }

  private async agentOp(ref: BrowserChatRef, operation: Exclude<BrowserOperation, { op: 'browser_status' }>, cancel: AbortSignal): Promise<unknown> {
    const { deps } = this
    if (!deps.settings.enabled()) throw new BrowserControlError('browser_disabled')
    if (!deps.hasWindow()) throw new BrowserControlError('no_tab')
    const lease = deps.ownership.beginAgentOp(ref.chatId)
    if (!lease.ok) throw new BrowserControlError(lease.code)
    const scope = new OpScope([cancel, lease.signal])
    try {
      await this.recordCaller(ref, operation.args.as, scope)
      const op = { ref, args: operation.args, tab: deps.host.ensureAgentTab(ref), scope }
      return await this.run(operation.op, op)
    } finally {
      scope.dispose()
      lease.end()
    }
  }

  /** Keeps the caller's `as` and the chat's bound tickets for the badge, then pushes the new owner. */
  private async recordCaller(ref: BrowserChatRef, as: string | undefined, scope: OpScope): Promise<void> {
    const keys = await scope.guard(this.deps.boundTicketKeys(ref).catch(() => new Set<string>()))
    this.callers.set(ref.chatId, { as, keys })
    this.deps.host.refresh(ref)
  }

  private run(name: AgentOpName, op: Op<AgentOpName>): Promise<unknown> {
    switch (name) {
      case 'browser_navigate': return this.navigate(op as Op<'browser_navigate'>)
      case 'browser_read': return this.read(op as Op<'browser_read'>)
      case 'browser_click': return this.act(op, (driver, signal) => driver.click((op as Op<'browser_click'>).args.ref, { signal }))
      case 'browser_type': return this.act(op, (driver, signal) => driver.type((op as Op<'browser_type'>).args, { signal }))
      case 'browser_press': return this.act(op, (driver, signal) => driver.press((op as Op<'browser_press'>).args.key, { signal }))
      case 'browser_screenshot': return this.screenshot(op)
    }
  }

  /** Loads through the host's origin policy, then waits for the new page's first paint. */
  private async navigate({ ref, args, tab, scope }: Op<'browser_navigate'>): Promise<unknown> {
    const result = await scope.guard(this.deps.host.navigate(ref, args.url, 'agent'))
    if (!result.ok) throw new BrowserControlError(result.code)
    await scope.guard(tab.whenReady(scope.signal))
    return { tab: tab.state() }
  }

  private async read({ args, tab, scope }: Op<'browser_read'>): Promise<BrowserReadResult> {
    await scope.guard(tab.whenReady(scope.signal))
    const read = await this.deps.driverFor(tab).read({ mode: args.mode, maxChars: args.maxChars }, { signal: scope.signal })
    const { url, title } = tab.state()
    return fitRead(maskAgentChatSecretsDeep({ url, title, ...read }))
  }

  private async act({ tab, scope }: Op<AgentOpName>, step: (driver: BrowserDriver, signal: AbortSignal) => Promise<void>): Promise<unknown> {
    await scope.guard(tab.whenReady(scope.signal))
    await step(this.deps.driverFor(tab), scope.signal)
    return { tab: tab.state() }
  }

  private async screenshot({ ref, tab, scope }: Op<AgentOpName>): Promise<unknown> {
    const { host, images, shots } = this.deps
    if (!host.isShown(ref)) throw new BrowserControlError('view_hidden')
    await scope.guard(tab.whenReady(scope.signal))
    const png = await this.deps.driverFor(tab).screenshot({ signal: scope.signal })
    if (!host.isShown(ref)) throw new BrowserControlError('view_hidden')
    const image = await scope.guard(images.put(ref, png))
    const path = await scope.guard(shots.write(png))
    return { image, url: tab.state().url, path }
  }
}

export function createBrowserDispatcher(deps: BrowserDispatchDeps): BrowserDispatcher {
  const dispatcher = new Dispatcher(deps)
  return {
    dispatch: (operation, context) => dispatcher.dispatch(operation, context),
    ownerLabel: (ref, owner) => dispatcher.ownerLabel(ref, owner)
  }
}
