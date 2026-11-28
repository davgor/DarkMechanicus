import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { BrowserApi, BrowserState } from '../../../shared/browser/browserApi'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { useAnyOverlayOpen } from '../components/overlays'
import type { RailTab } from '../components/RightRail'
import { BrowserCamera } from './BrowserCamera'
import { OriginPromptCard } from './OriginPromptCard'
import { SitesPopover } from './SitesPopover'
import { useBrowser, type BrowserHandle } from './useBrowser'
import './browserPanel.css'

/** How often the placeholder's rect is re-read besides its ResizeObserver: a layout move without a resize. */
const PLACEMENT_POLL_MS = 250
/** The Sign-in tab's label (red-team Fix 55): the person's private scratch tab, never the agent's. */
const PRIVATE_TAB_LABEL = "Private tab (agents can't see this; sign-ins here don't carry over)"
const EMPTY_TEXT = 'Agents open pages here. You will be asked before any new site loads.'
const HIDDEN_TEXT = 'Browser hidden while a dialog is open'
const SITES_HIDDEN_TEXT = 'Browser hidden while Sites is open'
const CAMERA_HIDDEN_TEXT = 'Browser hidden while the capture is open'

/** The ownership badge: who drives the chat's browser now. */
function ownerBadge(owner: BrowserState['owner'], ownerLabel: string | null): string {
  if (owner === 'agent') return `Driven by: ${ownerLabel ?? 'an agent'}`
  if (owner === 'person') return 'You have control'
  return owner === 'stopped' ? 'Stopped' : 'Idle'
}

/**
 * Reports the placeholder's rect to main so the native view sits over it, by a ResizeObserver and a 250 ms poll, and
 * `bounds: null` once it stops showing: on unmount (a rail tab switch or collapse), when another chat is selected,
 * and while an app-wide overlay is open, since the native view would draw over it.
 */
function useViewPlacement({ api, folder, chatId, content, shown }: {
  api: BrowserApi
  folder: string | null
  chatId: string
  content: RefObject<HTMLElement>
  shown: boolean
}): void {
  useEffect(() => {
    const target = content.current
    if (!shown || target === null) return
    const ref = { folder, chatId }
    let last = ''
    const place = (): void => {
      const box = target.getBoundingClientRect()
      const bounds = { x: box.x, y: box.y, width: box.width, height: box.height }
      const key = JSON.stringify(bounds)
      if (key === last) return
      last = key
      void api.setView({ ...ref, bounds })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(target)
    const timer = window.setInterval(place, PLACEMENT_POLL_MS)
    return () => {
      observer?.disconnect()
      window.clearInterval(timer)
      void api.setView({ ...ref, bounds: null })
    }
  }, [api, folder, chatId, content, shown])
}

/** Enter submits the trimmed text, Escape gives up; both leave the field. */
function onEnterOrEscape(submit: () => void, cancel: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }
}

function TabStrip({ state, browser }: { state: BrowserState | null; browser: BrowserHandle }): JSX.Element {
  const signIn = state?.signIn ?? null
  const title = state?.tab ? state.tab.title || state.tab.url || 'New tab' : 'Agent tab'
  return (
    <ul className="bp-tabs" aria-label="Browser tabs">
      <li className={classNames('bp-tab', signIn === null && 'bp-tab-shown')} aria-current={signIn === null ? 'page' : undefined}>
        <Icon name="bot" />
        <span className="bp-tab-title" title={title}>{title}</span>
      </li>
      {signIn !== null && (
        <li className="bp-tab bp-tab-shown bp-tab-private" aria-current="page">
          <Icon name="lock" />
          <span className="bp-tab-title" title={signIn.url}>{PRIVATE_TAB_LABEL}</span>
          <button type="button" className="bp-icon" aria-label="Close private tab" title="Close private tab"
            onClick={() => browser.command('closeSignIn')}>
            <Icon name="close" />
          </button>
        </li>
      )}
    </ul>
  )
}

/** The agent tab's address; typing keeps a draft until Enter navigates or Escape drops it. */
function AddressBar({ state, browser }: { state: BrowserState | null; browser: BrowserHandle }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  // While the private tab is shown, the bar reads its address and stands down: navigate drives only the agent tab.
  const signIn = state?.signIn ?? null
  const value = signIn !== null ? signIn.url : draft ?? state?.tab?.url ?? ''
  return (
    <input className="bp-address" type="text" aria-label="Address" placeholder="Type an address and press Enter" spellCheck={false}
      value={value} disabled={state === null || signIn !== null} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onEnterOrEscape(() => {
        const url = value.trim()
        if (url !== '') browser.navigate(url)
        setDraft(null)
      }, () => setDraft(null))} />
  )
}

/** Private tab opens an inline address field in the toolbar (never `window.prompt`): Enter opens the tab, Escape cancels. */
function PrivateTabButton({ state, browser }: { state: BrowserState | null; browser: BrowserHandle }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  if (url === null) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" disabled={state === null} onClick={() => setUrl('')}>
        <Icon name="lock" />
        Private tab
      </button>
    )
  }
  return (
    <input className="bp-address bp-private-address" type="text" aria-label="Private tab address" autoFocus spellCheck={false}
      placeholder="Address for a private tab, then Enter" value={url} onChange={(event) => setUrl(event.target.value)}
      onBlur={() => setUrl(null)}
      onKeyDown={onEnterOrEscape(() => {
        const target = url.trim()
        if (target !== '') browser.openSignIn(target)
        setUrl(null)
      }, () => setUrl(null))} />
  )
}

function Toolbar({ state, browser, camera, sites }: {
  state: BrowserState | null
  browser: BrowserHandle
  camera: JSX.Element
  sites: JSX.Element
}): JSX.Element {
  // Back, Forward and Reload act on the agent tab, so they wait for it and stand down while the private tab is shown.
  const navigable = state?.tab != null && state.signIn === null
  return (
    <div className="bp-toolbar" role="toolbar" aria-label="Browser controls">
      <button type="button" className="bp-icon" aria-label="Back" title="Back" disabled={!navigable} onClick={() => browser.command('back')}>
        <Icon name="arrow-left" />
      </button>
      <button type="button" className="bp-icon" aria-label="Forward" title="Forward" disabled={!navigable}
        onClick={() => browser.command('forward')}>
        <Icon name="arrow-right" />
      </button>
      <button type="button" className="bp-icon" aria-label="Reload" title="Reload" disabled={!navigable} onClick={() => browser.command('reload')}>
        <Icon name="refresh" />
      </button>
      <AddressBar key={state?.tab?.url ?? ''} state={state} browser={browser} />
      <PrivateTabButton state={state} browser={browser} />
      {camera}
      {sites}
    </div>
  )
}

function Controls({ state, browser }: { state: BrowserState | null; browser: BrowserHandle }): JSX.Element {
  const owner = state?.owner ?? 'none'
  // Take control from nobody, an agent or a stop; Hand back from the person or a stop (red-team Fix 58, R19-3).
  const back = owner === 'person' || owner === 'stopped'
  return (
    <div className="bp-controls">
      <span className={`bp-badge bp-badge-${owner}`} role="status" aria-label="Browser owner">
        {state === null ? 'Loading…' : ownerBadge(owner, state.ownerLabel)}
      </span>
      <label className="bp-switch">
        <input type="checkbox" role="switch" checked={state?.enabled ?? false} disabled={state === null}
          onChange={(event) => browser.setEnabled(event.target.checked)} />
        Let agents use this browser
      </label>
      {/* Stop and the toggle stay together at the right, and wrap as one when the rail is narrow. */}
      <span className="bp-actions">
        <button type="button" className="btn btn-sm bp-stop" disabled={owner !== 'agent'} onClick={() => browser.command('stopAgent')}>
          Stop agent
        </button>
        <button type="button" className="btn btn-sm" disabled={state === null}
          onClick={() => browser.command(back ? 'handBack' : 'takeControl')}>
          {back ? 'Hand back' : 'Take control'}
        </button>
      </span>
    </div>
  )
}

/** The page area's own text: why the view is hidden, or the empty state while no page is shown; none over a page. */
function pageNote({ overlay, popover, state }: { overlay: boolean; popover: string | null; state: BrowserState | null }): string | null {
  if (overlay) return HIDDEN_TEXT
  return popover ?? (state !== null && state.tab === null && state.signIn === null ? EMPTY_TEXT : null)
}

/**
 * The toolbar popovers' open state, and the page note naming the one open: either hides the native view, which would
 * draw over it. The camera's popover belongs to the chat it captured; another chat selected in this panel shows none.
 */
function useToolbarPopovers(chatId: string) {
  const [sitesOpen, setSitesOpen] = useState(false)
  const [cameraChat, setCameraChat] = useState<string | null>(null)
  const cameraOpen = cameraChat === chatId
  const onCameraOpen = useCallback((open: boolean) => setCameraChat(open ? chatId : null), [chatId])
  const popover = sitesOpen ? SITES_HIDDEN_TEXT : cameraOpen ? CAMERA_HIDDEN_TEXT : null
  return { sitesOpen, setSitesOpen, cameraOpen, onCameraOpen, popover }
}

/**
 * The rail's Browser tab for one chat: its tab strip, toolbar, ownership badge and controls over the content area,
 * a placeholder whose rect main covers with the chat's native browser view. Menus and popovers of this panel open from
 * the toolbar; the native view draws above the page, so it is hidden while the Sites or camera popover drops over the
 * content. With `siteCard` (a chat not showing its GUI chat column, such as a terminal one) the chat's site prompt
 * docks here, above the content area, which shrinks to make room, so the view never covers it.
 */
export function BrowserPanel({ folder, folderKey = null, chatId, api = window.dm.browser, siteCard = false }: {
  folder: string | null
  /** The folder's attachment key, the host of the camera thumbnail's address; null for a project-less chat. */
  folderKey?: string | null
  chatId: string
  api?: BrowserApi
  siteCard?: boolean
}): JSX.Element {
  const browser = useBrowser(folder, chatId, api)
  const overlay = useAnyOverlayOpen()
  const { sitesOpen, setSitesOpen, cameraOpen, onCameraOpen, popover } = useToolbarPopovers(chatId)
  const hidden = overlay || popover !== null
  const content = useRef<HTMLDivElement>(null)
  useViewPlacement({ api, folder, chatId, content, shown: !hidden })
  const { state } = browser
  const note = pageNote({ overlay, popover, state })
  const sites = <SitesPopover folder={folder} api={api} open={sitesOpen} onOpenChange={setSitesOpen} />
  const camera = <BrowserCamera key={chatId} folder={folder} folderKey={folderKey} chatId={chatId} state={state} api={api} open={cameraOpen}
    onOpenChange={onCameraOpen} />
  return (
    <section className="bp" aria-label="Browser">
      <TabStrip state={state} browser={browser} />
      <Toolbar state={state} browser={browser} camera={camera} sites={sites} />
      <Controls state={state} browser={browser} />
      {browser.error !== null && <p className="bp-error" role="alert">{browser.error}</p>}
      {siteCard && <OriginPromptCard folder={folder} chatId={chatId} api={api} />}
      <div ref={content} className={classNames('bp-content', hidden && 'bp-content-hidden')} role="region" aria-label="Browser page">
        {note !== null && <p className="bp-note">{note}</p>}
      </div>
    </section>
  )
}

/**
 * The rail's Browser tab for one chat, as the epic and ordinary chat rails both offer it; it widens the rail. `siteCard`
 * docks the chat's site prompt in the panel, for a chat whose GUI chat column (and its card) is not shown.
 */
export function browserRailTab({ folder, folderKey, chatId, siteCard = false }: {
  folder: string | null
  folderKey: string | null
  chatId: string
  siteCard?: boolean
}): RailTab {
  return {
    id: 'browser', label: 'Browser', icon: 'globe', wide: true,
    content: <BrowserPanel folder={folder} folderKey={folderKey} chatId={chatId} siteCard={siteCard} />
  }
}
