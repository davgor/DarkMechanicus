import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const deployYml = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')

/** Slice the `release:` job block (until EOF — it is the last job). */
function releaseJobSource(yml) {
  const normalized = yml.replace(/\r\n/g, '\n')
  const marker = /\n {2}release:\n/
  const match = marker.exec(normalized)
  if (!match) {
    throw new Error('deploy.yml: could not find top-level release job')
  }
  return normalized.slice(match.index)
}

describe('releaseJobSource', () => {
  it('finds the release job when the workflow uses CRLF line endings', () => {
    const crlf = [
      'jobs:',
      '  prepare:',
      '    runs-on: ubuntu-latest',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      ''
    ].join('\r\n')

    expect(releaseJobSource(crlf)).toContain('  release:\n')
    expect(releaseJobSource(crlf)).toContain('actions/checkout@v4')
  })
})

describe('deploy.yml release job', () => {
  const release = releaseJobSource(deployYml)

  it('checks out the prepare SHA before creating the GitHub Release', () => {
    expect(release).toMatch(/uses:\s*actions\/checkout@v4/)
    expect(release).toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.sha\s*\}\}/)
    expect(release).toMatch(/fetch-depth:\s*0/)
  })

  it('passes --repo so gh does not depend on an ambient git remote', () => {
    expect(release).toMatch(
      /gh release create[\s\S]*--repo\s+"\$\{\{\s*github\.repository\s*\}\}"/
    )
  })
})
