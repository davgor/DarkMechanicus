import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORGE_FILE, parseForge } from '../main/desktop/forgeManifest'
import type { ForgeWorld } from '../shared/desktop/forgeWorld'

/** Seeds a fresh fixture directly, without hard-link creation followed by immediate manifest replacement. */
export function seedForgeFixture(root: string, owner: string, projects: ForgeWorld['projects']): void {
  const manifest = parseForge(JSON.stringify({ version: 1, owner, projects, syncMinutes: 5 }))
  writeFileSync(join(root, FORGE_FILE), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
}
