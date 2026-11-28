/**
 * The `browser:*` IPC channels behind `window.dm.browser`: each takes one untrusted payload, validated by the strict
 * contract schemas (`shared/browser/browserApi.ts`), resolves the chat's folder through the folder registry
 * (`chatFolder`, as `agentChat:*` does) and answers a `CommandResult`. Register through the sender guard (`guardIpc`),
 * like every other channel; `browser:capture` is registered by the camera ticket, not here.
 *
 * - Stop, Take control and Hand back go through ownership and apply its effects on the chat's agent tab in the same
 *   tick: the debugger is detached and loading stopped before the handler first awaits anything.
 * - Back, Forward and Reload fire no `will-navigate`, so the target history entry is checked against the tab's sites
 *   first (`host.frameAllowed`: the folder's always list plus the tab's once set). One no longer allowed, after
 *   `removeSite` say, is opened through `host.navigate` instead, which raises the origin card; the tab never moves in
 *   history. The session's frame gate stays the backstop.
 * - A person's navigation the origin policy holds for a decision answers ok: the card is the answer.
 * - State reaches the windows on `browser:event`, validated; never a browser view.
 */
import type { IpcMain } from 'electron'
import type { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import {
  BROWSER_CHANNELS,
  browserChatSchema,
  browserDecideOriginSchema,
  browserNavigateSchema,
  browserOpenSignInSchema,
  browserRemoveSiteSchema,
  browserSetEnabledSchema,
  browserSetViewSchema,
  browserSitesSchema,
  browserStateSchema,
  type BrowserState
} from '../../shared/browser/browserApi'
import { BrowserControlError } from '../../shared/browser/browserControl'
import type { CommandResult } from '../../shared/desktop/api'
import { answer, chatFolder } from '../agents/chatHandlers'
import { sendToWindows, type ChatWindow } from '../agents/chatIpc'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { BrowserDriver } from './browserDriver'
import type { AgentTab, BrowserChatRef, BrowserHost, NavigateResult } from './browserHost'
import type { BrowserOwnership, BrowserOwnershipEffect } from './browserOwnership'
import type { BrowserSettings } from './browserSettings'
import type { SiteStore } from './siteStore'

/** An agent tab's history and loading controls; Electron's `WebContents` satisfies it. */
export interface PanelContents {
  readonly id: number
  readonly navigationHistory: {
    getActiveIndex(): number
    length(): number
    getEntryAtIndex(index: number): { url: string } | null
    goBack(): void
    goForward(): void
  }
  reload(): void
  stop(): void
}

interface BrowserIpcDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  host: Pick<BrowserHost, 'state' | 'setView' | 'navigate' | 'agentTab' | 'frameAllowed' | 'decideOrigin' | 'openSignIn' | 'closeSignIn' | 'refresh'>
  ownership: Pick<BrowserOwnership, 'stop' | 'takeControl' | 'handBack'>
  settings: Pick<BrowserSettings, 'setEnabled'>
  sites: Pick<SiteStore, 'list' | 'remove'>
  /** The tab's driver, which holds its debugger session. */
  driverFor(tab: AgentTab): Pick<BrowserDriver, 'detach'>
  /** The tab's own contents, for its history and loading. */
  contentsFor(tab: AgentTab): PanelContents
  onUnexpectedError?: (error: unknown) => void
}

type Handler<T> = (input: unknown) => Promise<CommandResult<T>>

export interface BrowserIpcHandlers {
  state: Handler<BrowserState>
  setView: Handler<null>
  navigate: Handler<null>
  back: Handler<null>
  forward: Handler<null>
  reload: Handler<null>
  stopAgent: Handler<null>
  takeControl: Handler<null>
  handBack: Handler<null>
  decideOrigin: Handler<null>
  openSignIn: Handler<null>
  closeSignIn: Handler<null>
  sites: Handler<string[]>
  removeSite: Handler<null>
  setEnabled: Handler<null>
}

function folderOf(registry: BrowserIpcDeps['registry'], folder: string | null): string | null {
  return folder === null ? null : chatFolder({ registry }, folder)
}

/** Validates a request naming one chat and resolves its tracked folder (null for a project-less chat). */
function chatRequest<T extends { folder: string | null; chatId: string }>(registry: BrowserIpcDeps['registry'], schema: z.ZodType<T>, input: unknown): { ref: BrowserChatRef; request: T } {
  const request = parseInput(schema, input, 'browser request')
  return { ref: { folder: folderOf(registry, request.folder), chatId: request.chatId }, request }
}

/** A person's navigation: one waiting for the origin card is answered; any other refusal is the error. */
function personNavigation(result: NavigateResult): null {
  if (!result.ok && result.code !== 'origin_blocked') throw new DomainError(result.code, new BrowserControlError(result.code).message)
  return null
}

/** Applies an ownership transition's effects to the chat's agent tab, if it has one, then pushes the new owner. */
function applyEffects(deps: BrowserIpcDeps, ref: BrowserChatRef, effects: readonly BrowserOwnershipEffect[]): null {
  const tab = deps.host.agentTab(ref)
  if (tab !== null) {
    for (const effect of effects) {
      if (effect === 'detach_debugger') deps.driverFor(tab).detach()
      else deps.contentsFor(tab).stop()
    }
  }
  deps.host.refresh(ref)
  return null
}

/** The entry Back (-1), Reload (0) or Forward (+1) would show, and the index the tab is at; null past either end. */
function historyTarget(history: PanelContents['navigationHistory'], step: -1 | 0 | 1): { active: number; url: string } | null {
  const active = history.getActiveIndex()
  const index = active + step
  const url = index < 0 || index >= history.length() ? '' : (history.getEntryAtIndex(index)?.url ?? '')
  return url === '' ? null : { active, url }
}

/**
 * Back (-1), Reload (0) or Forward (+1), after checking the target entry's URL against the tab's sites. A target no
 * longer allowed goes through `host.navigate` (the origin card); one the tab moved away from meanwhile is left alone.
 */
async function moveInHistory(deps: BrowserIpcDeps, ref: BrowserChatRef, step: -1 | 0 | 1): Promise<null> {
  const tab = deps.host.agentTab(ref)
  if (tab === null) return null
  const contents = deps.contentsFor(tab)
  const history = contents.navigationHistory
  const target = historyTarget(history, step)
  if (target === null) return null
  const allowed = await deps.host.frameAllowed(contents.id, target.url)
  if (deps.host.agentTab(ref)?.contents !== tab.contents || history.getActiveIndex() !== target.active) return null
  if (!allowed) return personNavigation(await deps.host.navigate(ref, target.url, 'person'))
  if (step < 0) history.goBack()
  else if (step > 0) history.goForward()
  else contents.reload()
  return null
}

type PageHandlers = Pick<BrowserIpcHandlers, 'state' | 'setView' | 'navigate' | 'back' | 'forward' | 'reload' | 'decideOrigin' | 'openSignIn' | 'closeSignIn'>

/** What the panel shows and where it goes: the state, the view's placement, navigation, history and the origin card. */
function pageHandlers(deps: BrowserIpcDeps): PageHandlers {
  const { registry, host } = deps
  const chat = (input: unknown) => chatRequest(registry, browserChatSchema, input).ref
  return {
    state: input => answer(deps, () => host.state(chat(input))),
    setView: input => answer(deps, () => {
      const { ref, request } = chatRequest(registry, browserSetViewSchema, input)
      host.setView(ref, request.bounds)
      return null
    }),
    navigate: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, browserNavigateSchema, input)
      return personNavigation(await host.navigate(ref, request.url, 'person'))
    }),
    back: input => answer(deps, () => moveInHistory(deps, chat(input), -1)),
    forward: input => answer(deps, () => moveInHistory(deps, chat(input), 1)),
    reload: input => answer(deps, () => moveInHistory(deps, chat(input), 0)),
    // A failed `always` (the folder's 200-site cap, say) answers its error here: the card is already gone.
    decideOrigin: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, browserDecideOriginSchema, input)
      const result = await host.decideOrigin(ref, request.promptId, request.decision)
      if (!result.ok) throw new DomainError('stale_prompt', 'That site prompt was already answered or replaced.')
      return null
    }),
    openSignIn: input => answer(deps, async () => {
      const { ref, request } = chatRequest(registry, browserOpenSignInSchema, input)
      return personNavigation(await host.openSignIn(ref, request.url))
    }),
    closeSignIn: input => answer(deps, () => {
      host.closeSignIn(chat(input))
      return null
    })
  }
}

/** Who drives the browser, the folder's always-allowed sites and the browser's on/off switch. */
function controlHandlers(deps: BrowserIpcDeps): Omit<BrowserIpcHandlers, keyof PageHandlers> {
  const { registry, ownership } = deps
  const transition = (input: unknown, move: (chatId: string) => readonly BrowserOwnershipEffect[]) => answer(deps, () => {
    const ref = chatRequest(registry, browserChatSchema, input).ref
    return applyEffects(deps, ref, move(ref.chatId))
  })
  return {
    stopAgent: input => transition(input, chatId => ownership.stop(chatId)),
    takeControl: input => transition(input, chatId => ownership.takeControl(chatId)),
    handBack: input => transition(input, chatId => ownership.handBack(chatId)),
    sites: input => answer(deps, () => {
      const { folder } = parseInput(browserSitesSchema, input, 'browser sites request')
      return deps.sites.list(folderOf(registry, folder))
    }),
    removeSite: input => answer(deps, async () => {
      const { folder, origin } = parseInput(browserRemoveSiteSchema, input, 'browser site removal')
      await deps.sites.remove(folderOf(registry, folder), origin)
      return null
    }),
    setEnabled: input => answer(deps, async () => {
      const { enabled } = parseInput(browserSetEnabledSchema, input, 'browser setting')
      await deps.settings.setEnabled(enabled)
      return null
    })
  }
}

export function createBrowserIpcHandlers(deps: BrowserIpcDeps): BrowserIpcHandlers {
  return { ...pageHandlers(deps), ...controlHandlers(deps) }
}

export function registerBrowserIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: BrowserIpcHandlers): void {
  ipcMain.handle(BROWSER_CHANNELS.state, (_event, request: unknown) => handlers.state(request))
  ipcMain.handle(BROWSER_CHANNELS.setView, (_event, request: unknown) => handlers.setView(request))
  ipcMain.handle(BROWSER_CHANNELS.navigate, (_event, request: unknown) => handlers.navigate(request))
  ipcMain.handle(BROWSER_CHANNELS.back, (_event, request: unknown) => handlers.back(request))
  ipcMain.handle(BROWSER_CHANNELS.forward, (_event, request: unknown) => handlers.forward(request))
  ipcMain.handle(BROWSER_CHANNELS.reload, (_event, request: unknown) => handlers.reload(request))
  ipcMain.handle(BROWSER_CHANNELS.stopAgent, (_event, request: unknown) => handlers.stopAgent(request))
  ipcMain.handle(BROWSER_CHANNELS.takeControl, (_event, request: unknown) => handlers.takeControl(request))
  ipcMain.handle(BROWSER_CHANNELS.handBack, (_event, request: unknown) => handlers.handBack(request))
  ipcMain.handle(BROWSER_CHANNELS.decideOrigin, (_event, request: unknown) => handlers.decideOrigin(request))
  ipcMain.handle(BROWSER_CHANNELS.openSignIn, (_event, request: unknown) => handlers.openSignIn(request))
  ipcMain.handle(BROWSER_CHANNELS.closeSignIn, (_event, request: unknown) => handlers.closeSignIn(request))
  ipcMain.handle(BROWSER_CHANNELS.sites, (_event, request: unknown) => handlers.sites(request))
  ipcMain.handle(BROWSER_CHANNELS.removeSite, (_event, request: unknown) => handlers.removeSite(request))
  ipcMain.handle(BROWSER_CHANNELS.setEnabled, (_event, request: unknown) => handlers.setEnabled(request))
}

/** Sends each validated chat browser state to every open window on `browser:event`; anything else is dropped. */
export function createBrowserPush(windows: () => readonly ChatWindow[]): (state: BrowserState) => void {
  return (state) => {
    const parsed = browserStateSchema.safeParse(state)
    if (parsed.success) sendToWindows(windows(), BROWSER_CHANNELS.event, parsed.data)
  }
}
