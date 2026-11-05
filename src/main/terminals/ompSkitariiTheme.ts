/**
 * The Skitarii theme for OMP chats (`docs/reports/omp-cli.md`, 8 and 10). OMP has no theme flag, and a custom theme is
 * only read from `<agent dir>/themes/<name>.json`, so a launch selects the theme in two parts: the per-chat `--config`
 * overlay says `theme.dark: skitarii` (`ompSession.ts`; it applies to that process only), and this file's
 * `installSkitariiTheme` makes sure `themes/skitarii.json` is there. That one file is the only thing the app adds under
 * the person's OMP folder: it is new (no OMP default has that name), the person's `config.yml` and every other theme
 * are never read or written, and the folder's permissions are left as they are. The theme itself is generated from the
 * app's palette tokens (`scripts/skitarii-theme.mjs`) and bundled into main.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import theme from '../../../resources/skitarii/theme.json'

export const SKITARII_THEME_NAME = 'skitarii'

/** The Skitarii theme file as OMP reads it. */
export const skitariiThemeFile = theme

/**
 * Puts the theme in OMP's themes folder under `agentDir`, replacing a copy that differs (an older app's) and leaving an
 * identical one alone. Best effort: when the folder cannot be written the chat still starts, in OMP's own look.
 */
export async function installSkitariiTheme(agentDir: string): Promise<void> {
  const text = `${JSON.stringify(theme, null, 2)}\n`
  const file = join(agentDir, 'themes', `${SKITARII_THEME_NAME}.json`)
  try {
    if ((await readFile(file, 'utf8').catch(() => null)) === text) return
    await mkdir(join(agentDir, 'themes'), { recursive: true })
    await writeFile(file, text)
  } catch {
    // The theme is only a look; a read-only agent folder is not a reason to refuse the chat.
  }
}
