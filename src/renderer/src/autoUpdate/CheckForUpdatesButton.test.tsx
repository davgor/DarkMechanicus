import { describe, expect, it, vi } from 'vitest'
import { CheckForUpdatesButton } from './CheckForUpdatesButton'

describe('CheckForUpdatesButton', () => {
  it('renders a check-for-updates control', () => {
    const node = CheckForUpdatesButton({})
    expect(node.props.type).toBe('button')
    expect(node.props.className).toBe('settings-check-updates')
    expect(node.props.children).toBe('Check for updates')
    expect(node.props.disabled).toBeUndefined()
  })

  it('calls window.autoUpdate.checkForUpdates on click', () => {
    const checkForUpdates = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      autoUpdate: { checkForUpdates }
    })

    const node = CheckForUpdatesButton({})
    node.props.onClick()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })
})
