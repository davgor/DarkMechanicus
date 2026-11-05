/**
 * Where the Skitarii OMP extension (`resources/skitarii/extension/`) is on disk, for the `-e <file>` an OMP chat is
 * launched with (`docs/reports/omp-cli.md`, 10). OMP is a separate program and cannot read inside `app.asar`, so the
 * packaged app ships `resources/skitarii` beside it as an extra resource (`build.extraResources` in package.json:
 * `<resources>/skitarii/`); in development it is read from the project. Pure: no Electron import.
 */
import { join } from 'node:path'

interface SkitariiExtensionOptions {
  /** `app.isPackaged`. */
  packaged: boolean
  /** `app.getAppPath()`: the project root in development. */
  appPath: string
  /** `process.resourcesPath`: the folder holding `app.asar` and the extra resources when packaged. */
  resourcesPath: string
}

/** The extension's entry file OMP loads. */
export function skitariiExtensionPath(options: SkitariiExtensionOptions): string {
  const root = options.packaged ? options.resourcesPath : join(options.appPath, 'resources')
  return join(root, 'skitarii', 'extension', 'index.ts')
}
