import { describe, expect, it, vi } from 'vitest'

vi.mock('app-builder-lib/out/toolsets/windows.js', () => ({
  getMakeNsisPath: vi.fn(async () => { throw new Error('download refused') })
}))

describe('prepareInstallerToolchain', () => {
  it('fails clearly when the pinned NSIS toolchain is genuinely unavailable', async () => {
    const { prepareInstallerToolchain } = await import('./prepareInstallerTests.mjs')
    await expect(prepareInstallerToolchain()).rejects.toThrow(/Pinned NSIS toolchain unavailable: .*download refused/)
  })
})
