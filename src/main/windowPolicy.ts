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
