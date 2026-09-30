import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  hardenWebContents,
  isAllowedExternalUrl,
  normalizeExternalUrl,
  resolveAppUrl
} from './navigation'

describe('isAllowedExternalUrl', () => {
  it('allows http, https, and mailto links', () => {
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('https://example.com/path?q=1#frag')).toBe(true)
    expect(isAllowedExternalUrl('mailto:someone@example.com')).toBe(true)
    expect(isAllowedExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true)
  })

  it('rejects script, file, data, and other schemes', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('JaVaScRiPt:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isAllowedExternalUrl('ftp://example.com/file')).toBe(false)
    expect(isAllowedExternalUrl('vscode://open?file=x')).toBe(false)
    expect(isAllowedExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
  })

  it('rejects relative, empty, and malformed input', () => {
    expect(isAllowedExternalUrl('/docs/readme')).toBe(false)
    expect(isAllowedExternalUrl('example.com')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('http://')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })
})

describe('normalizeExternalUrl', () => {
  it('returns the parsed href for allowed URLs', () => {
    expect(normalizeExternalUrl('https://Example.com')).toBe('https://example.com/')
    expect(normalizeExternalUrl('mailto:a@b.co?subject=hi there')).toBe(
      'mailto:a@b.co?subject=hi%20there'
    )
  })

  it('removes characters the URL parser ignores so the OS never sees them', () => {
    expect(normalizeExternalUrl('https://exa\nmple.com/\tpath')).toBe('https://example.com/path')
  })

  it('returns null for anything that is not allowed', () => {
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalUrl('relative/path')).toBeNull()
  })
})

describe('resolveAppUrl', () => {
  it('uses the dev-server URL when one is provided', () => {
    expect(resolveAppUrl('http://localhost:5173', '/app/out/renderer/index.html')).toBe(
      'http://localhost:5173'
    )
  })

  it('falls back to the packaged page as a file URL', () => {
    const page = '/app/out/renderer/index.html'
    expect(resolveAppUrl(undefined, page)).toBe(pathToFileURL(page).href)
    expect(resolveAppUrl('', page)).toBe(pathToFileURL(page).href)
  })
})

interface NavigationDetails {
  url: string
  preventDefault(): void
}

type OpenHandler = (details: { url: string }) => { action: 'deny' }

function createFakeContents(): {
  setWindowOpenHandler(handler: OpenHandler): void
  on(event: string, listener: (details: NavigationDetails) => void): void
  registeredEvents(): string[]
  openWindow(url: string): { action: 'deny' } | null
  navigate(event: string, url: string): boolean
} {
  let openHandler: OpenHandler | null = null
  const listeners = new Map<string, (details: NavigationDetails) => void>()
  return {
    setWindowOpenHandler(handler) {
      openHandler = handler
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
    registeredEvents: () => [...listeners.keys()].sort(),
    openWindow: (url) => (openHandler === null ? null : openHandler({ url })),
    navigate(event, url) {
      let prevented = false
      listeners.get(event)?.({
        url,
        preventDefault: () => {
          prevented = true
        }
      })
      return prevented
    }
  }
}

describe('hardenWebContents window opening', () => {
  it('denies every new window and opens only allowed URLs externally', () => {
    const contents = createFakeContents()
    const opened: string[] = []
    hardenWebContents(contents, {
      appUrl: null,
      openExternal: (url) => {
        opened.push(url)
      }
    })

    expect(contents.openWindow('https://example.com/docs')).toEqual({ action: 'deny' })
    expect(contents.openWindow('javascript:alert(1)')).toEqual({ action: 'deny' })
    expect(contents.openWindow('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(contents.openWindow('mailto:a@b.co')).toEqual({ action: 'deny' })
    expect(contents.openWindow('/relative')).toEqual({ action: 'deny' })
    expect(opened).toEqual(['https://example.com/docs', 'mailto:a@b.co'])
  })
})

/** A fake window whose navigation guard is installed for `appUrl`. */
function hardened(appUrl: string | null): ReturnType<typeof createFakeContents> {
  const contents = createFakeContents()
  hardenWebContents(contents, { appUrl, openExternal: () => undefined })
  return contents
}

describe('hardenWebContents dev-server navigation', () => {
  it('guards navigation and redirects and nothing else', () => {
    const contents = hardened('http://localhost:5173')

    expect(contents.registeredEvents()).toEqual(['will-navigate', 'will-redirect'])
  })

  it('lets the dev-server origin navigate and blocks everything else', () => {
    const contents = hardened('http://localhost:5173')

    expect(contents.navigate('will-navigate', 'http://localhost:5173/')).toBe(false)
    expect(contents.navigate('will-navigate', 'http://localhost:5173/#/epic/1')).toBe(false)
    expect(contents.navigate('will-navigate', 'https://example.com')).toBe(true)
    expect(contents.navigate('will-navigate', 'https://localhost:5173/')).toBe(true)
    expect(contents.navigate('will-navigate', 'http://localhost:5174/')).toBe(true)
    expect(contents.navigate('will-navigate', 'http://localhost:5173.evil.example/')).toBe(true)
    expect(contents.navigate('will-navigate', 'file:///etc/passwd')).toBe(true)
    expect(contents.navigate('will-navigate', 'not a url')).toBe(true)
  })

  it('applies the same guard to redirects', () => {
    const contents = hardened('http://localhost:5173')

    expect(contents.navigate('will-redirect', 'http://localhost:5173/next')).toBe(false)
    expect(contents.navigate('will-redirect', 'https://example.com/login')).toBe(true)
  })

  it('compares origins for an https app URL too', () => {
    const contents = hardened('https://app.local:8443')

    expect(contents.navigate('will-navigate', 'https://app.local:8443/view')).toBe(false)
    expect(contents.navigate('will-navigate', 'http://app.local:8443/view')).toBe(true)
  })
})

describe('hardenWebContents packaged navigation', () => {
  const page = pathToFileURL('/opt/app/out/renderer/index.html').href

  it('lets the packaged page navigate within itself', () => {
    const contents = hardened(page)

    expect(contents.navigate('will-navigate', page)).toBe(false)
    expect(contents.navigate('will-navigate', `${page}#/epic/1`)).toBe(false)
  })

  it('blocks other files and web pages', () => {
    const contents = hardened(page)

    expect(contents.navigate('will-navigate', pathToFileURL('/opt/app/other.html').href)).toBe(true)
    expect(contents.navigate('will-navigate', pathToFileURL('/etc/passwd').href)).toBe(true)
    expect(contents.navigate('will-navigate', 'http://localhost:5173/')).toBe(true)
  })
})

describe('hardenWebContents without a usable app URL', () => {
  it('blocks all navigation when the app URL is unknown', () => {
    const contents = hardened(null)

    expect(contents.navigate('will-navigate', 'http://localhost:5173/')).toBe(true)
    expect(contents.navigate('will-navigate', 'file:///opt/app/index.html')).toBe(true)
  })

  it('blocks all navigation when the app URL has no comparable origin or is malformed', () => {
    expect(hardened('about:blank').navigate('will-navigate', 'about:blank')).toBe(true)
    expect(hardened('not a url').navigate('will-navigate', 'http://localhost:5173/')).toBe(true)
  })
})
