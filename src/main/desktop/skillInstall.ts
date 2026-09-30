/**
 * Writes the shipped skills into a repository as Claude Code skills
 * (`.claude/skills/darkmechanicus-<name>/SKILL.md`). It only writes text files at fixed, validated
 * paths and never executes anything. Repository contents are untrusted, so a symbolic link (or
 * junction) at any level, an unexpected file type, or a resolved path outside the repository is
 * refused before anything is written.
 */
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { DomainError } from '../../core/errors'

export interface SkillDefinition {
  name: string
  description: string
  body: string
}

type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

/** The filesystem surface the installer uses; tests inject fakes through it. */
export interface SkillFs {
  /** What is at `path`, without following symbolic links. */
  entryKind(path: string): EntryKind
  /** Creates one directory level; its parent already exists. */
  mkdir(path: string): void
  writeFile(path: string, data: string): void
  /** Canonical real path with every symbolic link resolved. */
  realpath(path: string): string
}

const NAME_PATTERN = /^[a-z0-9-]{1,40}$/
const DIR_PREFIX = 'darkmechanicus-'
const CLAUDE_DIR = '.claude'
const SKILLS_DIR = 'skills'
const SKILL_FILE = 'SKILL.md'
const USABLE_DIRECTORY: readonly EntryKind[] = ['missing', 'directory']
const USABLE_FILE: readonly EntryKind[] = ['missing', 'file']

/** Text that is valid as an unquoted YAML value: starts with a letter, no `:` or `#`, not a keyword. */
const PLAIN_YAML = /^(?!(?:true|false|null)$)[A-Za-z][A-Za-z0-9 ,.()/'_-]*$/i

const nodeSkillFs: SkillFs = {
  entryKind(path) {
    const stats = lstatSync(path, { throwIfNoEntry: false })
    if (stats === undefined) {
      return 'missing'
    }
    if (stats.isSymbolicLink()) {
      return 'symlink'
    }
    if (stats.isDirectory()) {
      return 'directory'
    }
    return stats.isFile() ? 'file' : 'other'
  },
  mkdir: (path) => {
    mkdirSync(path)
  },
  writeFile: (path, data) => {
    writeFileSync(path, data, 'utf8')
  },
  realpath: (path) => realpathSync.native(path)
}

interface SkillTarget {
  dir: string
  file: string
  /** Forward-slash path relative to the repository root, for reporting. */
  relativePath: string
  content: string
}

function assertValidSkills(skills: readonly SkillDefinition[]): void {
  const seen = new Set<string>()
  for (const { name } of skills) {
    if (!NAME_PATTERN.test(name)) {
      throw new DomainError('invalid_input', `Skill name must match ${NAME_PATTERN.source}: ${JSON.stringify(name)}`)
    }
    if (seen.has(name)) {
      throw new DomainError('invalid_input', `Duplicate skill name: ${name}`)
    }
    seen.add(name)
  }
}

/** A single-line YAML value: plain when that is safe, otherwise a double-quoted (JSON) string. */
function yamlText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return PLAIN_YAML.test(line) ? line : JSON.stringify(line)
}

function renderSkill(dirName: string, skill: SkillDefinition): string {
  const body = skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`
  return `---\nname: ${dirName}\ndescription: ${yamlText(skill.description)}\n---\n\n${body}`
}

function toTarget(repoRoot: string, skill: SkillDefinition): SkillTarget {
  const dirName = `${DIR_PREFIX}${skill.name}`
  const dir = join(repoRoot, CLAUDE_DIR, SKILLS_DIR, dirName)
  return {
    dir,
    file: join(dir, SKILL_FILE),
    relativePath: posix.join(CLAUDE_DIR, SKILLS_DIR, dirName, SKILL_FILE),
    content: renderSkill(dirName, skill)
  }
}

function resolveRoot(fs: SkillFs, repoRoot: string): string {
  try {
    return fs.realpath(repoRoot)
  } catch {
    throw new DomainError('not_found', `Repository folder not found: ${repoRoot}`)
  }
}

function assertEntry(path: string, kind: EntryKind, allowed: readonly EntryKind[]): void {
  if (!allowed.includes(kind)) {
    const reason = kind === 'symlink' ? 'is a symbolic link' : 'is not the expected kind of entry'
    throw new DomainError('unsafe_path', `Refusing to install skills: ${path} ${reason}.`, { path })
  }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (outside) {
    throw new DomainError('unsafe_path', `Refusing to install skills outside the repository: ${candidate}`, {
      path: candidate
    })
  }
}

function preflight(fs: SkillFs, target: SkillTarget): void {
  assertEntry(target.dir, fs.entryKind(target.dir), USABLE_DIRECTORY)
  assertEntry(target.file, fs.entryKind(target.file), USABLE_FILE)
}

function makeIfMissing(fs: SkillFs, dir: string): void {
  if (fs.entryKind(dir) === 'missing') {
    fs.mkdir(dir)
  }
}

function writeTarget(fs: SkillFs, target: SkillTarget, rootReal: string): string {
  makeIfMissing(fs, target.dir)
  assertInside(rootReal, fs.realpath(target.dir))
  fs.writeFile(target.file, target.content)
  return target.relativePath
}

/**
 * Installs each skill and returns the repository-relative paths written. Refusals (`unsafe_path`,
 * `invalid_input`, `not_found`) happen before any skill file is written.
 */
export function installClaudeSkills(
  repoRoot: string,
  skills: readonly SkillDefinition[],
  fs: SkillFs = nodeSkillFs
): string[] {
  assertValidSkills(skills)
  if (skills.length === 0) {
    return []
  }
  const rootReal = resolveRoot(fs, repoRoot)
  const targets = skills.map((skill) => toTarget(repoRoot, skill))
  const parents = [join(repoRoot, CLAUDE_DIR), join(repoRoot, CLAUDE_DIR, SKILLS_DIR)]
  parents.forEach((dir) => assertEntry(dir, fs.entryKind(dir), USABLE_DIRECTORY))
  targets.forEach((target) => preflight(fs, target))
  parents.forEach((dir) => makeIfMissing(fs, dir))
  return targets.map((target) => writeTarget(fs, target, rootReal))
}
