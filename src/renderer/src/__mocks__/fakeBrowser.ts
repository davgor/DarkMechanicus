import type { ChatImageRef } from '../../../shared/agents/chat'
import type { BrowserApi, BrowserState } from '../../../shared/browser/browserApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'

type Method = Exclude<keyof BrowserApi, 'onEvent'>
type Request<M extends Method> = Parameters<BrowserApi[M]>[0]

/**
 * Deterministic `window.dm.browser` for renderer tests: records every call, answers from settable state (`current`,
 * `siteList`, `captureResult`) or a `failures` entry, and `emit` pushes a state to every `onEvent` listener as main does.
 */
export class FakeBrowser implements BrowserApi {
  /** What `state` answers, for the chat it is asked about; `emit`, `setEnabled` and ownership calls update it. */
  current: BrowserState = {
    folder: null, chatId: 'chat_1', enabled: true, owner: 'none', ownerLabel: null, tab: null, signIn: null, pendingOrigin: null
  }
  /** The folder's always-allowed origins `sites` answers; `removeSite` drops one. */
  siteList: string[] = []
  captureResult: CommandResult<{ image: ChatImageRef }> = {
    ok: true, data: { image: { id: 'ci_00000000000000000000000000', mime: 'image/png', width: 1, height: 1, bytes: 68 } }
  }
  failures: Partial<Record<Method, DomainErrorShape>> = {}
  calls: { method: Method; args: unknown[] }[] = []
  private listeners = new Set<(state: BrowserState) => void>()

  callsOf(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  subscribers(): number { return this.listeners.size }

  emit(state: BrowserState): void {
    this.current = state
    for (const listener of this.listeners) listener(state)
  }

  onEvent(listener: (state: BrowserState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  state(request: Request<'state'>) {
    return this.call('state', request, () => ({ ok: true, data: { ...this.current, folder: request.folder, chatId: request.chatId } }))
  }

  setView(request: Request<'setView'>) { return this.done('setView', request) }
  navigate(request: Request<'navigate'>) { return this.done('navigate', request) }
  back(request: Request<'back'>) { return this.done('back', request) }
  forward(request: Request<'forward'>) { return this.done('forward', request) }
  reload(request: Request<'reload'>) { return this.done('reload', request) }

  stopAgent(request: Request<'stopAgent'>) {
    return this.call('stopAgent', request, () => this.own('stopped'))
  }

  takeControl(request: Request<'takeControl'>) {
    return this.call('takeControl', request, () => this.own('person'))
  }

  /** As main's ownership: the person's browser goes back to the agent, a stopped one to nobody; else nothing changes. */
  handBack(request: Request<'handBack'>) {
    const { owner } = this.current
    return this.call('handBack', request, () => this.own(owner === 'person' ? 'agent' : owner === 'stopped' ? 'none' : owner))
  }

  decideOrigin(request: Request<'decideOrigin'>) {
    return this.call('decideOrigin', request, () => {
      this.current = { ...this.current, pendingOrigin: null }
      return { ok: true, data: null }
    })
  }

  openSignIn(request: Request<'openSignIn'>) { return this.done('openSignIn', request) }
  closeSignIn(request: Request<'closeSignIn'>) { return this.done('closeSignIn', request) }

  capture(request: Request<'capture'>) {
    return this.call('capture', request, () => this.captureResult)
  }

  sites(request: Request<'sites'>) {
    return this.call('sites', request, () => ({ ok: true, data: [...this.siteList] }))
  }

  removeSite(request: Request<'removeSite'>) {
    return this.call('removeSite', request, () => {
      this.siteList = this.siteList.filter((origin) => origin !== request.origin)
      return { ok: true, data: null }
    })
  }

  setEnabled(request: Request<'setEnabled'>) {
    return this.call('setEnabled', request, () => {
      this.current = { ...this.current, enabled: request.enabled }
      return { ok: true, data: null }
    })
  }

  private own(owner: BrowserState['owner']): CommandResult<null> {
    this.current = { ...this.current, owner, ownerLabel: owner === 'person' ? 'You' : null }
    return { ok: true, data: null }
  }

  private done(method: Method, request: unknown): Promise<CommandResult<null>> {
    return this.call(method, request, () => ({ ok: true, data: null }))
  }

  private async call<T>(method: Method, request: unknown, produce: () => CommandResult<T>): Promise<CommandResult<T>> {
    this.calls.push({ method, args: [request] })
    const failure = this.failures[method]
    return failure ? { ok: false, error: failure } : produce()
  }
}
