import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserSettings } from './browserSettings'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function browserRoot(settings?: string): string {
  const root = join(mkdtempSync(join(tmpdir(), 'dm-browser-settings-')), 'browser')
  roots.push(join(root, '..'))
  if (settings !== undefined) {
    mkdirSync(root)
    writeFileSync(join(root, 'settings.json'), settings)
  }
  return root
}

describe('browser settings', () => {
  it.each([
    ['missing', undefined],
    ['not JSON', '{'],
    ['of the wrong shape', '{"enabled":"no"}']
  ])('is on when the file is %s', (_name, content) => {
    expect(createBrowserSettings({ root: browserRoot(content) }).enabled()).toBe(true)
  })

  it('saves the switch to <root>/settings.json and reads it back in a new process', async () => {
    const root = browserRoot()
    const settings = createBrowserSettings({ root })
    await settings.setEnabled(false)
    expect(settings.enabled()).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))).toEqual({ enabled: false })
    expect(createBrowserSettings({ root }).enabled()).toBe(false)
  })
})
