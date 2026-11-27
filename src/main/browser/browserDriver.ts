/**
 * Drives one agent tab through `webContents.debugger` (CDP 1.3) with the commands DM-851 recorded as GO
 * (docs/reports/agent-browser.md, item 1): the AX tree, box model, mouse and key events, focus and text insertion. Two
 * read-only DOM commands are added: `DOM.scrollIntoViewIfNeeded` before a click, and `DOM.describeNode`, because the AX
 * tree carries no password marker (Electron 42: a password input is a plain `textbox` whose value is bullets).
 *
 * - Refs `e1…` name the nodes the last `read` listed and map to their `backendDOMNodeId`. They stay stable within a
 *   document and reset on every main-frame navigation, after which an old ref fails with `stale_ref`.
 * - `read` never returns a value: password fields show as `textbox (password)`, so neither a password nor its length
 *   (the AX value is one bullet per character) ever leaves the driver. Page text is wrapped as untrusted.
 * - Every op checks the ownership signal before and after each command; an aborted signal rejects with its reason
 *   (`stopped` or `paused_by_person`) and no further command is sent. Each op has a 20 s deadline and no retry.
 */
import type { Debugger, NativeImage } from 'electron'
import { BrowserControlError, type BrowserErrorCode, type BROWSER_KEYS } from '../../shared/browser/browserControl'
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'

type BrowserKey = (typeof BROWSER_KEYS)[number]

/** The parts of a `WebContents` the driver uses; a real `WebContents` satisfies it. */
export interface DriverContents {
  readonly debugger: Pick<Debugger, 'attach' | 'detach' | 'isAttached' | 'sendCommand'> & {
    on(event: 'detach', listener: () => void): unknown
  }
  capturePage(): Promise<Pick<NativeImage, 'isEmpty' | 'toPNG'>>
  on(event: 'did-navigate', listener: () => void): unknown
}

interface DriverOptions {
  /** The agent session's ownership signal; once aborted, no op attaches or sends a command again. */
  signal?: AbortSignal
}
/** A per-op ownership signal (`beginAgentOp`), combined with the driver's own. */
interface OpOptions {
  signal?: AbortSignal
}
interface ReadResult {
  untrusted: true
  content: string
  truncated: boolean
}

export interface BrowserDriver {
  attach(): void
  detach(): void
  read(args: { mode: 'text' | 'tree'; maxChars?: number }, opts?: OpOptions): Promise<ReadResult>
  click(ref: string, opts?: OpOptions): Promise<void>
  type(args: { ref: string; text: string; submit?: boolean }, opts?: OpOptions): Promise<void>
  press(key: BrowserKey, opts?: OpOptions): Promise<void>
  screenshot(opts?: OpOptions): Promise<Buffer>
}

export const OP_DEADLINE_MS = 20_000
const PROTOCOL_VERSION = '1.3'
const DEFAULT_MAX_CHARS = 48_000
const NAME_LIMIT = 300

interface AxValue { value?: unknown }
interface AxNode {
  nodeId: string
  parentId?: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  properties?: { name: string; value?: AxValue }[]
  backendDOMNodeId?: number
}
interface RefTarget { backendNodeId: number; password: boolean }
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Roles that only carry structure or text already listed by their parent. */
const SKIPPED_ROLES: Record<string, true> = {
  none: true, generic: true, presentation: true, InlineTextBox: true, LineBreak: true, ListMarker: true, RootWebArea: true,
  WebArea: true, Ignored: true
}
/** Roles listed even without a name, because the agent can act on them. */
const INTERACTIVE_ROLES: Record<string, true> = {
  button: true, link: true, textbox: true, searchbox: true, checkbox: true, radio: true, combobox: true, listbox: true,
  option: true, menuitem: true, slider: true, spinbutton: true, switch: true, tab: true
}
/** Roles a password input can take; only these are checked against the DOM. */
const EDITABLE_ROLES: Record<string, true> = { textbox: true, searchbox: true, combobox: true, spinbutton: true }

const KEYS: Record<BrowserKey, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 }
}

export function createBrowserDriver(contents: DriverContents, options: DriverOptions = {}): BrowserDriver {
  return new Driver(contents, options.signal)
}

class Driver implements BrowserDriver {
  private attached = false
  private refs = new Map<string, RefTarget>()
  private refOf = new Map<number, string>()

  constructor(private readonly contents: DriverContents, private readonly signal: AbortSignal | undefined) {
    contents.debugger.on('detach', () => { this.attached = false })
    contents.on('did-navigate', () => { this.refs = new Map(); this.refOf = new Map() })
  }

  attach(): void {
    if (this.signal?.aborted === true) throw new BrowserControlError(codeOfReason(this.signal.reason))
    if (this.attached && this.contents.debugger.isAttached()) return
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach(PROTOCOL_VERSION)
    this.attached = true
  }

  detach(): void {
    this.attached = false
    if (!this.contents.debugger.isAttached()) return
    try { this.contents.debugger.detach() } catch { /* already detached by the target */ }
  }

  read(args: { mode: 'text' | 'tree'; maxChars?: number }, opts?: OpOptions): Promise<ReadResult> {
    return this.run(opts, async (send) => {
      const tree = await send('Accessibility.getFullAXTree') as { nodes?: AxNode[] }
      const byId = new Map((tree.nodes ?? []).map((node) => [node.nodeId, node]))
      const nodes = (tree.nodes ?? []).filter((node) => listed(node, byId))
      const passwords = new Set<number>()
      for (const node of nodes) {
        const id = node.backendDOMNodeId as number
        if (EDITABLE_ROLES[stringOf(node.role)] !== true) continue
        // A field gone between the tree and the check is shown as a password field rather than failing the read.
        const password = await isPasswordInput(send, id).catch((error: unknown) => {
          if (error instanceof BrowserControlError && error.code === 'stale_ref') return true
          throw error
        })
        if (password) passwords.add(id)
      }
      return this.project(nodes.filter((node) => !insidePassword(node, byId, passwords)), passwords, args)
    })
  }

  click(ref: string, opts?: OpOptions): Promise<void> {
    return this.run(opts, async (send) => {
      const { backendNodeId } = this.target(ref)
      await sendForNode(send, 'DOM.scrollIntoViewIfNeeded', backendNodeId)
      const { model } = await sendForNode(send, 'DOM.getBoxModel', backendNodeId) as { model: { content: number[] } }
      const { x, y } = quadCentre(model.content)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
    })
  }

  type(args: { ref: string; text: string; submit?: boolean }, opts?: OpOptions): Promise<void> {
    return this.run(opts, async (send) => {
      if (maskAgentChatSecretsDeep(args.text) !== args.text) throw new BrowserControlError('secret_refused')
      const target = this.target(args.ref)
      // The page can turn a field into a password field after the read, so the DOM is asked again before typing.
      if (target.password || await isPasswordInput(send, target.backendNodeId)) throw new BrowserControlError('password_field')
      await sendForNode(send, 'DOM.focus', target.backendNodeId)
      await send('Input.insertText', { text: args.text })
      if (args.submit === true) await sendKey(send, 'Enter')
    })
  }

  press(key: BrowserKey, opts?: OpOptions): Promise<void> {
    return this.run(opts, (send) => sendKey(send, key))
  }

  /** An empty image, or a capture Chromium could not produce (`UnknownVizError` before the first paint), is `navigation_failed`. */
  screenshot(opts?: OpOptions): Promise<Buffer> {
    return this.run(opts, async (_send, guard) => {
      const capture = this.contents.capturePage().catch(() => { throw new BrowserControlError('navigation_failed') })
      const image = await guard(capture)
      if (image.isEmpty()) throw new BrowserControlError('navigation_failed')
      return image.toPNG()
    })
  }

  /** One op: attach if needed, then run `body` under the combined signals and the op deadline. */
  private async run<T>(opts: OpOptions | undefined, body: (send: Send, guard: <R>(step: Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
    const op = new OpScope([this.signal, opts?.signal])
    try {
      op.check()
      this.attach()
      const send: Send = (method, params) => op.guard(this.contents.debugger.sendCommand(method, params) as Promise<unknown>)
      return await op.guard(body(send, (step) => op.guard(step)))
    } finally {
      op.dispose()
    }
  }

  private target(ref: string): RefTarget {
    const target = this.refs.get(ref)
    if (target === undefined) throw new BrowserControlError('stale_ref')
    return target
  }

  private refFor(backendNodeId: number, password: boolean): string {
    let ref = this.refOf.get(backendNodeId)
    if (ref === undefined) {
      ref = `e${this.refs.size + 1}`
      this.refOf.set(backendNodeId, ref)
    }
    this.refs.set(ref, { backendNodeId, password })
    return ref
  }

  private project(nodes: readonly AxNode[], passwords: ReadonlySet<number>, args: { mode: 'text' | 'tree'; maxChars?: number }): ReadResult {
    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
    let content = ''
    for (const node of nodes) {
      const password = passwords.has(node.backendDOMNodeId as number)
      const line = args.mode === 'text' ? textLine(node, password) : this.treeLine(node, password)
      if (line === null) continue
      const next = content === '' ? line : `${content}\n${line}`
      if (next.length > maxChars) return { untrusted: true, content, truncated: true }
      content = next
    }
    return { untrusted: true, content, truncated: false }
  }

  private treeLine(node: AxNode, password: boolean): string {
    const ref = this.refFor(node.backendDOMNodeId as number, password)
    const role = stringOf(node.role)
    return password ? `[${ref}] ${role} (password)` : `[${ref}] ${role} "${nameOf(node)}"`
  }
}

/** One op's abort scope: the ownership signals plus the op deadline; once it aborts, no further command is sent. */
class OpScope {
  private readonly controller = new AbortController()
  private readonly timer: NodeJS.Timeout
  private readonly signals: AbortSignal[]
  private readonly onAbort = (event: Event): void => { this.controller.abort(codeOfReason((event.target as AbortSignal).reason)) }

  constructor(signals: readonly (AbortSignal | undefined)[]) {
    this.signals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
    for (const signal of this.signals) {
      if (signal.aborted) this.controller.abort(codeOfReason(signal.reason))
      else signal.addEventListener('abort', this.onAbort, { once: true })
    }
    this.timer = setTimeout(() => this.controller.abort('timeout'), OP_DEADLINE_MS)
  }

  check(): void {
    if (this.controller.signal.aborted) throw new BrowserControlError(this.controller.signal.reason as BrowserErrorCode)
  }

  /** Checks before and after `step`, and rejects at once when the scope aborts while `step` is pending. */
  async guard<T>(step: Promise<T>): Promise<T> {
    this.check()
    const signal = this.controller.signal
    let onAbort = (): void => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new BrowserControlError(signal.reason as BrowserErrorCode)) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([step, aborted])
      this.check()
      return value
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    for (const signal of this.signals) signal.removeEventListener('abort', this.onAbort)
  }
}

/** Ownership aborts with `stopped` or `paused_by_person`; any other reason counts as stopped. */
function codeOfReason(reason: unknown): BrowserErrorCode {
  return reason === 'paused_by_person' || reason === 'timeout' ? reason : 'stopped'
}

/** A node-addressed DOM command; a node the page no longer has is a stale ref, not an internal failure. */
async function sendForNode(send: Send, method: string, backendNodeId: number): Promise<unknown> {
  try {
    return await send(method, { backendNodeId })
  } catch (error) {
    if (error instanceof BrowserControlError) throw error
    if (/no node|detached from document|could not compute box model/i.test(String((error as Error)?.message))) throw new BrowserControlError('stale_ref')
    throw error
  }
}

async function sendKey(send: Send, key: BrowserKey): Promise<void> {
  const { text, ...entry } = KEYS[key]
  const event = { key, ...entry, nativeVirtualKeyCode: entry.windowsVirtualKeyCode }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(text === undefined ? {} : { text }) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}

function quadCentre(quad: readonly number[]): { x: number; y: number } {
  if (quad.length < 8) throw new BrowserControlError('stale_ref')
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 }
}

/**
 * Whether the node is an `<input type="password">`. The AX tree has no password marker (its value is one bullet per
 * character), so the DOM is asked; only the `type` attribute is looked at. Fails closed: an unreadable node counts as
 * a password field, while a node the page no longer has is a stale ref and an abort stays an abort.
 */
async function isPasswordInput(send: Send, backendNodeId: number): Promise<boolean> {
  let described: { node?: { localName?: string; attributes?: string[] } }
  try {
    described = await sendForNode(send, 'DOM.describeNode', backendNodeId) as typeof described
  } catch (error) {
    if (error instanceof BrowserControlError) throw error
    return true
  }
  const attributes = described.node?.attributes ?? []
  const typeAt = attributes.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'type')
  return described.node?.localName === 'input' && typeAt !== -1 && attributes[typeAt + 1]?.trim().toLowerCase() === 'password'
}

/**
 * A node worth a line: not ignored, backed by a DOM node, and either named or actionable. Text repeating its parent's
 * name is dropped, and so is the text inside an editable field: it is the field's value (bullets for a password).
 */
function listed(node: AxNode, byId: ReadonlyMap<string, AxNode>): boolean {
  if (node.ignored === true || node.backendDOMNodeId === undefined) return false
  const role = stringOf(node.role)
  if (SKIPPED_ROLES[role] === true) return false
  const name = nameOf(node)
  if (role === 'StaticText') return listedText(node, name, byId)
  return name !== '' || INTERACTIVE_ROLES[role] === true
}

function listedText(node: AxNode, name: string, byId: ReadonlyMap<string, AxNode>): boolean {
  if (name === '' || node.properties?.some((property) => property.name === 'editable') === true) return false
  const parent = node.parentId === undefined ? undefined : byId.get(node.parentId)
  return parent === undefined || nameOf(parent) !== name
}

/**
 * Whether any ancestor is a password field. Its descendants (the inner text holding the bullets) are dropped whatever
 * Chromium's `editable` flag says; the walk is bounded by the node count so a malformed parent cycle cannot loop.
 */
function insidePassword(node: AxNode, byId: ReadonlyMap<string, AxNode>, passwords: ReadonlySet<number>): boolean {
  let parent = node.parentId === undefined ? undefined : byId.get(node.parentId)
  for (let steps = 0; parent !== undefined && steps < byId.size; steps += 1) {
    if (parent.backendDOMNodeId !== undefined && passwords.has(parent.backendDOMNodeId)) return true
    parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId)
  }
  return false
}

function textLine(node: AxNode, password: boolean): string | null {
  const name = nameOf(node)
  return password || name === '' ? null : name
}

function stringOf(value: AxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value : ''
}

/** A page-authored name on one line: controls stripped, whitespace collapsed, quotes escaped, clipped. */
function nameOf(node: AxNode): string {
  const flat = stringOf(node.name).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.slice(0, NAME_LIMIT).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
