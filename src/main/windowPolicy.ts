/** Pure helpers for Electron window lifecycle — kept free of Electron imports for mutation testing. */

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
