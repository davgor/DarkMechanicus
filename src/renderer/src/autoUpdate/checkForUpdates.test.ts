import { describe, expect, it, vi } from 'vitest'
import { requestCheckForUpdates } from './checkForUpdates'

describe('requestCheckForUpdates', () => {
  it('invokes the preload checkForUpdates API', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue(undefined)
    await requestCheckForUpdates(checkForUpdates)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
