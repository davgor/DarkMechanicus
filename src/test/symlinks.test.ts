import { afterEach, describe, expect, it, vi } from 'vitest'

type Symlink = typeof import('node:fs').symlinkSync

/** Loads a fresh copy of the probe, with `symlinkSync` replaced by `symlink` (a fake that succeeds or throws). */
async function loadWith(symlink: Symlink): Promise<() => boolean> {
  vi.resetModules()
  vi.doMock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), symlinkSync: symlink }))
  const module = await import('./symlinks')
  return module.canCreateFileSymlinks
}

const eperm: Symlink = () => {
  throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
}

/** A refusing `symlinkSync` that counts its calls, so a test can see how often the probe ran. */
function countedEperm(): { symlink: Symlink; calls: () => number } {
  let calls = 0
  return {
    symlink: (...args) => {
      calls += 1
      return eperm(...args)
    },
    calls: () => calls
  }
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('canCreateFileSymlinks', () => {
  it('is true where the probe can create a file symlink', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const available = await loadWith(() => undefined)

    expect(available()).toBe(true)
  })

  it('is false where the probe gets EPERM, as on a Windows account without symlink rights', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const denied = await loadWith(eperm)

    expect(denied()).toBe(false)
  })

  it('is true on GitHub Actions even where the probe gets EPERM, so the file symlink cases run and fail there rather than skip', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const denied = await loadWith(eperm)

    expect(denied()).toBe(true)
  })

  it('still probes where only CI=true is set, as an agent shell on a machine without symlink rights exports it', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    vi.stubEnv('CI', 'true')
    const probe = countedEperm()
    const denied = await loadWith(probe.symlink)

    expect(denied()).toBe(false)
    expect(probe.calls()).toBe(1)
  })

  it('probes once and caches the answer', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    const probe = countedEperm()
    const can = await loadWith(probe.symlink)

    expect([can(), can(), can()]).toEqual([false, false, false])
    expect(probe.calls()).toBe(1)
  })
})
