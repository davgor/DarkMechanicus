/**
 * Whether the in-app browser is turned on: `{ "enabled": boolean }` in `<userData>/browser/settings.json`, on by
 * default. A missing or unreadable file reads as on; the origin policy still fails closed for every site.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../terminals/privateFile'

const settingsSchema = z.object({ enabled: z.boolean() })

export interface BrowserSettings {
  enabled(): boolean
  /** Saves the switch; `enabled()` answers the new value at once. */
  setEnabled(enabled: boolean): Promise<void>
}

function readEnabled(file: string): boolean {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data.enabled : true
  } catch {
    return true
  }
}

export function createBrowserSettings(options: {
  /** Absolute path of the browser directory (`<userData>/browser`). */
  root: string
}): BrowserSettings {
  const file = join(options.root, 'settings.json')
  let enabled = readEnabled(file)
  let queue: Promise<unknown> = Promise.resolve()
  return {
    enabled: () => enabled,
    setEnabled: (next) => {
      enabled = next
      const write = queue.then(() => writePrivateFile(file, `${JSON.stringify({ enabled: next })}\n`, 0o600))
      queue = write.catch(() => undefined)
      return write
    }
  }
}
