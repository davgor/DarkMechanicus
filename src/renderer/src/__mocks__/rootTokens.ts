import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Not `new URL(…, import.meta.url)`: under jsdom, `URL` is jsdom's, which Node's fileURLToPath refuses.
const STYLES = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8')

/** The theme sheet's one `:root` block, as the app loads it. */
const ROOT_BLOCK = /:root\s*\{[^}]*\}/.exec(STYLES)?.[0] ?? ''

/** Adds the `:root` tokens of `styles.css` to the test document, so `getComputedStyle` reads them. */
export function installRootTokens(): void {
  const sheet = document.createElement('style')
  sheet.textContent = ROOT_BLOCK
  document.head.append(sheet)
}

/** A `--name: value;` token as `styles.css` writes it. */
export function tokenSource(name: string): string {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(ROOT_BLOCK)?.[1]?.trim() ?? ''
}
