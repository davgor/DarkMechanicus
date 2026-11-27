import { existsSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { replaceForgeFile, type RenameRetryNote } from '../../core/repo/forgeManifest'
import { ownedEntry } from './mcpJson'
import { toTarget, type SkillDefinition } from './skillInstall'

/** `onRetry` is told of each busy rename of `.mcp.json` that is asked again (the main process logs it). */
export function cleanupForgeSource(source: string, skills: readonly SkillDefinition[], onRetry?: RenameRetryNote): void {
  cleanupSkills(source, skills)
  cleanupMcp(source, onRetry)
}

function cleanupSkills(source: string, skills: readonly SkillDefinition[]): void {
  for (const skill of skills) {
    const target = toTarget(source, skill)
    if (existsSync(target.file) && realpathSync.native(target.file) === target.file &&
      readFileSync(target.file, 'utf8') === target.content) {
      unlinkSync(target.file)
      if (!readdirSync(target.dir).length) rmdirSync(target.dir)
    }
  }
}

function cleanupMcp(source: string, onRetry?: RenameRetryNote): void {
  const file = join(source, '.mcp.json')
  if (!existsSync(file) || realpathSync.native(file) !== file) return
  const before = readFileSync(file, 'utf8')
  let config
  try { config = JSON.parse(before) } catch { return }
  if (!ownedEntry(config?.mcpServers?.darkmechanicus, source)) return
  delete config.mcpServers.darkmechanicus
  if (!Object.keys(config.mcpServers).length) delete config.mcpServers
  if (readFileSync(file, 'utf8') !== before) throw new Error('Agent configuration changed during conversion.')
  if (Object.keys(config).length === 0) unlinkSync(file)
  else {
    const temp = file + '.' + randomUUID()
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
    replaceForgeFile(temp, file, onRetry)
  }
}
