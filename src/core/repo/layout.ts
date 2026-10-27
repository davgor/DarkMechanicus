import { join } from 'node:path'
import { fail } from '../errors'
import { DEFAULT_STORAGE_MODE, dbProjectDir, type StorageMode } from './storageMode'
import type { RepoLayout } from './types'

export const DM_DIR = '.darkmechanicus'

export interface ResolveLayoutOptions {
  /** Defaults to `repo`; `db` also needs `homeDir`. */
  mode?: StorageMode
  /** The Dark Mechanicus home directory (`resolveHomeDir`), required in `db` mode. */
  homeDir?: string
}

/** Where one project's owned files live, relative to `base`. Paths only; nothing is created. */
function layoutUnder(root: string, mode: StorageMode, base: string): RepoLayout {
  const localDir = join(base, 'local')
  return {
    root,
    mode,
    displayBase: base,
    dmDir: base,
    projectFile: join(base, 'project.json'),
    gitignoreFile: join(base, '.gitignore'),
    epicsDir: join(base, 'epics'),
    historyDir: join(base, 'history'),
    profilesDir: join(base, 'profiles'),
    localDir,
    dbFile: join(localDir, 'state.sqlite'),
    machineFile: join(localDir, 'machine.json')
  }
}

/**
 * The owned layout for a repository root. In `repo` mode everything sits in `.darkmechanicus/`
 * inside the repository. In `db` mode the whole project — including the record directories, which
 * that mode never writes — moves to the repository's project directory in the Dark Mechanicus home
 * directory, so no path can reach the repository folder at all.
 *
 * Pass a canonical root in `db` mode: the project directory is derived from it.
 */
export function resolveLayout(root: string, options: ResolveLayoutOptions = {}): RepoLayout {
  const mode = options.mode ?? DEFAULT_STORAGE_MODE
  if (mode === 'repo') {
    return { ...layoutUnder(root, mode, join(root, DM_DIR)), displayBase: root }
  }
  if (options.homeDir === undefined) {
    fail('internal', 'A database-only layout needs the Dark Mechanicus home directory.')
  }
  return layoutUnder(root, mode, dbProjectDir(root, options.homeDir))
}
