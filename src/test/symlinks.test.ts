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

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('canCreateFileSymlinks', () => {
  it('is true where the probe can create a file symlink', async () => {
    vi.stubEnv('CI', '')
    const available = await loadWith(() => undefined)

    expect(available()).toBe(true)
  })

  it('is false where the probe gets EPERM, as on a Windows account without symlink rights', async () => {
    vi.stubEnv('CI', '')
    const denied = await loadWith(eperm)

    expect(denied()).toBe(false)
  })

  it('is true under CI even where the probe gets EPERM, so the file symlink cases run and fail there rather than skip', async () => {
    vi.stubEnv('CI', 'true')
    const denied = await loadWith(eperm)

    expect(denied()).toBe(true)
  })

  it('probes once and caches the answer', async () => {
    vi.stubEnv('CI', '')
    const symlink = vi.fn(eperm)
    const can = await loadWith(symlink)

    expect([can(), can(), can()]).toEqual([false, false, false])
    expect(symlink).toHaveBeenCalledTimes(1)
  })
})
