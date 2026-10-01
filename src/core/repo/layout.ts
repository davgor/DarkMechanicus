import { join } from 'node:path'
import type { RepoLayout } from './types'

export const DM_DIR = '.darkmechanicus'

/** The `.darkmechanicus/` layout for a repository root. Paths only; nothing is created. */
export function resolveLayout(root: string): RepoLayout {
  const dmDir = join(root, DM_DIR)
  const localDir = join(dmDir, 'local')
  return {
    root,
    dmDir,
    projectFile: join(dmDir, 'project.json'),
    gitignoreFile: join(dmDir, '.gitignore'),
    epicsDir: join(dmDir, 'epics'),
    historyDir: join(dmDir, 'history'),
    profilesDir: join(dmDir, 'profiles'),
    localDir,
    dbFile: join(localDir, 'state.sqlite'),
    machineFile: join(localDir, 'machine.json')
  }
}
