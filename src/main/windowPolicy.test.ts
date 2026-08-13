import { describe, expect, it } from 'vitest'
import { loadRendererContent, onActivateCreateWindow, onLastWindowClosed } from './windowPolicy'

describe('loadRendererContent', () => {
  it('loads the dev-server URL when provided', () => {
    const urls: string[] = []
    let files = 0
    const mode = loadRendererContent(
      'http://localhost:5173',
      (url) => {
        urls.push(url)
      },
      () => {
        files += 1
      }
    )
    expect(mode).toBe('url')
    expect(urls).toEqual(['http://localhost:5173'])
    expect(files).toBe(0)
  })

  it('loads the packaged HTML file when no URL is set', () => {
    const urls: string[] = []
    let files = 0
    const mode = loadRendererContent(
      undefined,
      (url) => {
        urls.push(url)
      },
      () => {
        files += 1
      }
    )
    expect(mode).toBe('file')
    expect(urls).toEqual([])
    expect(files).toBe(1)
  })

  it('treats an empty URL as packaged file mode', () => {
    let files = 0
    expect(
      loadRendererContent(
        '',
        () => undefined,
        () => {
          files += 1
        }
      )
    ).toBe('file')
    expect(files).toBe(1)
  })
})

describe('onActivateCreateWindow', () => {
  it('creates a window only when none are open', () => {
    let created = 0
    const create = (): void => {
      created += 1
    }

    expect(onActivateCreateWindow(0, create)).toBe(true)
    expect(created).toBe(1)

    created = 0
    expect(onActivateCreateWindow(1, create)).toBe(false)
    expect(created).toBe(0)
    expect(onActivateCreateWindow(3, create)).toBe(false)
  })
})

describe('onLastWindowClosed', () => {
  it('keeps the app alive on macOS and quits elsewhere', () => {
    let quits = 0
    const quit = (): void => {
      quits += 1
    }

    expect(onLastWindowClosed('darwin', quit)).toBe(false)
    expect(quits).toBe(0)

    expect(onLastWindowClosed('win32', quit)).toBe(true)
    expect(quits).toBe(1)

    quits = 0
    expect(onLastWindowClosed('linux', quit)).toBe(true)
    expect(quits).toBe(1)
  })
})
