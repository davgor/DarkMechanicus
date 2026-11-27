/**
 * What a built entry script (`out/main/mcp.js`, `out/main/cli.js`) knows about the app it belongs to.
 * Side-effect free, so every entry point can import it without pulling in another entry's module graph.
 */
import { dirname, join } from 'node:path'

const FALLBACK_VERSION = '0.0.0'

/** A path segment named exactly `app.asar`: the packed app on Windows/Linux (`resources/`) and in a macOS bundle. */
const APP_ASAR_SEGMENT = /[\\/]app\.asar[\\/]/

/** The app version lives in the package.json two folders above `out/main/<entry>.js`, also inside app.asar. */
export function readPackageVersion(scriptPath: string, readText: (path: string) => string): string {
  try {
    const parsed: unknown = JSON.parse(readText(join(dirname(scriptPath), '..', '..', 'package.json')))
    const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined
    return typeof version === 'string' ? version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * True when the script runs from inside a packaged app (`…/app.asar/out/main/mcp.js`). A repository build
 * (`…/out/main/mcp.js`) is not the installed app. This trusts the path of the running process: it is the
 * process's own observation, not a security boundary.
 */
export function isPackagedScript(scriptPath: string): boolean {
  return APP_ASAR_SEGMENT.test(scriptPath)
}
