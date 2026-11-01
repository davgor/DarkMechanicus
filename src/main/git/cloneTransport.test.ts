/**
 * The second line behind the URL check: git runs clones with `GIT_ALLOW_PROTOCOL=https:ssh`, so a URL that passes the
 * check cannot reach another transport through the person's config (`url.<base>.insteadOf`, `protocol.<name>.allow`).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneRig } from '../../test/cloneRig'
import { bareRepo } from '../../test/gitRemotes'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { GitError } from './errors'

const cleanups: Array<() => void> = []
let home = ''

/** A global config that rewrites two https hosts: one to an `ext::` command that leaves a marker, one to a local path. */
function rewritingConfig(marker: string, bare: string): void {
  const config = join(home, 'gitconfig')
  writeFileSync(
    config,
    [
      '[protocol "ext"]',
      '\tallow = always',
      `[url "ext::sh -c touch% ${marker}% #"]`,
      '\tinsteadOf = https://evil.example/',
      `[url "${bare.replace(/\\/g, '/')}"]`,
      '\tinsteadOf = https://local.example/repo',
      ''
    ].join('\n')
  )
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
}

beforeEach(() => {
  const dir = scratchDir('dm-clone-transport-')
  cleanups.push(dir.cleanup)
  home = dir.path
})

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

describe('GIT_ALLOW_PROTOCOL behind the URL check', () => {
  it('stops an insteadOf rewrite to ext:: or to a local path, even with protocol.ext.allow=always', async () => {
    const marker = join(home, 'ext-ran')
    rewritingConfig(marker, bareRepo(cleanups))
    const r = cloneRig(cleanups, { allowFile: false })
    await r.cloner.chooseParent()
    const ext = await r.cloner.clone({ operationId: 'a', url: 'https://evil.example/x', name: 'a' }).catch((caught: unknown) => caught)
    expect(ext).toBeInstanceOf(GitError)
    expect((ext as GitError).detail).toContain("transport 'ext' not allowed")
    expect(existsSync(marker)).toBe(false)
    const local = await r.cloner.clone({ operationId: 'b', url: 'https://local.example/repo', name: 'b' }).catch((caught: unknown) => caught)
    expect((local as GitError).detail).toContain("transport 'file' not allowed")
    expect(r.tracked).toEqual([])
    expect(existsSync(join(r.parent, 'a'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('without it, the same config would run the ext:: command (the control for the test above)', () => {
    const marker = join(home, 'ext-ran')
    rewritingConfig(marker, bareRepo(cleanups))
    expect(() => gitIn(home, 'ls-remote', 'https://evil.example/x')).toThrow()
    expect(existsSync(marker)).toBe(true)
  })
})
