/** Pure helpers for Electron window lifecycle - kept free of Electron imports for mutation testing. */

import { createHash } from 'node:crypto'
import { relative, win32 } from 'node:path'

/** Route legacy packaged MCP invocations before touching the desktop singleton or focus. */
export function routeAppLaunch(entry: string | undefined, mcpEntry: string, actions: {
  serveMcp(): void
  claimDesktop(): boolean
  startDesktop(): void
  quit(): void
}): void {
  if (entry && relative(mcpEntry, entry) === '') {
    actions.serveMcp()
  } else if (actions.claimDesktop()) {
    actions.startDesktop()
  } else {
    actions.quit()
  }
}

export function loadRendererContent(
  rendererUrl: string | undefined,
  loadUrl: (url: string) => void,
  loadFile: () => void
): 'url' | 'file' {
  if (rendererUrl) {
    loadUrl(rendererUrl)
    return 'url'
  }
  loadFile()
  return 'file'
}

export function onActivateCreateWindow(openWindowCount: number, create: () => void): boolean {
  if (openWindowCount === 0) {
    create()
    return true
  }
  return false
}

export function onLastWindowClosed(platform: NodeJS.Platform, quit: () => void): boolean {
  if (platform !== 'darwin') {
    quit()
    return true
  }
  return false
}

/**
 * Drops the in-window File/Edit/View/Window menu bar on Windows and Linux. macOS keeps Electron's
 * default menu: it lives in the system menu bar, not the window, and it carries Cmd+C/V/X/A and Cmd+Q.
 */
export function removeWindowMenuBar(platform: NodeJS.Platform, clearMenu: () => void): boolean {
  if (platform !== 'darwin') {
    clearMenu()
    return true
  }
  return false
}

/**
 * Render in plain sRGB. Without this Chromium colour-manages the whole window to the display's ICC profile,
 * so theme colours show shifted (#ea4134 reads back as #d7513d). Theme colours must be the exact values,
 * as a terminal shows them. Must run before the app is ready.
 */
export function applyColorProfile(commandLine: { appendSwitch: (name: string, value?: string) => void }): void {
  commandLine.appendSwitch('force-color-profile', 'srgb')
}

/** The installed shortcut's AppUserModelId (`build.appId` in package.json): Windows shows a toast only for a matching id. */
const APP_USER_MODEL_ID = 'com.davgor.darkmechanicus'
/** How many hex digits of the home path's SHA-256 name an isolated profile. */
const ISOLATED_ID_HASH_LENGTH = 12

/** The Dark Mechanicus home this process uses, and the one it uses when `DARKMECHANICUS_HOME` is unset. */
interface AppProfile {
  home: string
  defaultHome: string
}

/** A Windows path in one spelling: resolved, without a trailing separator, lower-cased (Windows paths ignore case). */
function canonicalWindowsPath(path: string): string {
  return win32.resolve(path).toLowerCase()
}

/**
 * On Windows, names the process before any window opens, so OS notifications show and group under the app.
 * The default home gets the installer's app id. Any other home (an isolated test or verification profile)
 * gets its own stable id, so its toasts never raise or activate the person's installed app.
 */
export function applyAppUserModelId(platform: NodeJS.Platform, set: (id: string) => void, profile: AppProfile): boolean {
  if (platform !== 'win32') return false
  const home = canonicalWindowsPath(profile.home)
  if (home === canonicalWindowsPath(profile.defaultHome)) {
    set(APP_USER_MODEL_ID)
  } else {
    const digest = createHash('sha256').update(home).digest('hex').slice(0, ISOLATED_ID_HASH_LENGTH)
    set(`${APP_USER_MODEL_ID}.isolated.${digest}`)
  }
  return true
}
