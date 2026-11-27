/**
 * Navigation and external-link policy for the main window. Kept free of Electron imports so it can
 * be unit and mutation tested: `hardenWebContents` only needs the two hooks it calls.
 */
import { pathToFileURL } from 'node:url'

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/** The parsed href of an http, https, or mailto URL; null for anything else (including relative input). */
export function normalizeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  return normalizeExternalUrl(url) !== null
}

/** The URL the main window itself loads: the dev server when provided, else the packaged page. */
export function resolveAppUrl(rendererUrl: string | undefined, rendererFile: string): string {
  return rendererUrl || pathToFileURL(rendererFile).href
}

type AppUrlMatcher = (candidate: URL, app: URL) => boolean

const sameOrigin: AppUrlMatcher = (candidate, app) => candidate.origin === app.origin
/** The same local file: a file URL on another host is a network share, never the packaged page. */
const samePage: AppUrlMatcher = (candidate, app) =>
  candidate.protocol === 'file:' && candidate.host === app.host && candidate.pathname === app.pathname

const APP_URL_MATCHERS: Partial<Record<string, AppUrlMatcher>> = {
  'http:': sameOrigin,
  'https:': sameOrigin,
  'file:': samePage
}

/**
 * Whether `target` is the app's own page: the dev server's origin, or the packaged page's resolved
 * file path (query and hash ignored). Parsed comparison, never a string prefix:
 * `http://localhost:5173.evil.example` is not the app. Navigation and the IPC sender guard share it.
 */
export function isAppUrl(target: string, appUrl: string | null): boolean {
  if (appUrl === null) {
    return false
  }
  try {
    const app = new URL(appUrl)
    return APP_URL_MATCHERS[app.protocol]?.(new URL(target), app) ?? false
  } catch {
    return false
  }
}

interface NavigationDetails {
  url: string
  preventDefault(): void
}

interface HardenableWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (details: NavigationDetails) => void
  ): unknown
  on(event: 'will-frame-navigate', listener: (details: NavigationDetails & { isMainFrame: boolean }) => void): unknown
}

/**
 * The only addresses a frame inside the app page may navigate to: a cult Shrine (`dm-shrine:`). A sandboxed Shrine page
 * may run script, but never takes its own frame to the network or anywhere else.
 */
export function isAllowedFrameUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'dm-shrine:'
  } catch {
    return false
  }
}

interface HardenOptions {
  /** The dev-server origin or packaged page URL; null blocks every navigation. */
  appUrl: string | null
  openExternal: (url: string) => void
}

/**
 * Locks a window's contents to the app: new windows are always denied (allowed links go to the
 * system browser instead), navigation away from the app page or dev server is prevented, and a
 * frame inside the page may navigate only to a cult Shrine (`isAllowedFrameUrl`).
 */
export function hardenWebContents(contents: HardenableWebContents, options: HardenOptions): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = normalizeExternalUrl(url)
    if (target !== null) {
      options.openExternal(target)
    }
    return { action: 'deny' }
  })
  const guard = (details: NavigationDetails): void => {
    if (!isAppUrl(details.url, options.appUrl)) {
      details.preventDefault()
    }
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame && !isAllowedFrameUrl(details.url)) {
      details.preventDefault()
    }
  })
}
