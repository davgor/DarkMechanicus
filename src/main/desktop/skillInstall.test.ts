import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { SKILLS } from '../../mcp/skills'
import { installClaudeSkills, type SkillFs } from './skillInstall'

interface Sandbox {
  repo: string
  outside: string
}

/** A repository and an unrelated directory that must never be written to. */
function withSandbox(run: (sandbox: Sandbox) => void): void {
  // Native realpath, like production, so Windows 8.3 temp names (RUNNER~1) are already expanded.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-skills-')))
  try {
    const repo = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(repo)
    mkdirSync(outside)
    run({ repo, outside })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'no error'
}

function errorMessage(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'no error'
}

/** File symlinks need a privilege on Windows; report false there instead of failing the suite. */
function tryFileSymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return false
    }
    throw error
  }
}

function skill(name: string, description = 'Does a thing', body = 'Body\n') {
  return { name, description, body }
}

function skillFile(repo: string, name: string): string {
  return join(repo, '.claude', 'skills', `darkmechanicus-${name}`, 'SKILL.md')
}

describe('installClaudeSkills output', () => {
  it('writes one SKILL.md per skill and returns the relative paths in order', () => {
    withSandbox(({ repo }) => {
      const written = installClaudeSkills(repo, [
        skill('planner', 'Plan epics and tickets', '# Planner\n\nDo the thing.\n'),
        skill('worker-2', 'Work one ticket', 'Worker body\n')
      ])

      expect(written).toEqual([
        '.claude/skills/darkmechanicus-planner/SKILL.md',
        '.claude/skills/darkmechanicus-worker-2/SKILL.md'
      ])
      expect(readFileSync(skillFile(repo, 'planner'), 'utf8')).toBe(
        '---\nname: darkmechanicus-planner\ndescription: Plan epics and tickets\n---\n\n# Planner\n\nDo the thing.\n'
      )
      expect(readFileSync(skillFile(repo, 'worker-2'), 'utf8')).toBe(
        '---\nname: darkmechanicus-worker-2\ndescription: Work one ticket\n---\n\nWorker body\n'
      )
    })
  })

  it('ends every file with exactly one newline', () => {
    withSandbox(({ repo }) => {
      installClaudeSkills(repo, [skill('a', 'A skill', 'no newline'), skill('b', 'B skill', 'has newline\n')])

      expect(readFileSync(skillFile(repo, 'a'), 'utf8').endsWith('---\n\nno newline\n')).toBe(true)
      expect(readFileSync(skillFile(repo, 'b'), 'utf8').endsWith('---\n\nhas newline\n')).toBe(true)
    })
  })

})

describe('installClaudeSkills file contents', () => {
  it('writes bodies verbatim and never interprets them', () => {
    withSandbox(({ repo }) => {
      const body = 'Run `touch pwned` or $(touch pwned) or ; touch pwned\n'
      installClaudeSkills(repo, [skill('planner', 'Plan', body)])

      expect(readFileSync(skillFile(repo, 'planner'), 'utf8').endsWith(`\n\n${body}`)).toBe(true)
      expect(existsSync(join(repo, 'pwned'))).toBe(false)
      expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false)
    })
  })

  it('overwrites an existing SKILL.md and leaves everything else alone', () => {
    withSandbox(({ repo }) => {
      const dir = join(repo, '.claude', 'skills', 'darkmechanicus-planner')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), 'old content')
      writeFileSync(join(dir, 'notes.txt'), 'keep me')
      mkdirSync(join(repo, '.claude', 'skills', 'my-own-skill'))
      writeFileSync(join(repo, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), 'mine')

      installClaudeSkills(repo, [skill('planner', 'New description', 'New body\n')])

      expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(
        '---\nname: darkmechanicus-planner\ndescription: New description\n---\n\nNew body\n'
      )
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me')
      expect(readFileSync(join(repo, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), 'utf8')).toBe(
        'mine'
      )
    })
  })

  it('touches nothing when there are no skills to install', () => {
    withSandbox(({ repo }) => {
      expect(installClaudeSkills(repo, [])).toEqual([])
      expect(readdirSync(repo)).toEqual([])
    })
  })
})

describe('installClaudeSkills front matter', () => {
  function descriptionLine(description: string): string {
    let line = ''
    withSandbox(({ repo }) => {
      installClaudeSkills(repo, [skill('planner', description)])
      line = readFileSync(skillFile(repo, 'planner'), 'utf8').split('\n')[2] ?? ''
    })
    return line
  }

  it('keeps ordinary descriptions as plain text on one line', () => {
    expect(descriptionLine('Plan epics, then (carefully) draft tickets.')).toBe(
      'description: Plan epics, then (carefully) draft tickets.'
    )
    expect(descriptionLine('Line one\n   line two\t and three ')).toBe(
      'description: Line one line two and three'
    )
  })

  it('quotes descriptions that would not be valid plain YAML', () => {
    expect(descriptionLine('Use when: planning')).toBe('description: "Use when: planning"')
    expect(descriptionLine('# not a comment')).toBe('description: "# not a comment"')
    expect(descriptionLine('"already quoted"')).toBe('description: "\\"already quoted\\""')
    expect(descriptionLine('Plan — then act')).toBe('description: "Plan — then act"')
    expect(descriptionLine('2 steps')).toBe('description: "2 steps"')
    expect(descriptionLine('true')).toBe('description: "true"')
    expect(descriptionLine('Null')).toBe('description: "Null"')
    expect(descriptionLine('')).toBe('description: ""')
  })

  it('cannot be tricked into a second front matter block', () => {
    withSandbox(({ repo }) => {
      installClaudeSkills(repo, [skill('planner', 'Fine\n---\nname: evil')])
      const lines = readFileSync(skillFile(repo, 'planner'), 'utf8').split('\n')

      expect(lines.slice(0, 5)).toEqual([
        '---',
        'name: darkmechanicus-planner',
        'description: "Fine --- name: evil"',
        '---',
        ''
      ])
    })
  })
})

describe('installClaudeSkills names', () => {
  it('accepts lowercase letters, digits, and hyphens up to 40 characters', () => {
    withSandbox(({ repo }) => {
      const longest = `a${'-'.repeat(38)}9`
      expect(longest.length).toBe(40)
      const written = installClaudeSkills(repo, [skill('x'), skill(longest)])

      expect(written).toHaveLength(2)
      expect(existsSync(skillFile(repo, longest))).toBe(true)
    })
  })

  it('rejects anything else with invalid_input, before touching disk', () => {
    const invalid = [
      '',
      'Planner',
      'plan_ner',
      'plan ner',
      '../evil',
      'a/b',
      'a\\b',
      '.',
      '..',
      'x'.repeat(41),
      'ünï',
      'line\nbreak'
    ]
    withSandbox(({ repo }) => {
      const codes = invalid.map((name) => errorCode(() => installClaudeSkills(repo, [skill('ok'), skill(name)])))

      expect(codes).toEqual(invalid.map(() => 'invalid_input'))
      expect(readdirSync(repo)).toEqual([])
    })
  })

  it('rejects duplicate names', () => {
    withSandbox(({ repo }) => {
      const code = errorCode(() => installClaudeSkills(repo, [skill('planner'), skill('planner')]))

      expect(code).toBe('invalid_input')
      expect(readdirSync(repo)).toEqual([])
    })
  })
})

describe('installClaudeSkills symbolic links', () => {
  it('refuses when .claude is a symbolic link', () => {
    withSandbox(({ repo, outside }) => {
      symlinkSync(outside, join(repo, '.claude'), 'junction')

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
      expect(errorMessage(() => installClaudeSkills(repo, [skill('planner')]))).toContain(
        'is a symbolic link'
      )
      expect(readdirSync(outside)).toEqual([])
    })
  })

  it('refuses when .claude/skills is a symbolic link', () => {
    withSandbox(({ repo, outside }) => {
      mkdirSync(join(repo, '.claude'))
      symlinkSync(outside, join(repo, '.claude', 'skills'), 'junction')

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
      expect(readdirSync(outside)).toEqual([])
    })
  })

  it('refuses when a skill directory is a symbolic link, without writing earlier skills', () => {
    withSandbox(({ repo, outside }) => {
      mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
      symlinkSync(outside, join(repo, '.claude', 'skills', 'darkmechanicus-worker'), 'junction')

      const code = errorCode(() => installClaudeSkills(repo, [skill('planner'), skill('worker')]))

      expect(code).toBe('unsafe_path')
      expect(readdirSync(outside)).toEqual([])
      expect(existsSync(join(repo, '.claude', 'skills', 'darkmechanicus-planner'))).toBe(false)
    })
  })

  it('refuses when SKILL.md itself is a symbolic link and leaves its target unchanged', () => {
    withSandbox(({ repo, outside }) => {
      const target = join(outside, 'important.txt')
      writeFileSync(target, 'precious')
      const dir = join(repo, '.claude', 'skills', 'darkmechanicus-planner')
      mkdirSync(dir, { recursive: true })
      if (!tryFileSymlink(target, join(dir, 'SKILL.md'))) {
        expect(process.platform).toBe('win32')
        return
      }

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
      expect(readFileSync(target, 'utf8')).toBe('precious')
    })
  })
})

describe('installClaudeSkills unexpected entries', () => {
  it('refuses when .claude is a regular file', () => {
    withSandbox(({ repo }) => {
      writeFileSync(join(repo, '.claude'), 'not a directory')

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
      expect(errorMessage(() => installClaudeSkills(repo, [skill('planner')]))).toContain(
        'is not the expected kind of entry'
      )
      expect(readFileSync(join(repo, '.claude'), 'utf8')).toBe('not a directory')
    })
  })

  it('refuses when .claude/skills is a regular file', () => {
    withSandbox(({ repo }) => {
      mkdirSync(join(repo, '.claude'))
      writeFileSync(join(repo, '.claude', 'skills'), 'not a directory')

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
    })
  })

  it('refuses when a skill directory is a regular file', () => {
    withSandbox(({ repo }) => {
      mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'skills', 'darkmechanicus-planner'), 'file')

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
    })
  })

  it('refuses when SKILL.md is a directory', () => {
    withSandbox(({ repo }) => {
      mkdirSync(join(repo, '.claude', 'skills', 'darkmechanicus-planner', 'SKILL.md'), {
        recursive: true
      })

      expect(errorCode(() => installClaudeSkills(repo, [skill('planner')]))).toBe('unsafe_path')
    })
  })

  it('reports a missing repository folder as not_found', () => {
    withSandbox(({ repo }) => {
      expect(errorCode(() => installClaudeSkills(join(repo, 'gone'), [skill('planner')]))).toBe('not_found')
    })
  })
})

/** In-memory SkillFs: every directory exists, no SKILL.md exists, real paths are remapped. */
function createFakeFs(realpaths: Record<string, string>): { fs: SkillFs; written: string[] } {
  const written: string[] = []
  const fs: SkillFs = {
    entryKind: (path) => (path.endsWith('SKILL.md') ? 'missing' : 'directory'),
    mkdir: () => undefined,
    writeFile: (path) => {
      written.push(path)
    },
    realpath: (path) => realpaths[path] ?? path
  }
  return { fs, written }
}

describe('installClaudeSkills containment', () => {
  const root = join(sep, 'repo')
  const skillDir = join(root, '.claude', 'skills', 'darkmechanicus-planner')

  it('writes when the resolved skill directory stays inside the repository', () => {
    const { fs, written } = createFakeFs({ [skillDir]: join(root, '.claude', 'skills', 'darkmechanicus-planner') })

    expect(installClaudeSkills(root, [skill('planner')], fs)).toEqual([
      '.claude/skills/darkmechanicus-planner/SKILL.md'
    ])
    expect(written).toEqual([join(skillDir, 'SKILL.md')])
  })

  it('refuses when the resolved skill directory escapes the repository', () => {
    const { fs, written } = createFakeFs({ [skillDir]: join(sep, 'elsewhere', 'skill') })

    expect(errorCode(() => installClaudeSkills(root, [skill('planner')], fs))).toBe('unsafe_path')
    expect(written).toEqual([])
  })

  it('refuses a sibling directory whose name merely starts with the repository name', () => {
    const { fs, written } = createFakeFs({ [skillDir]: join(sep, 'repo-evil', 'skill') })

    expect(errorCode(() => installClaudeSkills(root, [skill('planner')], fs))).toBe('unsafe_path')
    expect(written).toEqual([])
  })

  it('refuses the repository root itself and its parent', () => {
    const atRoot = createFakeFs({ [skillDir]: root })
    const atParent = createFakeFs({ [skillDir]: join(root, '..') })

    expect(errorCode(() => installClaudeSkills(root, [skill('planner')], atRoot.fs))).toBe('unsafe_path')
    expect(errorCode(() => installClaudeSkills(root, [skill('planner')], atParent.fs))).toBe('unsafe_path')
    expect(atRoot.written.concat(atParent.written)).toEqual([])
  })

  it('canonicalizes the repository root before comparing', () => {
    const real = join(sep, 'real', 'repo')
    const { fs, written } = createFakeFs({
      [root]: real,
      [skillDir]: join(real, '.claude', 'skills', 'darkmechanicus-planner')
    })

    expect(installClaudeSkills(root, [skill('planner')], fs)).toHaveLength(1)
    expect(written).toHaveLength(1)
  })
})

describe('installClaudeSkills with the shipped skills', () => {
  /** The description as a YAML reader sees it: plain text, or a double-quoted JSON string. */
  function readDescription(line: string): string {
    const value = line.slice('description: '.length)
    return value.startsWith('"') ? JSON.parse(value) : value
  }

  it('installs every shipped skill with front matter that round-trips', () => {
    withSandbox(({ repo }) => {
      const written = installClaudeSkills(repo, SKILLS)

      expect(written).toEqual(SKILLS.map((item) => `.claude/skills/darkmechanicus-${item.name}/SKILL.md`))
      for (const item of SKILLS) {
        const lines = readFileSync(skillFile(repo, item.name), 'utf8').split('\n')
        expect(lines.slice(0, 2)).toEqual(['---', `name: darkmechanicus-${item.name}`])
        expect(lines.slice(3, 5)).toEqual(['---', ''])
        expect(readDescription(lines[2] ?? '')).toBe(item.description.replace(/\s+/g, ' ').trim())
        expect(lines.slice(5).join('\n')).toBe(item.body)
      }
    })
  })
})
