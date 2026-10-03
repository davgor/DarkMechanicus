import { describe, expect, it } from 'vitest'
import { affectsRelease, parseChangedPaths } from './release-paths.mjs'

describe('affectsRelease', () => {
  it('releases for app source, bundled skills, icons and build inputs', () => {
    expect(affectsRelease(['src/main/index.ts'])).toBe(true)
    expect(affectsRelease(['skills/worker.md'])).toBe(true)
    expect(affectsRelease(['build/icon.ico'])).toBe(true)
    expect(affectsRelease(['package.json'])).toBe(true)
    expect(affectsRelease(['package-lock.json'])).toBe(true)
    expect(affectsRelease(['electron.vite.config.ts'])).toBe(true)
    expect(affectsRelease(['tsconfig.web.json'])).toBe(true)
  })

  it('does not release for repository history, docs, agent config or CI-only changes', () => {
    expect(
      affectsRelease([
        '.darkmechanicus/epics/ep_01m418epbg8qkqa2e2krvdkqk5/current.json',
        'docs/runbooks/agents.md',
        'README.md',
        '.claude/skills/delivery-standards/SKILL.md',
        '.cursor/skills/delivery-standards/SKILL.md',
        '.github/workflows/deploy.yml',
        '.mcp.json',
        'scripts/release-paths.mjs',
        'fireguard/src/index.ts',
        'vitest.config.ts'
      ])
    ).toBe(false)
  })

  it('releases when any one changed path reaches the app', () => {
    expect(affectsRelease(['docs/product-plan.md', 'src/core/ids.ts'])).toBe(true)
  })

  it('matches whole path segments, not prefixes', () => {
    expect(affectsRelease(['srcs/notes.md', 'skills-archive/old.md', 'package.json.bak'])).toBe(false)
  })

  it('does not release when nothing changed', () => {
    expect(affectsRelease([])).toBe(false)
  })
})

describe('parseChangedPaths', () => {
  it('splits git diff --name-only output, ignoring blank lines and CRLF', () => {
    expect(parseChangedPaths('src/a.ts\r\n\r\ndocs/b.md\n')).toEqual(['src/a.ts', 'docs/b.md'])
  })
})
