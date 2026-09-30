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
const samePage: AppUrlMatcher = (candidate, app) =>
  candidate.protocol === 'file:' && candidate.pathname === app.pathname

const APP_URL_MATCHERS: Partial<Record<string, AppUrlMatcher>> = {
  'http:': sameOrigin,
  'https:': sameOrigin,
  'file:': samePage
}

/** Parsed comparison (never a string prefix): `http://localhost:5173.evil.example` is not the app. */
function isAppUrl(target: string, appUrl: string | null): boolean {
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
}

interface HardenOptions {
  /** The dev-server origin or packaged page URL; null blocks every navigation. */
  appUrl: string | null
  openExternal: (url: string) => void
}

/**
 * Locks a window's contents to the app: new windows are always denied (allowed links go to the
 * system browser instead) and navigation away from the app page or dev server is prevented.
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
}
